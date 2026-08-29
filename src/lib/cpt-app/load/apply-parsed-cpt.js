// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// applyParsedCpt as a pure patch. The state half of legacy-controller.js
// applyParsedCpt (old lines 923-960) in refactor step 5 (PR 9): given the
// target CPT and a parsed-CPT result (parsers/*.js, rows possibly remapped by
// the review dialog) it returns the Stage 1 fields the import sets. The
// caller assigns the patch (Object.assign) and runs the DOM syncs
// (./controls.js syncParsedCptDom) + the chart init — nothing here touches S
// or the document.
//
// Returns null when there are no rows (the caller alerts
// "No valid data rows found." and reports the import as not applied).

export const NO_DATA_ROWS_MESSAGE='No valid data rows found.';

export function applyParsedCpt(cpt, {rows, meta, waterLevel, waterSource, elevation, elevationSource, x, y, coordinateSource}){
  if(!rows.length) return null;

  // Site coordinates: a real (non-origin) pair replaces the CPT's; a source
  // that declared coordinates but yielded none clears them; otherwise the
  // CPT keeps what it had (manual entry survives a re-import).
  let px=cpt.x, py=cpt.y;
  if(x!=null && y!=null && (x!==0 || y!==0)){
    px=x;
    py=y;
  }else if(coordinateSource){
    px=null;
    py=null;
  }

  return {
    data:rows,
    wt:waterLevel??1.5,
    wtFromFile:waterLevel!=null,
    wtSource:waterLevel!=null?(waterSource||'file'):null,
    elev:elevation,
    elevFromFile:elevation!=null,
    elevSource:elevation!=null?(elevationSource||'file'):null,
    x:px,
    y:py,
    meta:{...meta,nRows:rows.length,
      depthMin:rows[0].z,depthMax:rows[rows.length-1].z,
      hasU2:rows.some(r=>r.u2!=null),
      hasFs:rows.some(r=>r.fs!=null),
      hasRf:rows.some(r=>r.rf!=null)}
  };
}

/** Staged object for presentImportReview: the parser's review descriptor
    with the target CPT's assumed friction ratio (formatted as the dialog
    shows it, e.g. "3.0"). */
export function reviewStaging(parsed, assumedRfText){
  return {...parsed.review, context:{...parsed.review.context, assumedRf:assumedRfText}};
}
