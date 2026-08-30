// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/header.js — the three chrome blocks of the Seep / Slope app, verbatim:
//   appHeaderHtml    legacy-controller.js 7986-7997 — the title, the workspace switch and its note
//   settingsHeadHtml                      8000-8009 — the settings column's head and its two actions
//   commandBarHtml                        8150-8180 — Run / Stop / Fit / Clear, the status card and
//                                                     the progress track above the canvas
import { escAttr as stage6EscAttr } from '../../core/format.js';

/** Title, the three-workspace switch and the shared-canvas note. */
export function appHeaderHtml(vm, env){
  const { workspace, workspaceSwitchNote } = vm;
  return `
      <div class="mc2-head" style="margin-bottom:12px">
	        <span style="font-size:13px;font-weight:600">${workspace === 'deformation' ? 'Section deformation screening' : 'Seep/Slope + Spencer equilibrium check'}</span>
	        <span style="font-size:11px;color:var(--tx2)">${workspace === 'deformation'
	          ? 'Shared Stage 6 geometry with a drained plane-strain mesh, required self-weight equilibrium, and selectable elastic or Mohr-Coulomb material behaviour.'
		          : 'Circular slip surfaces only, active CPT only, with self-weight, optional infinitely stiff retaining walls, multiple optional surcharge strips, and an optional full Spencer verification pass on the shortlisted circles.'}</span>
      </div>
      <div class="st6-bishop-workspace-switch">
        <button class="btn sm ${workspace==='stability'?'active':''}" onclick="stage6BishopSetWorkspace('stability')">Stability</button>
        <button class="btn sm ${workspace==='seepage'?'active':''}" onclick="stage6BishopSetWorkspace('seepage')">Seepage</button>
        <button class="btn sm ${workspace==='deformation'?'active':''}" onclick="stage6BishopSetWorkspace('deformation')">Deformation</button>
      </div>
      <div class="st6-bishop-workspace-note">${stage6EscAttr(workspaceSwitchNote)}</div>`;
}

/** The settings column head: workspace name, Wide and Hide. */
export function settingsHeadHtml(vm, env){
  const { workspace, settingsWide } = vm;
  return `
          <div class="st6-bishop-settings-head">
            <div>
              <span>Settings</span>
              <strong>${workspace === 'seepage' ? 'Seepage' : workspace === 'deformation' ? 'Deformation' : 'Stability'}</strong>
            </div>
            <div class="st6-bishop-settings-actions">
              <button class="btn sm" onclick="stage6BishopToggleSettingsWidth()">${settingsWide ? 'Narrow' : 'Wide'}</button>
              <button class="btn sm" onclick="stage6BishopToggleSettingsPanel(false)">Hide</button>
            </div>
          </div>`;
}

/** The command bar: run / stop / fit / clear, status card, progress track. */
export function commandBarHtml(vm, env){
  const { modeMeta, measurementStatus, toolbarRunLabel, toolbarRunAction, toolbarStopAction, toolbarClearAction, toolbarClearLabel, toolbarRunReady, toolbarRunning, toolbarHasResult, toolbarProgressText, toolbarProgressPercent, workspaceReadyHint, workspaceFocusLabel, workspaceFocusValue } = vm;
  return `
            <div class="st6-bishop-command">
              <div class="st6-bishop-toolbar">
                <div class="st6-bishop-toolbar-main">
                  <button class="btn" onclick="${toolbarRunAction}" ${toolbarRunReady?'':'disabled'}>${toolbarRunLabel}</button>
                  <button class="btn sm" onclick="${toolbarStopAction}" ${toolbarRunning ? '' : 'disabled'}>Stop</button>
                </div>
                <div class="st6-bishop-toolbar-secondary">
                  <button class="btn sm" onclick="fitStage6BishopViewport()">Fit view</button>
                  <button class="btn sm" onclick="${toolbarClearAction}" ${toolbarHasResult ? '' : 'disabled'}>${toolbarClearLabel}</button>
                </div>
              </div>
              <div class="st6-bishop-status-card">
                <div id="stage6BishopProgress" class="st6-bishop-status-summary">${stage6EscAttr(toolbarProgressText)}</div>
                <div class="st6-bishop-status-meta">
                  <div class="st6-bishop-status-stat">
                    <span class="st6-bishop-status-label">Tool</span>
                    <strong id="stage6BishopMode" class="st6-bishop-mode">${stage6EscAttr(modeMeta.label)}</strong>
                  </div>
                  <div class="st6-bishop-status-stat">
                    <span class="st6-bishop-status-label">${stage6EscAttr(workspaceFocusLabel)}</span>
                    <strong>${stage6EscAttr(workspaceFocusValue)}</strong>
                  </div>
                  <div class="st6-bishop-status-stat">
                    <span class="st6-bishop-status-label">Line</span>
                    <strong>${stage6EscAttr(measurementStatus)}</strong>
                  </div>
                </div>
                <div class="st6-bishop-status-hint">${stage6EscAttr(workspaceReadyHint)}</div>
              </div>
            </div>
            <div class="st6-bishop-progress-track"><div id="stage6BishopProgressBar" class="st6-bishop-progress-bar" style="width:${Math.max(0, Math.min(100, toolbarProgressPercent))}%"></div></div>`;
}
