// SPDX-License-Identifier: AGPL-3.0-or-later
// Scoped styles of the retaining-wall application (injected with the body; keeps legacy.css untouched).
// Wrapped in `@layer legacy` so an injected <style> cannot outrank the `components` layer (design-system §5.1).
export const RETWALL_STYLE = `<style>
@layer legacy {
.st6-retwall{padding:14px}
.st6-rw-head{margin-bottom:10px;display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
.st6-rw-title{font-size:14px;font-weight:600}
.st6-rw-subtitle{font-size:11.5px;color:var(--tx2);margin-top:3px;max-width:96ch}
.st6-rw-tabs{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:12px}
.st6-rw-tab{display:flex;flex-direction:column;gap:2px;align-items:flex-start;text-align:left;padding:8px 10px;border:1px solid var(--bd);border-radius:var(--r);background:var(--panel-solid);cursor:pointer;transition:all .15s}
.st6-rw-tab span{font-size:10.5px;color:var(--tx2)}
.st6-rw-tab:hover{border-color:var(--ac)}
.st6-rw-tab.sel{border-color:var(--ac);background:var(--acl);box-shadow:inset 0 0 0 1px var(--ac)}
.st6-rw-cols{display:grid;grid-template-columns:310px minmax(300px,1fr) 340px;gap:14px;align-items:start}
.st6-rw-inputs{display:flex;flex-direction:column;gap:7px;position:sticky;top:12px;max-height:calc(100vh - 24px);overflow-y:auto;padding-right:2px;scrollbar-width:thin}
.st6-rw-inputs>*{flex-shrink:0;min-width:0}
.st6-rw-acc{border:1px solid var(--bd);border-radius:var(--r);background:var(--panel-solid);overflow:hidden;min-width:0}
.st6-rw-acc>summary{padding:8px 10px;font-size:12px;font-weight:600;cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px}
.st6-rw-acc>summary::-webkit-details-marker{display:none}
.st6-rw-acc>summary::before{content:'▸';color:var(--tx3)}
.st6-rw-acc[open]>summary::before{content:'▾'}
.st6-rw-acc>summary .st6-rw-pill{margin-left:auto}
.st6-rw-accbody{padding:8px 10px;border-top:1px solid var(--bd);min-width:0;overflow-x:hidden}
.st6-rw-fields{display:flex;flex-direction:column;gap:6px}
.st6-rw-soilgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px}
.st6-rw-soilgrid .st6-rw-field{flex-wrap:wrap;row-gap:3px}
.st6-rw-soilgrid .st6-rw-field input[type=number]{width:62px}
.st6-rw-field{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11.5px;min-width:0}
.st6-rw-field>span:first-child{color:var(--tx2);line-height:1.25;min-width:0;flex:1 1 auto}
.st6-rw-inwrap{display:flex;align-items:center;gap:4px;flex-shrink:0}
.st6-rw-field input[type=number],.st6-rw-field input[type=text]{width:72px;padding:3px 6px;border:1px solid var(--bd2);border-radius:4px;background:var(--input-bg);font:inherit;font-size:11.5px;text-align:right}
.st6-rw-field input[type=text]{text-align:left;width:120px}
.st6-rw-field select{padding:3px 6px;border:1px solid var(--bd2);border-radius:4px;background:var(--input-bg);font:inherit;font-size:11.5px;min-width:0;max-width:min(172px,62%);text-overflow:ellipsis;flex:0 1 auto}
.st6-rw-field .st6-rw-seg{flex-shrink:0}
.st6-rw-unit{font-size:10px;color:var(--tx3);min-width:34px}
.st6-rw-check{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--tx2);margin-top:6px}
.st6-rw-pill{font-size:9.5px;font-family:var(--font-mono);padding:1px 6px;border-radius:9px;background:var(--bg2);color:var(--tx2);white-space:nowrap}
.st6-rw-pill.warn{background:var(--wn-soft,rgba(138,98,13,0.12));color:var(--wn,#8a620d)}
.st6-rw-pill.ok{background:var(--ok-soft);color:var(--ok-text)}
.st6-rw-pill.bad{background:var(--bad-soft);color:var(--bad-text)}
.st6-rw-canvaswrap{position:relative;min-height:440px;border:1px solid var(--bd);border-radius:var(--r);background:var(--panel-solid);overflow:hidden}
.st6-rw-canvaswrap canvas{width:100%;height:440px;display:block;touch-action:none}
.st6-rw-canvastools{position:absolute;top:8px;right:8px;display:flex;gap:8px;align-items:center}
.st6-rw-canvastools button{font-size:11px;padding:3px 9px;border:1px solid var(--bd2);border-radius:5px;background:rgba(255,255,255,0.88);cursor:pointer;font-family:var(--font-mono)}
.st6-rw-canvastools button:hover{border-color:var(--ac);color:var(--ac)}
.st6-rw-hint{font-size:10px;color:var(--tx3);background:rgba(247,244,239,0.82);padding:3px 7px;border-radius:5px}
.st6-rw-legend{position:absolute;left:8px;bottom:8px;display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--tx2);background:rgba(247,244,239,0.82);padding:4px 7px;border-radius:5px}
.st6-rw-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:3px;vertical-align:middle}
.st6-rw-summary{font-size:12px;display:flex;flex-direction:column;gap:10px}
.st6-rw-verdict{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:var(--r);font-size:12px}
.st6-rw-verdict.ok{background:var(--ok-soft);color:var(--ok-text)}
.st6-rw-verdict.bad{background:var(--bad-soft);color:var(--bad-text)}
.st6-rw-verdict.idle{background:var(--bg2);color:var(--tx2)}
.st6-rw-verdict-tag{font-weight:700;font-family:var(--font-mono);font-size:10.5px;letter-spacing:.04em}
.st6-rw-kv{display:grid;grid-template-columns:1fr auto;gap:3px 10px;font-size:11.5px}
.st6-rw-kv dt{color:var(--tx2)}
.st6-rw-kv dd{margin:0;font-family:var(--font-mono);text-align:right}
.st6-rw-kv dd small{color:var(--tx3);font-size:9.5px;margin-left:4px}
.st6-rw-card{border:1px solid var(--bd);border-radius:var(--r);background:var(--panel-solid);padding:9px 11px}
.st6-rw-card-title{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--tx3);margin-bottom:6px}
.st6-rw-checks{width:100%;border-collapse:collapse}
.st6-rw-checks th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--tx3);padding:4px 6px;border-bottom:1px solid var(--bd)}
.st6-rw-checks td{padding:7px 6px;border-bottom:1px solid var(--bd);vertical-align:top}
.st6-rw-checkname{font-weight:600;font-size:11.5px}
.st6-rw-checksub{font-size:10px;color:var(--tx3);margin-top:1px}
.st6-rw-checkextra{font-size:10px;color:var(--tx2);margin-top:2px;font-family:var(--font-mono)}
.st6-rw-utilcell{width:120px}
.st6-rw-util{position:relative;height:7px;background:var(--bg2);border-radius:4px;overflow:hidden;margin-bottom:3px}
.st6-rw-util-fill{position:absolute;left:0;top:0;bottom:0;border-radius:4px}
.st6-rw-util-mark{position:absolute;top:-1px;bottom:-1px;width:1px;background:var(--tx3)}
.st6-rw-utilnum{font-size:10.5px;font-family:var(--font-mono);color:var(--tx2)}
.st6-rw-badge{font-size:9.5px;font-weight:700;font-family:var(--font-mono);padding:2px 5px;border-radius:3px}
.st6-rw-badge.ok{background:var(--ok-soft);color:var(--ok-text)}
.st6-rw-badge.bad{background:var(--bad-soft);color:var(--bad-text)}
.st6-rw-badge.info{background:var(--bg2);color:var(--tx2)}
.st6-rw-results{margin-top:14px;border:1px solid var(--bd);border-radius:var(--r);background:var(--panel-solid)}
.st6-rw-rtabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid var(--bd);overflow-x:auto}
.st6-rw-rtab{font-size:11.5px;padding:6px 11px;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;background:transparent;cursor:pointer;color:var(--tx2);white-space:nowrap}
.st6-rw-rtab:hover{color:var(--tx)}
.st6-rw-rtab.sel{background:var(--panel-solid);border-color:var(--bd);color:var(--tx);font-weight:600;margin-bottom:-1px}
.st6-rw-rbody{padding:12px 14px;font-size:12px}
.st6-rw-table{width:100%;border-collapse:collapse;font-size:11px}
.st6-rw-table th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--tx3);padding:5px 6px;border-bottom:1px solid var(--bd);white-space:nowrap}
.st6-rw-table td{padding:5px 6px;border-bottom:1px solid var(--bd);font-family:var(--font-mono);white-space:nowrap}
.st6-rw-table td:first-child{font-family:inherit;color:var(--tx2);white-space:normal}
.st6-rw-table tr.gov td{background:var(--acl)}
.st6-rw-table td.num{text-align:right}
.st6-rw-tablewrap{overflow-x:auto}
.st6-rw-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.st6-rw-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.st6-rw-chart{width:100%;height:320px;display:block;border:1px solid var(--bd);border-radius:6px;background:#fff}
.st6-rw-chart.tall{height:420px}
.st6-rw-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
.st6-rw-copy{font-size:10.5px;padding:3px 8px;border:1px solid var(--bd2);border-radius:5px;background:var(--panel-solid);cursor:pointer;font-family:var(--font-mono)}
.st6-rw-copy:hover{border-color:var(--ac);color:var(--ac)}
.st6-rw-note{font-size:11px;color:var(--tx2);margin-top:6px;line-height:1.5}
.st6-rw-note.warn{color:var(--wn,#8a620d)}
.st6-rw-layerwrap{max-height:300px;overflow:auto;border:1px solid var(--bd);border-radius:6px}
.st6-rw-layers{width:100%;border-collapse:collapse;font-size:10.5px}
.st6-rw-layers thead th{position:sticky;top:0;background:var(--panel-solid);z-index:1}
.st6-rw-layers th{font-size:9.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--tx3);padding:3px 4px;border-bottom:1px solid var(--bd);text-align:left}
.st6-rw-layers td{padding:2px 4px;border-bottom:1px solid var(--bd);vertical-align:middle}
.st6-rw-layers input{width:46px;padding:2px 4px;border:1px solid var(--bd2);border-radius:3px;background:var(--input-bg);font:inherit;font-size:10.5px;text-align:right}
.st6-rw-layers input.ov{border-color:var(--wn,#8a620d);background:rgba(138,98,13,0.08)}
.st6-rw-layers .base{color:var(--tx3);font-size:9px;display:block;font-family:var(--font-mono)}
.st6-rw-seg{display:inline-flex;border:1px solid var(--bd2);border-radius:5px;overflow:hidden}
.st6-rw-seg button{font-size:10.5px;padding:3px 8px;border:none;background:transparent;cursor:pointer;color:var(--tx2)}
.st6-rw-seg button.sel{background:var(--acl);color:var(--tx);font-weight:600}
.st6-rw-branchcards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
.st6-rw-branchcard{border:1px solid var(--bd);border-radius:var(--r);padding:8px 10px;background:var(--panel-solid)}
.st6-rw-branchcard.gov{border-color:var(--ac);box-shadow:inset 0 0 0 1px var(--ac)}
.st6-rw-branchcard h4{margin:0 0 4px;font-size:11.5px}
.st6-rw-branchcard .f{font-size:10px;color:var(--tx3);font-family:var(--font-mono);margin-bottom:4px}
@media (max-width:1200px){.st6-rw-cols{grid-template-columns:300px 1fr}.st6-rw-cols>.st6-rw-summary{grid-column:1/-1}.st6-rw-branchcards{grid-template-columns:repeat(2,1fr)}}
@media (max-width:900px){.st6-rw-cols{grid-template-columns:1fr}.st6-rw-tabs{grid-template-columns:repeat(2,1fr)}.st6-rw-grid2,.st6-rw-grid3{grid-template-columns:1fr}}
}
</style>`;
