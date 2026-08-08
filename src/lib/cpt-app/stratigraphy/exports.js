// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Exports of the derived stratigraphy. All builders are pure — they take the
// store's derived view model and return { filename, mime, text } — so they
// run unchanged in the Node verification scripts.
//
//   - Units CSV        full aggregate table + presence matrix (audit trail)
//   - PLAXIS 2D        soilmat command per unit (Mohr-Coulomb + Hardening
//                      Soil), same command grammar as the per-CPT export
//   - Section DXF      unit polygons in (chainage, m TAW) as closed
//                      LWPOLYLINEs — imports directly as PLAXIS 2D polygons
//
// The SCIA SOILIN deliverable is a printable report, not a flat file — see
// soilin-report.js and the /report/soilin route.

import { exportRegionsToDxf } from '../dxf-regions.js';

function safeToken(value) {
  let txt = String(value ?? '').trim();
  if (txt.normalize) txt = txt.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  txt = txt.replace(/[(),]/g, '').replace(/\s+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '');
  return txt || 'Unit';
}

function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (cells) => cells.map(csvCell).join(',');
const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '' : (+v).toFixed(d));
const msToMday = (v) => (Number.isFinite(v) ? +(v * 86400).toFixed(6) : 0);

/* Same drainage convention as the per-CPT PLAXIS export. */
export function drainageType(unit) {
  const sub = (unit.subtype || '').toLowerCase();
  if (sub.includes('(lh)') || sub.includes('(kh)') || sub.includes('leemhoudend') || sub.includes('klei-/leemhoudend')) {
    return 'Undrained A';
  }
  return unit.type === 'Sand' || unit.type === 'Gravel' ? 'Drained' : 'Undrained A';
}

// ── Units CSV ─────────────────────────────────────────────────────────────

export function buildUnitsCsv(derived, projectName = 'project') {
  const lines = [];
  lines.push(
    csvLine([
      'Unit',
      'Name',
      'Type',
      'Subtype',
      'Members',
      'Top_TAW_max',
      'Bot_TAW_min',
      'Thk_wmean_m',
      'Thk_min_m',
      'Thk_max_m',
      'qc_wmean_MPa',
      'qc_min',
      'qc_max',
      'Rf_wmean_pct',
      'gamma_kNm3',
      'gamma_sat_kNm3',
      'phi_char_deg',
      'phi_min',
      'phi_max',
      'c_char_kPa',
      'c_min',
      'c_max',
      'cu_char_kPa',
      'cu_min',
      'cu_max',
      'Eoed_ref_kPa',
      'E50_ref_kPa',
      'Eur_ref_kPa',
      'E_mc_kPa',
      'Edef_kPa',
      'nu',
      'm',
      'kh_ms',
      'kv_ms',
      'Characteristic'
    ])
  );
  derived.units.forEach((u) => {
    const p = u.params;
    lines.push(
      csvLine([
        u.letter,
        u.name,
        u.type,
        u.subtype,
        u.members.length,
        fmt(u.agg.topTaw.max),
        fmt(u.agg.botTaw.min),
        fmt(u.agg.thk.wmean),
        fmt(u.agg.thk.min),
        fmt(u.agg.thk.max),
        fmt(u.agg.qc.wmean),
        fmt(u.agg.qc.min),
        fmt(u.agg.qc.max),
        fmt(u.agg.rf.wmean),
        fmt(u.characteristic.g, 1),
        fmt(u.characteristic.gs, 1),
        fmt(u.characteristic.phi, 1),
        fmt(u.agg.phi.min, 1),
        fmt(u.agg.phi.max, 1),
        fmt(u.characteristic.c, 1),
        fmt(u.agg.c.min, 1),
        fmt(u.agg.c.max, 1),
        fmt(u.characteristic.cu, 1),
        fmt(u.agg.cu.min, 1),
        fmt(u.agg.cu.max, 1),
        p ? fmt(p.Eoed_ref.wmean, 0) : '',
        p ? fmt(p.E50_ref.wmean, 0) : '',
        p ? fmt(p.Eur_ref.wmean, 0) : '',
        p ? fmt(p.Emc.wmean, 0) : '',
        p ? fmt(p.Edef.wmean, 0) : '',
        p ? fmt(p.nu.wmean, 2) : '',
        p ? fmt(p.m, 2) : '',
        p && p.kh != null ? p.kh.toExponential(2) : '',
        p && p.kv != null ? p.kv.toExponential(2) : '',
        derived.settings.characteristic
      ])
    );
  });

  // Presence matrix: where each unit was sampled, in m TAW.
  lines.push('');
  lines.push(csvLine(['Unit', ...derived.profiles.cpts.map((c) => c.id)]));
  derived.units.forEach((u) => {
    const byCpt = new Map();
    u.members.forEach((m) => {
      const layer = derived.profiles.cpts
        .find((c) => c.cptIdx === m.cptIdx)
        ?.layers.find((l) => l.layerIdx === m.layerIdx);
      if (!layer) return;
      const cur = byCpt.get(m.cptIdx) || { top: -Infinity, bot: Infinity };
      cur.top = Math.max(cur.top, layer.topTaw);
      cur.bot = Math.min(cur.bot, layer.botTaw);
      byCpt.set(m.cptIdx, cur);
    });
    lines.push(
      csvLine([
        u.letter,
        ...derived.profiles.cpts.map((c) => {
          const span = byCpt.get(c.cptIdx);
          return span ? `${span.top.toFixed(2)} / ${span.bot.toFixed(2)}` : '—';
        })
      ])
    );
  });

  return {
    filename: `${safeToken(projectName)}_stratigrafie_eenheden.csv`,
    mime: 'text/csv',
    text: lines.join('\n')
  };
}

