// Run: node worklog/verify/verify_bearing_annex_d.mjs  (from the repo root; see worklog/06-bearing-eurocode-annex-d-review.md)
// Compares bearing/compute.js against a hand EN 1997-1 Annex D calculation for a 2 x 2 m footing, Df = 1 m, phi = 30, c = 0, WT deep.
import { bearingAtDepth, shapeFactors, depthFactors, bearingGeometry } from '../../src/lib/cpt-app/bearing/compute.js';
const layers=[{top:0,bot:20,phi:30,c:0,cu:0,g:18,gs:20,type:'Sand',subtype:''}];
const cfg={foundationType:'footing',B:2,L:2,eB:0,eL:0,shapeMode:'hansen',load:0,factorMode:'ec7',xi:2,gammaRd:1,ec7Combination:'governing',Df:1};
const r=bearingAtDepth(1,cfg,layers,{wt:50});
console.log(JSON.stringify({Nq:r.Nq,Nc:r.Nc,Ng:r.Ng,sq:r.sq,sc:r.sc,sg:r.sg,dq:r.dq,dc:r.dc,dg:r.dg,qDrain:r.qDrain,gammaEff:r.gammaEff,qult:r.qultDrained,qd:r.qdDrained,combo:r.drainedComboLabel,phiD:r.phiD,ec7:r.ec7Results},null,1));
// hand Annex D, square, phi=30, c=0, q'=18, gamma=18, B'=2, no depth factors
const phi=30*Math.PI/180, Nq=Math.exp(Math.PI*Math.tan(phi))*Math.tan(Math.PI/4+phi/2)**2, Ng=2*(Nq-1)*Math.tan(phi);
const sq=1+Math.sin(phi), sg=0.7;
console.log('hand Annex D no depth factors (M1):', (18*Nq*sq+0.5*18*2*Ng*sg).toFixed(1));
const dq=1+2*Math.tan(phi)*(1-Math.sin(phi))**2*0.5;
console.log('hand with BH dq:', (18*Nq*sq*dq+0.5*18*2*Ng*sg).toFixed(1), 'dq=',dq.toFixed(4));
// strip geometry check
console.log('strip geo', bearingGeometry({foundationType:'strip',B:2,L:10}));
console.log('undrained: ', JSON.stringify(bearingAtDepth(1,{...cfg},[{top:0,bot:20,phi:0,c:0,cu:50,g:18,gs:20,type:'Clay',subtype:''}],{wt:50}),null,0).slice(0,100));
const u=bearingAtDepth(1,cfg,[{top:0,bot:20,phi:0,c:0,cu:50,g:18,gs:20,type:'Clay',subtype:''}],{wt:50});
console.log({scu:u.scu,dcu:u.dcu,qultU:u.qultUndrained,qdU:u.qdUndrained, hand_noDepth:(18+5.14*50/1.4*1.2).toFixed(1), hand_withDepth:(18+5.14*50/1.4*1.2*(1+0.4*0.5)).toFixed(1)});

// --- depth-factor toggle (added with the toggle): default = strict Annex D, 'hansen' = previous behaviour
const rNone = bearingAtDepth(1, {...cfg, depthFactors:'none'}, layers, {wt:50});
const rBH = bearingAtDepth(1, {...cfg, depthFactors:'hansen'}, layers, {wt:50});
console.log('toggle: none', {dq:rNone.dq, dc:rNone.dc, qult:rNone.qultDrained, label:rNone.depthModeLabel}, 'hansen', {dq:rBH.dq, qult:rBH.qultDrained, label:rBH.depthModeLabel});
const uNone = bearingAtDepth(1, {...cfg, depthFactors:'none'}, [{top:0,bot:20,phi:0,c:0,cu:50,g:18,gs:20,type:'Clay',subtype:''}], {wt:50});
console.log('toggle undrained none:', {dcu:uNone.dcu, qultU:uNone.qultUndrained, hand:(18+5.14*50/1.4*1.2).toFixed(1)});
