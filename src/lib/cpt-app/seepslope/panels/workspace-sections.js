// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/workspace-sections.js — the two per-workspace pickers of the settings column
// (legacy-controller.js 6452-6580 `workspaceGeometrySectionHtml` and 6581-6974
// `workspaceSettingsHtml`). Each branch is one or more `data-st6details` groups from ./sections/,
// concatenated in the monolith's order; the trailing two-space line is the monolith's own.
import { analysisInputsSectionHtml } from './sections/geometry-analysis.js';
import { seepageBoundarySectionHtml } from './sections/geometry-seepage-boundary.js';
import { mechanicalInputsSectionHtml } from './sections/geometry-deformation.js';
import { searchSectionHtml } from './sections/search.js';
import { spencerSectionHtml } from './sections/spencer.js';
import { materialsSectionHtml } from './sections/materials.js';
import { seepagePermeabilitySectionHtml } from './sections/seepage-permeability.js';
import { seepageBcsSectionHtml } from './sections/seepage-bcs.js';
import { seepageDrainsSectionHtml } from './sections/seepage-drains.js';
import { seepageOptionsSectionHtml } from './sections/seepage-options.js';
import { seepageIntegrationSectionHtml } from './sections/seepage-integration.js';
import { deformationMaterialsSectionHtml } from './sections/deformation-materials.js';
import { deformationSolveSectionHtml } from './sections/deformation-solve.js';
import { deformationSolverSettingsSectionHtml } from './sections/deformation-solver-settings.js';

export function workspaceGeometrySectionHtml(vm, env){
  const { workspace } = vm;
  return workspace === 'stability' ? `${analysisInputsSectionHtml(vm, env)}
  ` : workspace === 'seepage' ? `${seepageBoundarySectionHtml(vm, env)}
  ` : `${mechanicalInputsSectionHtml(vm, env)}
  `;
}

export function workspaceSettingsHtml(vm, env){
  const { workspace } = vm;
  return workspace === 'stability' ? `${searchSectionHtml(vm, env)}${spencerSectionHtml(vm, env)}${materialsSectionHtml(vm, env)}
  ` : workspace === 'seepage' ? `${seepagePermeabilitySectionHtml(vm, env)}${seepageBcsSectionHtml(vm, env)}${seepageDrainsSectionHtml(vm, env)}${seepageOptionsSectionHtml(vm, env)}${seepageIntegrationSectionHtml(vm, env)}
  ` : `${deformationMaterialsSectionHtml(vm, env)}${deformationSolveSectionHtml(vm, env)}${deformationSolverSettingsSectionHtml(vm, env)}
  `;
}
