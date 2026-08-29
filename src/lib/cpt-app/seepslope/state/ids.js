// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/state/ids.js — entity ids of the Seep / Slope state (`wall_*`, `drain_*`, `region_*`;
// legacy-controller.js stage6BishopWallId / DrainId / RegionId at 462fc50). The monolith read
// `Date.now()` and `Math.random()` inline; the state operations take an explicit `{ now, random }`
// so a verifier can seed them (the golden normaliser masks the ids, the verifier compares them
// verbatim under a seeded clock). `DEFAULT_IDS` is the browser's clock and PRNG — the host
// façades use it, so the ids look exactly as before.

/** The production id source: wall-clock time and Math.random. */
export const DEFAULT_IDS = Object.freeze({
  now: () => Date.now(),
  random: () => Math.random()
});

/** `<prefix>_<now base36>_<5 random base36 chars>` — the monolith's id shape, `now` read before `random`. */
export function entityId(prefix, ids = DEFAULT_IDS){
  return `${prefix}_${ids.now().toString(36)}_${ids.random().toString(36).slice(2,7)}`;
}
