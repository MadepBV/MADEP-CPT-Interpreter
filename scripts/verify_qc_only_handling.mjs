#!/usr/bin/env node
// Verification of the qc-only (missing fs/Rf) classification contract.
//
// Contract under test (classification-core.js + eurocode-tabel3.js):
//   1. EXPLICIT ASSUMPTION — a reading without measured Rf classifies exactly
//      as the same reading with rf set to the assumed Rf, for all 5 methods.
//      (No hidden defaults, no method silently skipping the assumption.)
//   2. MEASURED DATA WINS — when rf (or fs) is measured, the assumed Rf has
//      no influence whatsoever.
//   3. TABEL 3 NO LONGER FALLS THROUGH — qc-only readings are classified via
//      the real table at the assumed Rf instead of landing wholesale on the
//      loose-sand fallback.
//   4. GOLDEN PINS — regression values for the extracted classifier math,
//      matching the pre-extraction in-controller implementations.
//   5. PLAXIS SIMULATED fs — never 0 for a real layer without fs/Rf; falls
//      back to a representative per-type Rf so the layering survives the
//      PLAXIS CPT interpretation.
//   6. TABLE INTEGRITY — the extracted Tabel 3 catalogue is complete and the
//      matcher keeps its boundary rules.

import {
	DEFAULT_ASSUMED_RF,
	SIMULATED_RF_BY_TYPE,
	classifyCUR3,
	classifyNEN6740,
	classifyRobertson1990,
	classifyRobertson2016,
	classifyTabel3,
	normalizeAssumedRf,
	simulatedLayerFsValue
} from '../src/lib/cpt-app/classification-core.js';
import { CAT, EUROCODE_CLASS_ENTRIES, eurocodeEntryMatches } from '../src/lib/cpt-app/eurocode-tabel3.js';

