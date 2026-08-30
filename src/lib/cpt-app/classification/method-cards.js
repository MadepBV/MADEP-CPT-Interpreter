// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// classification/method-cards.js — the five Stage 2 method cards (Robertson 1990 / Robertson
// 2016 / CUR 3 / NEN 6740 / SB 260) and their `.sel` state. 01-monolith-map.md §6.1 row
// `classification/` (`method-cards.js`), moved out of legacy-controller.js in PR 20 / step 10.
//
// Verbatim; the card-id → method-value map is the monolith's. `selectCpt` re-syncs the cards for
// the CPT it switches to (project/cpts.js), which is why the sync is a function of `method` only.

export const CLASSIFICATION_METHOD_CARDS = {
  mRob:'robertson',
  mRob16:'robertson2016',
  mCur:'cur3',
  mNen:'nen6740',
  mSB:'sb260'
};

export function syncClassificationMethodCards(document, method){
  Object.entries(CLASSIFICATION_METHOD_CARDS).forEach(([id, value])=>{
    const el=document.getElementById(id);
    if(el) el.classList.toggle('sel', method === value);
  });
}
