// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/measurement.js — layer 9: the committed Measure line (its preview is the
// hover layer's). From stage6BishopDrawCanvas 7214-7216 (integration-r 3b84193).
import { drawMeasurementOverlay } from './primitives.js';

export function drawMeasurement(ctx, vm, theme){
  const bishop = vm.bishop;
  if((bishop.measurement?.points || []).length >= 2){
    drawMeasurementOverlay(ctx, vm, theme, bishop.measurement.points);
  }
}
