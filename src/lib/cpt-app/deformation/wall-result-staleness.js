// Defense-in-depth staleness guard for the Stage-6 deformation wall overlay.
//
// A deformation `wallResult` (its stations, moment/shear diagram, deformed
// shape) is computed for the wall geometry that was snapshotted into
// `deformation.lastWallInputs` at the moment the run was launched. If any UI
// edit path forgets to invalidate the cached result, the overlay would silently
// draw the diagram at the OLD wall coordinates — e.g. a moment diagram covering
// only part of a wall whose tip has since been dragged deeper. This pure
// predicate lets the renderer skip such a stale overlay even when invalidation
// was missed, and lets a CI gate assert the same invariant at the data level.
//
// It is deliberately conservative: it returns `true` (stale) only when it can
// positively establish that the run-time geometry no longer matches the current
// wall (head moved, or station span / wall length changed). When it cannot
// establish a mismatch (no snapshot, missing coordinates) it returns `false`
// so a healthy result is never wrongly hidden.

const DEFAULT_TOL = 1e-6;

function resolveEndpoints(entry){
  if(!entry) return null;
  const head = entry.head && Number.isFinite(+entry.head.x) && Number.isFinite(+entry.head.y)
    ? {x:+entry.head.x, y:+entry.head.y}
    : (Number.isFinite(+entry.x) && Number.isFinite(+entry.yTop) ? {x:+entry.x, y:+entry.yTop} : null);
  const tip = entry.tip && Number.isFinite(+entry.tip.x) && Number.isFinite(+entry.tip.y)
    ? {x:+entry.tip.x, y:+entry.tip.y}
    : (Number.isFinite(+entry.x) && Number.isFinite(+entry.yTip) ? {x:+entry.x, y:+entry.yTip} : null);
  if(!head || !tip) return null;
  return {head, tip};
}

/**
 * @param {object} wallResult   one entry from deformation.result.wallResults (has wallIndex)
 * @param {object} bishop       the Stage-6 bishop state (walls + deformation.lastWallInputs)
 * @param {number} [tol]        coordinate tolerance (default 1e-6)
 * @returns {boolean}           true when the result's run-time geometry no longer
 *                              matches the current wall (so the overlay is stale)
 */
export function wallResultIsStale(wallResult, bishop, tol = DEFAULT_TOL){
  if(!wallResult || !bishop) return false;
  const lastInputs = bishop.deformation?.lastWallInputs || [];
  if(!lastInputs.length) return false; // no run-time snapshot to compare against
  const wallIndex = Number(wallResult.wallIndex);
  const snapshot = Number.isInteger(wallIndex) ? lastInputs[wallIndex] : null;
  if(!snapshot) return false;
  const current = (bishop.walls || []).find((wall)=>wall.id === snapshot.id) || null;
  if(!current) return true; // the wall this result belongs to no longer exists
  const snap = resolveEndpoints(snapshot);
  const cur = resolveEndpoints(current);
  if(!snap || !cur) return false;
  // Head position anchors the overlay (station 0); any move makes it stale.
  if(Math.abs(snap.head.x - cur.head.x) > tol || Math.abs(snap.head.y - cur.head.y) > tol) return true;
  // Station span (recovered wall length = |tip − head|) must match the drawn wall.
  const snapLen = Math.hypot(snap.tip.x - snap.head.x, snap.tip.y - snap.head.y);
  const curLen = Math.hypot(cur.tip.x - cur.head.x, cur.tip.y - cur.head.y);
  if(Math.abs(snapLen - curLen) > tol) return true;
  return false;
}
