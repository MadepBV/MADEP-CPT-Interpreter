// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/sections/deformation-materials.js — legacy-controller.js 6799-6821, verbatim.

/** `bishop-deformation-materials` — the MC / HS material tables. */
export function deformationMaterialsSectionHtml(vm, env){
  const { deformationMaterialRows, hsMaterialTableHtml } = vm;
  const { STAGE6_ENABLE_HARDENING_SOIL_UI, stage6DetailsOpen } = env;
  return `
            <details class="st6-adv" data-st6details="bishop-deformation-materials"${stage6DetailsOpen('bishop-deformation-materials')}>
              <summary>Imported deformation materials</summary>
              <div class="st6-adv-body">
                <div class="st6-help">The deformation screen reuses the active CPT-derived layer column across the whole section. The default Mohr-Coulomb plastic route uses an exact active-set return with face, edge, apex, and tension cut-off handling. The reduced-stiffness screen and linear elastic route remain available for sensitivity checks.</div>
                <div style="overflow:auto">
                  <table class="tbl st6-bishop-materials st6-bishop-materials--deformation">
                    <colgroup>
                      <col class="st6-mat-col-layer">
                      <col class="st6-mat-col-emc">
                      <col class="st6-mat-col-small">
                      <col class="st6-mat-col-small">
                      <col class="st6-mat-col-small">
                      <col class="st6-mat-col-small">
                      <col class="st6-mat-col-small">
                      <col class="st6-mat-col-small">
                    </colgroup>
                    <thead><tr><th>Layer</th><th>E_mc (kPa)</th><th>ν</th><th>K0</th><th>r_shear</th><th>c'</th><th>phi'</th><th>psi</th></tr></thead>
                    <tbody>${deformationMaterialRows}</tbody>
                  </table>
                </div>
                ${STAGE6_ENABLE_HARDENING_SOIL_UI ? hsMaterialTableHtml : ''}
              </div>
            </details>`;
}
