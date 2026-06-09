#!/usr/bin/env node
// Phase-2 gate: node-split + interface-pair construction (mesh.js) ON vs OFF.
import { buildDeformationMesh } from '../src/lib/cpt-app/deformation/mesh.js';
import { buildBishopModelFromStageLayers } from '../src/lib/cpt-app/stage6-bishop.js';
if (typeof globalThis.performance === 'undefined') globalThis.performance = { now: () => Number(process.hrtime.bigint()/1000000n) };

function stageLayers(){ return [
  { top:0,bot:2.98,type:'Sand',subtype:'zand, matig',c:1,phi:30,psi:0,g:17,gs:19,Emc:23448,nu:0.3,K0nc:0.5,rShear:0.33,kh:4e-5,kv:4e-5 },
  { top:2.98,bot:6.98,type:'Sandy clay',subtype:'klei, matig vast',c:4,phi:20,psi:0,g:17,gs:17,Emc:5316,nu:0.4,K0nc:0.658,rShear:0.15,kh:5e-7,kv:1.7e-7,cu:50 },
  { top:6.98,bot:21.72,type:'Silty sand',subtype:'leem, vast',c:8,phi:22,psi:0,g:20,gs:20,Emc:11374,nu:0.3,K0nc:0.625,rShear:0.25,kh:3e-6,kv:1e-6,cu:100 } ]; }
function ui(){ const xw=8.5; return {
  terrain:[{x:0,y:0},{x:xw,y:0},{x:xw,y:-3},{x:20,y:-3}], activeCptX:4, analysisDepth:20, strengthSet:'characteristic',
  useCustomRegions:false, customRegions:[],
  walls:[{id:'w1',x:xw,yTop:0,yTip:-8,passiveSide:'right',mechanicalActive:true, material:{label:'RC',kAcross:1e-12,kAlong:1e-12,kSource:'preset', mechanical:{model:'rectangular',E:3e7,nu:0.2,thickness:0.5,kappa:5/6,source:'user'}},anchors:[]}],
  surfaceLoads:[], deformation:{options:{outOfPlaneLength:1,loadMode:'pressure'}}, seepage:null }; }
const opts = { meshElementType:'t3', meshTargetArea:1.2, constitutiveModel:'mc-plastic' };

let fails = 0;
const check = (n, c, d='') => { console.log(`${c?'OK  ':'FAIL'}  ${n}${d?'  ['+d+']':''}`); if(!c) fails++; };

const model = buildBishopModelFromStageLayers(stageLayers(), ui());
const off = await buildDeformationMesh(model, model.regions, { ...opts }, ()=>{});
const on  = await buildDeformationMesh(model, model.regions, { ...opts, useWallInterface: true }, ()=>{});

const offWall = off.mechanicalWalls[0], onWall = on.mechanicalWalls[0];
const nSt = onWall.nodes.length;
console.log(`stations=${nSt}  offNodes=${off.nodes.length} onNodes=${on.nodes.length} pairs=${on.interfacePairs.length}`);

check('OFF: no interface pairs', off.interfacePairs.length === 0);
check('OFF: ndofTotal = 2N + rot', off.ndofTotal === 2*off.nodes.length + offWall.nodes.length, `${off.ndofTotal}`);
check('ON: nodes grew by exactly the station count', on.nodes.length === off.nodes.length + nSt, `${on.nodes.length} vs ${off.nodes.length}+${nSt}`);
check('ON: one pair per station', on.interfacePairs.length === nSt);
check('ON: beam stations re-pointed to duplicates (nodeId >= offNodes)', onWall.nodes.every(s => s.nodeId >= off.nodes.length));
check('ON: soilNodeId preserved (< offNodes)', onWall.nodes.every(s => Number.isInteger(s.soilNodeId) && s.soilNodeId < off.nodes.length));
check('ON: duplicate coords match soil node coords', onWall.nodes.every(s => {
  const d = on.nodes[s.nodeId], o = on.nodes[s.soilNodeId];
  return Math.abs(d.x-o.x) < 1e-12 && Math.abs(d.y-o.y) < 1e-12;
}));
check('ON: soil cells untouched (same count, max nodeId < offNodes)', on.cells.length === off.cells.length &&
  on.cells.every(c => (c.nodeIds || []).every(id => id < off.nodes.length)));
check('ON: rotation DOFs sit above the FINAL translational block',
  Object.values(on.wallRotationDofByNode).every(d => d >= 2*on.nodes.length) &&
  on.ndofTotal === 2*on.nodes.length + nSt, `ndof=${on.ndofTotal}`);

const P = on.interfacePairs;
check('pairs: k_n = 11·k_s (nu_i=0.45)', P.every(p => Math.abs(p.kN - 11*p.kS) < 1e-6*p.kN));
const sumEll = P.reduce((a,p)=>a+p.ell,0);
check('pairs: Σ tributary lengths == wall length', Math.abs(sumEll - 8) < 1e-6, `Σℓ=${sumEll.toFixed(4)} vs 8`);
check('pairs: retained normal points toward higher terrain (−x here)', P.every(p => p.nx < 0));
check('pairs: tangent points top→tip (downward)', P.every(p => Math.abs(p.sx) < 1e-9 && p.sy < 0));
// layer-dependent strength: crest stations in sand L1 (c=1,phi=30 → c_i=0.667, tanPhiI=0.667·tan30),
// stations below -2.98 in clay L2 (c=4,phi=20), below -6.98 in L3 (c=8,phi=22)
const inL1 = P.filter(p => p.y > -2.97), inL2 = P.filter(p => p.y < -3.0 && p.y > -6.97), inL3 = P.filter(p => p.y < -7.0);
const t30 = 0.667*Math.tan(30*Math.PI/180), t20 = 0.667*Math.tan(20*Math.PI/180), t22 = 0.667*Math.tan(22*Math.PI/180);
check('pairs: L1 friction = R·tan30', inL1.length>0 && inL1.every(p=>Math.abs(p.tanPhiI - t30)<1e-6), `n=${inL1.length}`);
check('pairs: L2 friction = R·tan20 + c_i=R·4', inL2.length>0 && inL2.every(p=>Math.abs(p.tanPhiI - t20)<1e-6 && Math.abs(p.cI-0.667*4)<1e-6), `n=${inL2.length}`);
check('pairs: L3 friction = R·tan22 + c_i=R·8', inL3.length>0 && inL3.every(p=>Math.abs(p.tanPhiI - t22)<1e-6 && Math.abs(p.cI-0.667*8)<1e-6), `n=${inL3.length}`);
check('pairs: stiffness positive and finite', P.every(p => p.kN > 0 && p.kS > 0 && Number.isFinite(p.kN)));
console.log(`  sample pair @crest: ${JSON.stringify(P[0], (k,v)=>typeof v==='number'?+v.toPrecision(5):v)}`);
console.log(`\n${fails ? 'FAILURES' : 'ALL OK'}: ${fails}`);
process.exit(fails ? 1 : 0);