// ── PLAXIS 2D materials ───────────────────────────────────────────────────

function plaxisValue(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '0';
    return Object.is(value, -0) ? '0' : String(value);
  }
  return `"${String(value ?? '').replace(/"/g, "'").replace(/\r?\n/g, ' ').trim()}"`;
}

const soilmat = (pairs) => `soilmat ${pairs.map(([k, v]) => `${plaxisValue(k)} ${plaxisValue(v)}`).join(' ')}`;

export function buildPlaxisUnitCommands(derived, projectName = 'project') {
  const commands = [];
  const notes = [];
  derived.units.forEach((u) => {
    if (!u.params) {
      notes.push(`Eenheid ${u.name}: geen Stage 4 parameters beschikbaar — overgeslagen.`);
      return;
    }
    const p = u.params;
    const base = `UNIT_${safeToken(u.letter)}_${safeToken(u.subtype || u.type)}`;
    const dr = drainageType(u);
    const khMday = msToMday(p.kh);
    const kvMday = msToMday(p.kv);
    const cohesion = Math.max(u.characteristic.c ?? 0, 0.1);
    const psi = Math.round(p.psi.wmean ?? 0);

    commands.push(
      soilmat([
        ['Identification', `${base}_MC`],
        ['SoilModel', 2],
        ['DrainageType', dr],
        ['gammaUnsat', u.characteristic.g],
        ['gammaSat', u.characteristic.gs],
        ['ERef', Math.round(p.Emc.wmean)],
        ['nu', +p.nu.wmean.toFixed(2)],
        ['cRef', +cohesion.toFixed(1)],
        ['phi', +(u.characteristic.phi ?? 0).toFixed(1)],
        ['psi', psi],
        ['PermHorizontalPrimary', khMday],
        ['PermVertical', kvMday]
      ]),
      soilmat([
        ['Identification', `${base}_HS`],
        ['SoilModel', 3],
        ['DrainageType', dr],
        ['gammaUnsat', u.characteristic.g],
        ['gammaSat', u.characteristic.gs],
        ['E50Ref', Math.round(p.E50_ref.wmean)],
        ['EOedRef', Math.round(p.Eoed_ref.wmean)],
        ['EURRef', Math.round(p.Eur_ref.wmean)],
        ['PowerM', p.m],
        ['pRef', 100],
        ['cRef', +cohesion.toFixed(1)],
        ['phi', +(u.characteristic.phi ?? 0).toFixed(1)],
        ['psi', psi],
        ['PermHorizontalPrimary', khMday],
        ['PermVertical', kvMday]
      ])
    );
  });

  const header = [
    `# MADEP stratigrafie — PLAXIS 2D materiaalcommando's per grondeenheid`,
    `# Parameters: dikte-gewogen gemiddelden over de deelnemende CPT-lagen;`,
    `# sterkte volgens karakteristieke keuze "${derived.settings.characteristic}".`,
    ...notes.map((n) => `# ${n}`),
    ''
  ];
  return {
    filename: `${safeToken(projectName)}_stratigrafie_plaxis_materials.txt`,
    mime: 'text/plain',
    text: header.concat(commands).join('\r\n')
  };
}

// ── Section DXF (PLAXIS 2D geometry) ──────────────────────────────────────

export function buildSectionDxf(derived, projectName = 'project') {
  const regions = derived.polygons.map((poly) => ({
    polygon: poly.points.map((p) => ({ x: p.dist, y: p.taw })),
    material: { id: poly.unitId, label: `UNIT_${poly.name}` }
  }));
  const text = exportRegionsToDxf(regions, {
    title: `MADEP stratigrafie doorsnede (${projectName}) - X: meetlijn-afstand (m), Y: m TAW - PLAXIS 2D: importeer als polygonen, schaal 1.0`
  });
  return {
    filename: `${safeToken(projectName)}_stratigrafie_doorsnede.dxf`,
    mime: 'application/dxf',
    text
  };
}
