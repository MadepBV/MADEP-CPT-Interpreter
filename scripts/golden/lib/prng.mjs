// SPDX-License-Identifier: AGPL-3.0-or-later
// Seeded PRNG (mulberry32) shared by the fixture generator and the browser
// determinism init script. Locks nothing itself; it is what makes the demo-shape
// fixture (loadDemo() draws Math.random per reading, legacy-controller.js:1823)
// reproducible bit-for-bit from a seed recorded in fixtures/manifest.json.

export function mulberry32(seed) {
  let t = seed >>> 0;
  return function random() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Source text of the same generator, for injection into a browser page. */
export const MULBERRY32_SOURCE = `(function(seed){let t=seed>>>0;return function(){t+=0x6D2B79F5;let r=Math.imul(t^(t>>>15),1|t);r^=r+Math.imul(r^(r>>>7),61|r);return((r^(r>>>14))>>>0)/4294967296;};})`;
