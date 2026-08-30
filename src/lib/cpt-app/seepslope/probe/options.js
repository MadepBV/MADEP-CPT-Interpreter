// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/probe/options.js — what the line probe can plot per workspace, and how one sampled
// value is written out. Refactor step 9d (01-monolith-map.md §2.11 group "Geometry, picking, line
// probe", §6.1 row `seepslope/` `geometry/line-probe.js`; PLAN §2 row 18d). Moved verbatim from
// legacy-controller.js (integration-r 4974167):
//
//   stage6BishopLineProbeOptions 5280-5339      → lineProbeOptions(workspace, type, hasHs, env)
//   stage6BishopLineProbeMeta 5341-5344         → lineProbeMeta(workspace, quantity, type, hasHs, env)
//   stage6BishopLineProbeFormatValue 5346-5350  → lineProbeFormatValue
//
// No `S`, no DOM of its own: the eight seepage quantities are a literal, and the colours come from
// `core/css-tokens.js readCssToken`, which falls back to the light palette without a document
// (the same import `run/progress.js` makes for `compactNumber`).
//
// The deformation list is the deformation-contour catalogue, which still lives in the controller
// (map §2.11 group "Deformation contours" — its own extraction step). It is handed in as `env`,
// so the package neither duplicates the 24 quantity metas nor reaches for a global:
//
//   env.normalizedDeformationAnalysisType(analysisType) → 'deformation' | 'safety-cphi'
//   env.deformationContourOptions(analysisType, hasHs)  → [{id, label}]
//   env.deformationContourMeta(id, analysisType)        → {label, axisTitle, unit, digits, …}
//
// `env` is only read in the deformation branch; the seepage and stability branches are pure.
import { compactNumber } from '../../core/format.js';
import { readCssToken } from '../../core/css-tokens.js';

/**
 * The quantities the measured line can plot in `workspace`, in menu order. `[]` for the
 * stability workspace — the probe is a seepage / deformation tool.
 */
export function lineProbeOptions(workspace, analysisType = null, hasHs = false, env = {}){
  const chartBlue = readCssToken('--chart-blue', '#4F8584');
  const chartGreen = readCssToken('--chart-green', '#3D6B6A');
  const chartOrange = readCssToken('--chart-orange', '#8A620D');
  const chartRed = readCssToken('--chart-red', '#9B3A32');
  const chartPurple = readCssToken('--chart-purple', '#18181A');
  if(workspace === 'seepage'){
    return [
      {id:'head', label:'h', axisTitle:'Head h (m)', unit:'m', color:chartBlue, digits:3},
      {id:'porePressure', label:'u', axisTitle:'Pore pressure u (kPa)', unit:'kPa', color:chartBlue, digits:3},
      {id:'gradient', label:'|∇h|', axisTitle:'Hydraulic gradient |∇h| (-)', unit:'', color:chartGreen, digits:3},
      {id:'hydraulicFs', label:'FSᵢ', axisTitle:'Hydraulic safety factor FSᵢ = iᶜʳⁱᵗ / |∇h| (-)', unit:'', color:chartGreen, digits:2},
      {id:'flow', label:'|q|', axisTitle:'Specific discharge |q| (m/s)', unit:'m/s', color:readCssToken('--wn', '#BA7517'), digits:3},
      {id:'qx', label:'qₓ', axisTitle:'Specific discharge qₓ (m/s)', unit:'m/s', color:chartOrange, digits:3},
      {id:'qy', label:'qᵧ', axisTitle:'Specific discharge qᵧ (m/s)', unit:'m/s', color:chartPurple, digits:3},
      {id:'normalFlow', label:'qₙ', axisTitle:'Normal discharge qₙ (m/s)', unit:'m/s', color:chartRed, digits:3}
    ];
  }
  if(workspace === 'deformation'){
    const normalizedAnalysisType = env.normalizedDeformationAnalysisType(analysisType);
    const colorById = {
      settlement:chartOrange,
      ux:chartBlue,
      uy:chartPurple,
      uTotal:chartRed,
      epsilonXx:chartGreen,
      epsilonYy:chartGreen,
      gammaXy:chartBlue,
      equivalentPlasticStrain:chartPurple,
      safetyEquivalentPlasticIncrement:chartPurple,
      deltaSigmaYy:readCssToken('--wn', '#BA7517'),
      sigmaYyEffInit:readCssToken('--wn', '#BA7517'),
      sigmaYyEff:chartOrange,
      sigmaYyTotalInit:chartOrange,
      sigmaYyTotal:chartRed,
      sigmaXxEffInit:chartBlue,
      sigmaXxEff:chartBlue,
      sigmaXxTotalInit:chartBlue,
      sigmaXxTotal:chartBlue,
      tauXy:chartPurple,
      mcEta:chartRed,
      hsGammaP:chartGreen,
      hsPP:chartOrange,
      hsEpsVPDilative:chartPurple,
      hsLastActiveSet:chartRed
    };
    return env.deformationContourOptions(normalizedAnalysisType, hasHs === true).map(({id, label})=>{
      const meta = env.deformationContourMeta(id, normalizedAnalysisType);
      return {
        id,
        label,
        axisTitle:meta.axisTitle || `${label}${meta.unit ? ` (${meta.unit})` : ''}`,
        unit:meta.unit || '',
        color:colorById[id] || chartBlue,
        digits:meta.digits || 3
      };
    });
  }
  return [];
}

/** The option `quantity` names, the first option as the fallback, or `null` in stability. */
export function lineProbeMeta(workspace, quantity, analysisType = null, hasHs = false, env = {}){
  const options = lineProbeOptions(workspace, analysisType, hasHs === true, env);
  return options.find((item)=>item.id === quantity) || options[0] || null;
}

/** One sampled value with its unit; `'—'` where the line left the solved domain. */
export function lineProbeFormatValue(meta, value){
  if(!Number.isFinite(value)) return '—';
  const suffix = meta?.unit ? ` ${meta.unit}` : '';
  return `${compactNumber(value, meta?.digits || 3)}${suffix}`;
}
