// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// beam/options.js — the wording of the beam / slab-on-Winkler app: <option> lists, help texts, the
// per-direction axis copy and the EC2 exposure-class list (01-monolith-map.md §2.6/§2.9 "option/help
// text builders", §6.1 row `beam/`, refactor step 7 / PR 12c).
//
// Moved verbatim out of legacy-controller.js (integration-r @ 07f0645 line numbers), renamed to drop the prefix:
//   stage6BeamUlsOptions         9255-9261 → ulsOptions
//   stage6BeamUlsHelp            9263-9268 → ulsHelp
//   stage6BeamLoadPatternHelp    9270-9278 → loadPatternHelp
//   stage6BeamModelModeOptions   9280-9289 → modelModeOptions
//   stage6BeamModelModeLabel     9291-9298 → modelModeLabel
//   stage6BeamAxisCopy           9300-9341 → beamAxisCopy (a local `axisCopy` holds its result in panel.js / geometry-preview.js)
//   stage6BeamMomentContextHelp  9343-9349 → momentContextHelp
//   stage6ExposureOptions        9364-9368 → exposureOptions
//   stage6ExposureHelp           9370-9373 → exposureHelp
//
// Pure text builders. The Eurocode use-category / SLS-combination wording of the load accordion is
// shared with the settlement app and lives in settlement/options.js (beam/panel.js imports it from
// there). EC2_EXPOSURE_META is the exposure-class table of stage6-engineering.js.
// modelModeLabel has no caller in the app today (kept with the other wording).
import { EC2_EXPOSURE_META } from '../stage6-engineering.js';

export function ulsOptions(selected){
  const labels = {
    A1:'A1 - Eq. 6.10, ordinary building gravity default',
    A2:'A2 - alternative action set'
  };
  return ['A1','A2'].map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`).join('');
}

export function ulsHelp(selected){
  if(selected === 'A2'){
    return 'A2 is an alternative action set. For ordinary Belgian building gravity loading in this beam/slab screening tool, A1 is usually the safer and more standard starting point.';
  }
  return 'A1 is the recommended default here for ordinary Belgian building loading when deriving the ULS beam moment for reinforcement.';
}

export function loadPatternHelp(selected){
  const text = {
    uniform_full:'Uniform full length applies the same line load along the whole x direction. For a long uniform strip this is effectively the infinite/uniform case: settlement is meaningful, while longitudinal bending can legitimately be almost zero.',
    uniform_patch:'Uniform patch applies a line load only between patch start x and patch end x. Use it for a loaded slab bay, machine strip, wall contact width in transverse footing mode, or any local zone that should create bending along x.',
    point_centre:'Point load at centre is a localised strip/beam check. Use it for a concentrated reaction or local heavy point action applied at midspan.',
    point_at_x:'Point load at x is the same localised check, but at a chosen position along the strip so you can inspect edge-near or eccentric loading.'
  };
  return text[selected] || text.uniform_full;
}

export function modelModeOptions(selected){
  const labels = {
    slab_strip:'x = slab strip direction',
    beam_length:'x = along wall / beam length',
    footing_transverse:'x = across footing width'
  };
  return ['slab_strip','beam_length','footing_transverse']
    .map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`)
    .join('');
}

export function modelModeLabel(selected){
  const labels = {
    slab_strip:'1 m slab strip',
    beam_length:'Along wall / beam length',
    footing_transverse:'Across footing width'
  };
  return labels[selected] || labels.slab_strip;
}

export function beamAxisCopy(selected){
  const mode = ['slab_strip','beam_length','footing_transverse'].includes(selected) ? selected : 'slab_strip';
  const copy = {
    slab_strip: {
      prompt: '1D bending is solved only along x. For a slab strip, x is the checked slab direction and b is normally 1.00 m.',
      summary: 'x = checked slab strip direction',
      canvasMode: 'x: slab strip direction, b: unit strip width',
      LLabel: 'Analysis length L along slab x (m)',
      LTip: 'L is the in-plan length of the checked slab strip in the x direction.',
      bLabel: 'Strip width b along y (m)',
      bTip: 'b is the strip width perpendicular to x. Keep b = 1.00 m when you want kNm/m and mm2/m output.',
      BLabel: 'Bearing width B for k_s (m)',
      BTip: 'B is the characteristic contact width used only to derive k_s from the CPT stiffness profile. For slab-strip screening it is the width you want the Vesić support conversion to represent.',
      hLabel: 'Slab thickness h along z (m)'
    },
    beam_length: {
      prompt: '1D bending is solved only along x. Here x runs along the wall or beam; local patch or point loads create the useful bending case.',
      summary: 'x = foundation / wall run',
      canvasMode: 'x: wall/beam run, b: contact width',
      LLabel: 'Run length L along wall / beam x (m)',
      LTip: 'L is the length along the wall, strip, or beam run. A full-length uniform load mainly checks settlement; patch or point loads create local bending along this run.',
      bLabel: 'Contact width b across the run (m)',
      bTip: 'b is the physical strip/contact width perpendicular to the wall or beam run. It is used in I = b*h^3/12, k_s*b, and the reinforcement width b_w.',
      BLabel: 'Bearing width B for k_s (m)',
      BTip: 'B is the real bearing/contact width used in the subgrade-reaction calculation. For a beam along its length this often equals the physical contact width b, but it is entered separately so you can audit the assumption.',
      hLabel: 'Section height h along z (m)'
    },
    footing_transverse: {
      prompt: '1D bending is solved only along x. Here x runs across the footing width; b is the out-of-plane slice along the wall, often 1.00 m.',
      summary: 'x = transverse footing width',
      canvasMode: 'x: across footing width, b: slice along wall',
      LLabel: 'Footing width L across wall x (m)',
      LTip: 'L is the footing width across the wall or line load. Use this mode when the ordinary strip-footing bending check is transverse rather than along the wall length.',
      bLabel: 'Out-of-plane strip width b along wall (m)',
      bTip: 'b is the model slice width along the wall. Use b = 1.00 m for a conventional per-meter strip-footing check.',
      BLabel: 'Bearing width B for k_s (m)',
      BTip: 'B is the support width used in the k_s derivation. In transverse strip-footing mode this normally matches the footing width across the wall.',
      hLabel: 'Footing height h along z (m)'
    }
  };
  return copy[mode];
}

export function momentContextHelp(cfg){
  const pattern = cfg.loadPattern || 'uniform_full';
  if(pattern === 'uniform_full'){
    return 'Full-length uniform loading is mainly a settlement case in this 1D model; longitudinal bending can be near zero because soil reaction balances the load almost uniformly.';
  }
  return 'Patch and point loads make the strip redistribute load into the soil. Increasing h raises EI, so M_Ed can increase even while deflection drops.';
}

export function exposureOptions(selected){
  return Object.entries(EC2_EXPOSURE_META)
    .map(([key, meta])=>`<option value="${key}"${selected===key?' selected':''}>${key} - ${meta.label}</option>`)
    .join('');
}

export function exposureHelp(selected){
  const meta = EC2_EXPOSURE_META[selected] || EC2_EXPOSURE_META.XC2;
  return meta.hint;
}
