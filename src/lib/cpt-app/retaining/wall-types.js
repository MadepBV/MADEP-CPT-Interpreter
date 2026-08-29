// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Registry of the wall types of the Stage 6 "Retaining walls" application.
 *   family 'gravity'  → RC cantilever / mass gravity (gravity_wall.hpp)
 *   family 'embedded' → continuous sheet pile (cantilever or anchored) and soldier-pile (Berliner)
 *                       walls (embedded_wall.hpp, engine v2)
 */
export const WALL_TYPES = [
  { id: 'cantilever', label: 'RC cantilever', sub: 'L / T-shaped reinforced concrete', family: 'gravity', engine: 'cantilever' },
  { id: 'gravity', label: 'Gravity / mass', sub: 'Mass concrete, resists by weight', family: 'gravity', engine: 'gravity' },
  { id: 'sheetpile', label: 'Sheet pile', sub: 'Continuous, cantilever (Blum)', family: 'embedded', engine: 'sheetpile', continuous: true },
  { id: 'anchored', label: 'Anchored sheet pile', sub: 'Continuous, one support (free-earth)', family: 'embedded', engine: 'anchored', continuous: true, anchored: true },
  { id: 'soldierpile', label: 'Soldier pile', sub: 'Berliner wall: H-piles + lagging', family: 'embedded', engine: 'soldierpile', continuous: false }
];

export function wallType(id) {
  return WALL_TYPES.find((t) => t.id === id) || WALL_TYPES[0];
}
export function wallFamily(id) { return wallType(id).family; }
export function isEmbedded(id) { return wallFamily(id) === 'embedded'; }
export function isSoldierPile(id) { return id === 'soldierpile'; }
export function isAnchoredType(rw) {
  const t = wallType(rw.wallType);
  return !!t.anchored || (t.id === 'soldierpile' && !!rw.embedded?.anchored);
}