const failures = [];
function check(label, condition, detail = ''){
	if(!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

/* Stage-2 stress state — mirrors stressAt(z, 18, 17) with wt = 1.7 m
   (the classification wrappers in legacy-controller.js). */
function stress(z, wt = 1.7){
	const gu = 17, gs = 18;
	const sigV = z <= wt ? gu * z : gu * wt + gs * (z - wt);
	const u = z > wt ? 9.81 * (z - wt) : 0;
	return { sigV: +sigV.toFixed(2), sigVeff: Math.max(sigV - u, 1) };
}

function ctx(z, assumedRf = DEFAULT_ASSUMED_RF){
	return { ...stress(z), aRatio: 0.8, assumedRf };
}

const METHODS = [
	['Robertson 1990', (r, z, aRf) => classifyRobertson1990(r, ctx(z, aRf))],
	['Robertson 2016', (r, z, aRf) => classifyRobertson2016(r, ctx(z, aRf))],
	['CUR3',           (r, _z, aRf) => classifyCUR3(r, { assumedRf: aRf })],
	['NEN 6740',       (r, z, aRf) => classifyNEN6740(r, { sigVeff: stress(z).sigVeff, assumedRf: aRf })],
	['Tabel 3',        (r, _z, aRf) => classifyTabel3(r, { assumedRf: aRf })]
];

/* ── 1. Explicit assumption: rf:null + assumedRf x ≡ rf:x ─────────────── */
const qcGrid = [0.1, 0.3, 0.6, 0.9, 1.4, 2.2, 3.5, 5, 8, 12, 16, 20, 28];
const zGrid = [0.5, 1.5, 3, 6, 10, 18];
const assumedGrid = [0.7, 1.5, 3.0, 4.5, 7.0];

for(const [name, run] of METHODS){
	for(const z of zGrid){
		for(const qc of qcGrid){
			for(const aRf of assumedGrid){
				const missing = run({ z, qc, fs: null, rf: null, u2: null }, z, aRf);
				const explicit = run({ z, qc, fs: null, rf: aRf, u2: null }, z, 9.99);
				check(
					`[1] ${name} assumption equivalence`,
					JSON.stringify(missing) === JSON.stringify(explicit),
					`z=${z} qc=${qc} assumedRf=${aRf}: ${missing.type}/${missing.subtype} vs ${explicit.type}/${explicit.subtype}`
				);
			}
		}
	}
}

/* ── 2. Measured data wins: assumedRf must not leak into measured rows ── */
for(const [name, run] of METHODS){
	for(const qc of [0.8, 4, 15]){
		const withRf = (aRf) => run({ z: 5, qc, fs: null, rf: 1.2, u2: null }, 5, aRf);
		check(`[2] ${name} measured rf immune to assumedRf`,
			JSON.stringify(withRf(0.5)) === JSON.stringify(withRf(8)), `qc=${qc}`);
	}
	const withFs = (aRf) => run({ z: 5, qc: 4, fs: 0.05, rf: 1.25, u2: null }, 5, aRf);
	check(`[2] ${name} measured fs immune to assumedRf`,
		JSON.stringify(withFs(0.5)) === JSON.stringify(withFs(8)));
}

/* ── 3. Tabel 3 classifies qc-only readings via the table ─────────────── */
{
	// Clay-like reading: qc 0.9 MPa, assumed Rf 5 → a klei row, NOT 'zand, los'.
	// (At Rf 4 the leem band 2–4 legitimately matches first in table order.)
	const clayish = classifyTabel3({ qc: 0.9, fs: null, rf: null }, { assumedRf: 5 });
	check('[3] Tabel 3 qc-only clay-like → klei row', clayish.type === 'Clay', `got ${clayish.type}/${clayish.subtype}`);
	check('[3] Tabel 3 qc-only clay-like not loose-sand fallback', clayish.subtype !== 'zand, los', `got ${clayish.subtype}`);

	// Loam-like reading: qc 0.9, assumed Rf 4 → the leem band (table order: leem before klei)
	const loamish = classifyTabel3({ qc: 0.9, fs: null, rf: null }, { assumedRf: 4 });
	check('[3] Tabel 3 qc-only Rf=4 → leem band before klei', loamish.subtype.startsWith('leem'), `got ${loamish.type}/${loamish.subtype}`);

	// Sand-like reading: qc 6, assumed Rf 0.7 → a zand row
	const sandish = classifyTabel3({ qc: 6, fs: null, rf: null }, { assumedRf: 0.7 });
	check('[3] Tabel 3 qc-only sand-like → zand row', sandish.type === 'Sand' && sandish.subtype.startsWith('zand'), `got ${sandish.type}/${sandish.subtype}`);

	// Very dense reading: qc 12, assumed Rf 0.7 → grind rows match first, exactly
	// as they would for a measured Rf 0.7 (table-order parity with real data).
	const gravelly = classifyTabel3({ qc: 12, fs: null, rf: null }, { assumedRf: 0.7 });
	check('[3] Tabel 3 qc-only qc=12 Rf=0.7 → grind (table order)', gravelly.type === 'Gravel', `got ${gravelly.type}/${gravelly.subtype}`);

	// At the default assumption the profile is NOT uniformly 'zand, los':
	const types = new Set(qcGrid.map(qc => classifyTabel3({ qc, fs: null, rf: null }, { assumedRf: 3 }).subtype));
	check('[3] Tabel 3 qc-only default produces >1 distinct subtype', types.size > 1, [...types].join(', '));
}

/* ── 4. Golden pins (pre-extraction in-controller math, wt=1.7) ───────── */
{
	const pin = (label, got, want) => check(`[4] ${label}`, got === want, `got ${got}, want ${want}`);

	// With measured Rf — unchanged classic behaviour:
	pin('R2016 sand body z=2.9 rf=0.7 → Sand',
		classifyRobertson2016({ z: 2.9, qc: 12.8, fs: 12.8 * 0.007, rf: 0.7, u2: null }, ctx(2.9)).type, 'Sand');
	pin('R2016 soft clay z=5.5 rf=4.5 → Clay',
		classifyRobertson2016({ z: 5.5, qc: 0.9, fs: 0.9 * 0.045, rf: 4.5, u2: null }, ctx(5.5)).type, 'Clay');
	pin('R1990 dense sand z=9.5 rf=0.6 → Sand',
		classifyRobertson1990({ z: 9.5, qc: 14.8, fs: 14.8 * 0.006, rf: 0.6, u2: null }, ctx(9.5)).type, 'Sand');
	pin('CUR3 rf=0.7 qc=12.8 → Sand', classifyCUR3({ qc: 12.8, rf: 0.7 }, {}).type, 'Sand');
	pin('CUR3 rf=4.5 qc=0.9 → Clay', classifyCUR3({ qc: 0.9, rf: 4.5 }, {}).type, 'Clay');
	pin('NEN6740 dense sand z=9.5 rf=0.6 → Sand',
		classifyNEN6740({ qc: 14.8, rf: 0.6 }, { sigVeff: stress(9.5).sigVeff }).type, 'Sand');

	// qc-only at the default assumption — documents the (now visible) substitution:
	pin('R2016 qc-only dense sand z=11.5 → Silty sand (assumed Rf=3)',
		classifyRobertson2016({ z: 11.5, qc: 20.5, fs: null, rf: null, u2: null }, ctx(11.5)).type, 'Silty sand');
	pin('CUR3 qc-only qc=12.8 → Clay (assumed Rf=3)',
		classifyCUR3({ qc: 12.8, fs: null, rf: null }, {}).type, 'Clay');

	// Robertson low-signal guard preserved (qc - σv/1000 < 0.01 MPa):
	pin('R1990 negligible dQ guard → Clay',
		classifyRobertson1990({ z: 1, qc: 0.005, fs: null, rf: null, u2: null }, ctx(1)).type, 'Clay');
}

/* ── 5. PLAXIS simulated fs ───────────────────────────────────────────── */
{
	check('[5] avgFs passthrough', simulatedLayerFsValue({ avgFs: 0.033, avgRf: 5, avgQc: 2, type: 'Clay' }) === 0.033);
	check('[5] avgRf branch', Math.abs(simulatedLayerFsValue({ avgFs: null, avgRf: 2, avgQc: 5, type: 'Sand' }) - 0.1) < 1e-12);
	for(const [type, rf] of Object.entries(SIMULATED_RF_BY_TYPE)){
		const fs = simulatedLayerFsValue({ avgFs: null, avgRf: null, avgQc: 5, type });
		check(`[5] synthetic fs > 0 for ${type}`, fs > 0, `got ${fs}`);
		check(`[5] synthetic fs uses type Rf for ${type}`, Math.abs(fs - 5 * rf / 100) < 1e-12, `got ${fs}`);
	}
	const unknown = simulatedLayerFsValue({ avgFs: null, avgRf: null, avgQc: 5, type: 'Unmapped' }, 2.5);
	check('[5] unknown type falls back to assumedRf', Math.abs(unknown - 5 * 2.5 / 100) < 1e-12, `got ${unknown}`);
	check('[5] zero-qc layer never negative', simulatedLayerFsValue({ avgFs: null, avgRf: null, avgQc: 0, type: 'Clay' }) === 0);
}

/* ── 6. Tabel 3 catalogue + matcher integrity ─────────────────────────── */
{
	check('[6] CAT has 31 entries', CAT.length === 31, `got ${CAT.length}`);
	check('[6] EUROCODE_CLASS_ENTRIES has 31 entries', EUROCODE_CLASS_ENTRIES.length === 31, `got ${EUROCODE_CLASS_ENTRIES.length}`);
	const grpOrder = [...new Set(EUROCODE_CLASS_ENTRIES.map(e => e.grp))];
	check('[6] table order grind→zand→leem→klei→veen',
		JSON.stringify(grpOrder) === JSON.stringify(['grind', 'zand', 'leem', 'klei', 'veen']), grpOrder.join('→'));
	for(const e of CAT){
		check(`[6] entry ${e.subtype} numeric fields`,
			[e.g, e.gs, e.phi, e.c, e.cu, e.qcMin, e.qcMax, e.rfMin, e.rfMax].every(Number.isFinite));
	}
	// Matcher boundary rules:
	const cleanSand = CAT.find(e => e.subtype === 'zand, los');
	check('[6] clean-sand Rf<1 exclusive', eurocodeEntryMatches(cleanSand, 3, 0.99) && !eurocodeEntryMatches(cleanSand, 3, 1.0));
	const veen = CAT.find(e => e.grp === 'veen');
	check('[6] veen hard gate Rf>6', !eurocodeEntryMatches(veen, 0.3, 6.0) && eurocodeEntryMatches(veen, 0.3, 6.1));
	check('[6] matcher rejects rf=null (defensive)', eurocodeEntryMatches(cleanSand, 3, null) === false);
}

/* ── 7. normalizeAssumedRf clamps ─────────────────────────────────────── */
{
	check('[7] default on garbage', normalizeAssumedRf('x') === DEFAULT_ASSUMED_RF && normalizeAssumedRf(-2) === DEFAULT_ASSUMED_RF && normalizeAssumedRf(null) === DEFAULT_ASSUMED_RF);
	check('[7] clamp low', normalizeAssumedRf(0.01) === 0.1);
	check('[7] clamp high', normalizeAssumedRf(50) === 10);
	check('[7] passthrough', normalizeAssumedRf(2.4) === 2.4);
}

if(failures.length){
	console.error(`qc-only handling verification FAILED (${failures.length}):`);
	for(const f of failures.slice(0, 40)) console.error('  ✗ ' + f);
	if(failures.length > 40) console.error(`  … and ${failures.length - 40} more`);
	process.exit(1);
}
console.log('qc-only handling verification passed:');
console.log('  [1] rf:null + assumed Rf ≡ rf:assumed for all 5 methods (2340 combinations)');
console.log('  [2] measured fs/Rf immune to the assumption');
console.log('  [3] Tabel 3 classifies qc-only readings via the table (no loose-sand fall-through)');
console.log('  [4] golden pins match the pre-extraction classifier math');
console.log('  [5] PLAXIS simulated fs is layering-preserving (never 0 for typed layers)');
console.log('  [6] Tabel 3 catalogue integrity + matcher boundary rules');
console.log('  [7] assumed-Rf normalization clamps');
