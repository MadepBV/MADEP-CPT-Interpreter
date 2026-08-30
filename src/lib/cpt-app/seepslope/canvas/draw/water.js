// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/water.js — layer 5: the phreatic line, the drains and the current draft
// polyline. From stage6BishopDrawCanvas 7044-7059 (integration-r 3b84193).
import { drawPolyline } from './primitives.js';

/** The user-drawn phreatic polyline (the solved free surface is the seepage layer's). */
export function drawPhreatic(ctx, vm, theme){
  const bishop = vm.bishop;
  if(bishop.phreatic?.length >= 2) drawPolyline(ctx, vm, bishop.phreatic, theme.phreatic, 2, [8, 5]);
}

/** Every drain polyline, the selected one heavier. */
export function drawDrains(ctx, vm, theme){
  const bishop = vm.bishop;
  if(bishop.seepage?.display?.showDrains === false) return;
  (bishop.drains || []).forEach((drain)=>{
    const selected = drain.id && drain.id === bishop.selectedDrainId;
    drawPolyline(ctx, vm, drain.vertices || [], selected ? theme.drainSelected : theme.drain, selected ? 3.5 : 2.5, []);
  });
}

/** The committed part of the polyline the active draw tool is building. */
export function drawDraft(ctx, vm, theme){
  const bishop = vm.bishop;
  if(!bishop.draft?.length) return;
  const draftStroke = bishop.draftKind === 'phreatic'
    ? theme.phreatic
    : bishop.draftKind === 'drain'
      ? theme.drain
      : theme.draft;
  drawPolyline(ctx, vm, bishop.draft, draftStroke, 2, [6, 4]);
}
