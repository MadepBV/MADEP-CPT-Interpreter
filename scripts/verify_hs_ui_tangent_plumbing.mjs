#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Guards the live UI material shape for the HS Simo-Hughes tangent selector.
// Stage 6 stores the HS selector under material.hs.useConsistentTangent; MC
// must keep its default OFF unless an explicit MC/top-level selector is set.

import assert from 'node:assert/strict';

import { prepareMechanicalMaterial } from '../src/lib/cpt-app/deformation/material.js';
import { encodeInputBuffer } from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

const HEADER_BYTES = 304;
const NODE_BYTES = 16;
const ELEMENT_BYTES = 32;
const REGION_COMMON_F64_BYTES = 10 * 8;
const REGION_FLAGS_BYTES = 4;
const HS_SELECTOR_SLOT = 12;

function minimalMesh() {
  return {
    elementType: 't3',
    nodes: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 }
    ],
    elements: [[0, 1, 2]],
    cells: [{ regionIndex: 0 }],
    elementCell: [0]
  };
}

function options(constitutiveModel) {
  return {
    constitutiveModel,
    analysisType: 'deformation',
    useGeostaticInit: false,
    hasSurfaceLoad: false
  };
}

function uiMaterial(overrides = {}) {
  const hs = {
    p_ref: 100,
    Rf: 0.9,
    OCR: 1,
    e_init: -1,
    e_max: -1,
    nearSurfaceMinConfiningStress: 0,
    useConsistentTangent: true,
    ...(overrides.hs || {})
  };
  const material = {
    Emc: 30000,
    E50_ref: 30000,
    Eoed_ref: 30000,
    Eur_ref: 90000,
    m: 0.5,
    nu: 0.3,
    nu_ur: 0.2,
    cEff: 5,
    phiEffDeg: 30,
    psiEffDeg: 0,
    K0nc: 0.5,
    gamma: 18,
    gammaSat: 20,
    sigmaTAllow: 0,
    rShear: 0.25,
    useTensionCutoff: false,
    symmetrizeEpTangent: false,
    ...overrides,
    hs
  };
  if (overrides.hs === null) delete material.hs;
  return material;
}

function encodedSelectorSlot(region, constitutiveModel) {
  const mesh = minimalMesh();
  const bytes = encodeInputBuffer({
    mesh,
    options: options(constitutiveModel),
    regions: [region],
    gravityRhsFull: new Float64Array(2 * mesh.nodes.length),
    loadRhsFull: new Float64Array(2 * mesh.nodes.length),
    predictorSolutionFull: new Float64Array(2 * mesh.nodes.length),
    initialSigmaByGp: new Float64Array(6 * mesh.elements.length),
    porePressureByGp: new Float64Array(mesh.elements.length),
    fixedDofs: [],
    numGpTotal: mesh.elements.length
  });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const regionOffset = HEADER_BYTES + mesh.nodes.length * NODE_BYTES + mesh.elements.length * ELEMENT_BYTES;
  const selectorOffset = regionOffset + REGION_COMMON_F64_BYTES + REGION_FLAGS_BYTES + HS_SELECTOR_SLOT * 8;
  return view.getFloat64(selectorOffset, true);
}

function preparedSelectorSlot(material, constitutiveModel) {
  return encodedSelectorSlot(prepareMechanicalMaterial(material), constitutiveModel);
}

const uiHsOn = uiMaterial();
const preparedUiHsOn = prepareMechanicalMaterial(uiHsOn);
assert.equal(preparedUiHsOn.hs.useConsistentTangent, true, 'HS UI selector must survive material preparation');
assert.equal(preparedUiHsOn.useConsistentTangent, false, 'HS UI selector must not flip the shared MC selector');
assert.equal(preparedSelectorSlot(uiHsOn, 'hardening-soil'), 1, 'HS wire slot must receive the UI HS selector');
assert.equal(
  preparedSelectorSlot(uiMaterial({ hs: { useConsistentTangent: false } }), 'hardening-soil'),
  0,
  'HS explicit OFF must reach the wire slot'
);
assert.equal(
  preparedSelectorSlot(uiMaterial({ useConsistentTangent: true, hs: { useConsistentTangent: false } }), 'hardening-soil'),
  0,
  'HS sub-block explicit OFF must win over compatibility top-level ON'
);
assert.equal(
  preparedSelectorSlot(uiMaterial({ hs: null, useConsistentTangent: true }), 'hardening-soil'),
  1,
  'legacy/top-level HS selector remains a compatibility fallback'
);
assert.equal(preparedSelectorSlot(uiHsOn, 'mc-plastic'), 0, 'MC default OFF must not inherit the HS selector');
assert.equal(
  preparedSelectorSlot(uiMaterial({ mc: { useConsistentTangent: true } }), 'mc-plastic'),
  1,
  'explicit MC selector must still reach the shared wire slot'
);

console.log('HS UI tangent plumbing verification PASSED.');
