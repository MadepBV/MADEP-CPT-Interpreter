// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/apps/beam-state.js — state schema of the beam / slab-on-Winkler app: the `beam` block of
// stage6Defaults() (legacy-controller.js 2327-2366 at integration-r) and its clamps in
// ensureStage6State() (2737-2750), verbatim.

export function defaults(){
  return {
    modelMode:'slab_strip',
    foundationModel:'pasternak',
    B:1.50,
    b:1.00,
    L:6.00,
    h:0.35,
    Df:0.80,
    Ec:33000000,
    EsMode:'oedometric',
    zInfluence:3.00,
    gpEta:1.00,
    gpOverride:null,
    loadPattern:'uniform_full',
    Gk:35,
    QLead:15,
    QOther:0,
    useCategory:'A',
    slsCombination:'qp',
    ulsCombination:'A1',
    xLoad:3.00,
    xStart:1.50,
    xEnd:4.50,
    nElements:120,
    allowableDeflectionRatio:500,
    fck:30,
    fyk:500,
    exposureClass:'XC2',
    phiBar:12,
    dG:20,
    deltaCdev:10,
    cNomOverride:null,
    designLifeYears:50,
    isSlabOrPlate:true,
    specialQC:false,
    castAgainstUnevenSurface:false,
    castAgainstPreparedGround:false,
    castAgainstUnpreparedGround:false,
    dz:0.10
  };
}

export function ensure(stage6, env){
  const maxDepth = env.maxDepth;
  stage6.beam.Df = Math.min(Math.max(+stage6.beam.Df || 0.0, 0.0), maxDepth);
  stage6.beam.zInfluence = Math.max(+stage6.beam.zInfluence || 1, 0.5);
  stage6.beam.gpEta = Math.max(+stage6.beam.gpEta || 1.0, 0);
  if(!['slab_strip','beam_length','footing_transverse'].includes(stage6.beam.modelMode)){
    stage6.beam.modelMode = 'slab_strip';
  }
  if(stage6.beam.gpOverride != null && stage6.beam.gpOverride !== ''){
    stage6.beam.gpOverride = +stage6.beam.gpOverride;
  } else {
    stage6.beam.gpOverride = null;
  }
  if(stage6.beam.cNomOverride != null && stage6.beam.cNomOverride !== ''){
    stage6.beam.cNomOverride = +stage6.beam.cNomOverride;
  }
}
