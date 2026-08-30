// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/terrain.js — layer 11: the ground surface, drawn late so it reads on top
// of the fields and the loads. From stage6BishopDrawCanvas 7288 (integration-r 3b84193).
import { drawPolyline } from './primitives.js';

export function drawTerrain(ctx, vm, theme){
  const bishop = vm.bishop;
  if(bishop.terrain?.length >= 2) drawPolyline(ctx, vm, bishop.terrain, theme.terrain, 3);
}
