<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import { call } from '$lib/cpt-app/ui';
</script>

<div class="panel" id="p1">
	<div class="panel__head">
		<div>
			<div class="panel__title">Classification method</div>
			<div class="panel__sub">
				Choose a method, set minimum layer thickness, then click Apply. Robertson 2016 is the
				recommended default for most projects in the current app.
			</div>
		</div>
	</div>
	<div class="panel__body">
		<div class="card-grid">
			<div
				class="card card--select"
				id="mRob"
				role="button"
				tabindex="0"
				onclick={() => call('selM', 'robertson')}
				onkeydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						call('selM', 'robertson');
					}
				}}
			>
				<h3 class="card__title">Robertson (1990) — SBT / Ic</h3>
				<p class="card__text">Normalised Qt and Fr. Stress-dependent — accounts for depth.</p>
			</div>
			<div
				class="card card--select sel"
				id="mRob16"
				role="button"
				tabindex="0"
				onclick={() => call('selM', 'robertson2016')}
				onkeydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						call('selM', 'robertson2016');
					}
				}}
			>
				<h3 class="card__title">Robertson (2016) — SBT / Qtn <span class="card__hint">Recommended</span></h3>
				<p class="card__text">
					Iterative Qtn and Fr. Preferred default; may be especially useful when the input is a CPTu; still works when
					u2 is absent.
				</p>
			</div>
			<div
				class="card card--select"
				id="mCur"
				role="button"
				tabindex="0"
				onclick={() => call('selM', 'cur3')}
				onkeydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						call('selM', 'cur3');
					}
				}}
			>
				<h3 class="card__title">CUR 3 layers</h3>
				<p class="card__text">
					Broad practical layering chart using direct qc and Rf. Produces Sand, Silt, Clay,
					and Peat zones for layer generation.
				</p>
			</div>
			<div
				class="card card--select"
				id="mNen"
				role="button"
				tabindex="0"
				onclick={() => call('selM', 'nen6740')}
				onkeydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						call('selM', 'nen6740');
					}
				}}
			>
				<h3 class="card__title">NEN 6740</h3>
				<p class="card__text">
					Stress-dependent q<sub>c,NEN</sub> and friction ratio. Uses the 14-area NEN material
					chart for more detailed CPT interpretation.
				</p>
			</div>
			<div
				class="card card--select"
				id="mSB"
				role="button"
				tabindex="0"
				onclick={() => call('selM', 'sb260')}
				onkeydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						call('selM', 'sb260');
					}
				}}
			>
				<h3 class="card__title">NEN Tabel 3</h3>
				<p class="card__text">
					Direct subtype table from q<sub>c</sub> and R<sub>f</sub>. Fine-grained route that
					often aligns well with later parameter assignment.
				</p>
			</div>
		</div>

		<div class="fields">
			<label class="check">
				<input
					type="checkbox"
					id="smartMergeChk"
					checked
					onchange={(event) =>
						call('setSmartMerge', (event.currentTarget as HTMLInputElement).checked)}
				/>
				<span style="display:inline-flex;align-items:center;gap:4px">
					Smart layer merge
					<button
						type="button"
						class="st6-tip"
						data-tip="Similarity-based boundary cleanup applied after classification and before the final minimum-thickness rule. Higher sensitivity makes the app progressively more willing to remove compatible layer boundaries."
						aria-label="Similarity-based boundary cleanup applied after classification and before the final minimum-thickness rule. Higher sensitivity makes the app progressively more willing to remove compatible layer boundaries."
					>
						ⓘ
					</button>
				</span>
			</label>
			<div id="smartMergeControls" class="field">
				<span class="field__label">Sensitivity:</span>
				<div class="field__row">
					<input
						class="range"
						type="range"
						id="smartMergeSensR"
						min="0"
						max="6"
						step="0.05"
						value="1.10"
						oninput={(event) =>
							call(
								'setSmartMergeSensitivity',
								+(event.currentTarget as HTMLInputElement).value,
								false
							)}
					/>
					<input
						class="input input--num"
						type="number"
						id="smartMergeSensN"
						min="0"
						max="6"
						step="0.05"
						value="1.10"
						oninput={(event) =>
							call(
								'setSmartMergeSensitivity',
								+(event.currentTarget as HTMLInputElement).value,
								true
							)}
					/>
				</div>
			</div>
			<div class="field">
				<span class="field__label">Minimum layer thickness:</span>
				<div class="field__row">
					<input
						class="range"
						type="range"
						id="minThkR"
						min="0.05"
						max="2.0"
						step="0.05"
						value="0.50"
						oninput={(event) =>
							call('setMinThk', +(event.currentTarget as HTMLInputElement).value, false)}
					/>
					<input
						class="input input--num"
						type="number"
						id="minThkN"
						min="0.05"
						max="2.0"
						step="0.05"
						value="0.50"
						oninput={(event) =>
							call('setMinThk', +(event.currentTarget as HTMLInputElement).value, true)}
					/>
					<span class="field__unit">m</span>
					<span id="minThkInfo" class="field__hint"></span>
				</div>
			</div>
			<div id="assumedRfCtrl" style="display:none">
				<div class="field">
					<span class="field__label">
						Assumed R<sub>f</sub> (%):
						<button
							type="button"
							class="st6-tip"
							data-tip="This CPT contains readings without measured sleeve friction (fs). All classification methods use this assumed friction ratio for those readings. 3% is a neutral mid-range default — lower it toward 1% for known sandy profiles, raise it toward 4–6% for known clayey profiles."
							aria-label="This CPT contains readings without measured sleeve friction (fs). All classification methods use this assumed friction ratio for those readings. 3% is a neutral mid-range default — lower it toward 1% for known sandy profiles, raise it toward 4–6% for known clayey profiles."
						>
							ⓘ
						</button>
					</span>
					<div class="field__row">
						<input
							class="input input--num"
							type="number"
							id="assumedRfN"
							min="0.1"
							max="10"
							step="0.1"
							value="3.0"
							onchange={(event) =>
								call('setAssumedRf', +(event.currentTarget as HTMLInputElement).value)}
						/>
					</div>
				</div>
			</div>
		</div>

		<div id="classAssumedRfNote"></div>

		<div class="class-layout" id="classLayout" style="display:none">
			<div class="stack">
				<div class="stats stats--dense" id="cmet"></div>
				<div>
					<div class="eyebrow" style="margin-bottom:var(--sp-2)">Preview — first 25 classified rows</div>
					<div class="tbl-wrap" style="--tbl-wrap-max:20rem">
						<table class="tbl">
							<thead>
								<tr>
									<th class="num">depth (m)</th>
									<th class="num">TAW (m)</th>
									<th class="num">qc (MPa)</th>
									<th class="num">fs (kPa)</th>
									<th class="num">Rf (%)</th>
									<th>Soil type</th>
									<th>Sub-type</th>
									<th class="num" id="cmetricHead">Metric</th>
								</tr>
							</thead>
							<tbody id="cbody"></tbody>
						</table>
					</div>
				</div>
			</div>
			<div class="viz">
				<div class="viz__title">Layer preview</div>
				<div class="preview-wrap">
					<svg id="layerPreviewSvg" viewBox="0 0 240 520"></svg>
					<div id="layerPreviewTip" class="section-tip"></div>
				</div>
			</div>
		</div>

		<div class="panel__foot">
			<button class="btn" onclick={() => call('goS', 0)}>← Back</button>
			<button class="btn btn--primary" onclick={() => call('runClass')}>Apply classification →</button>
			<button class="btn" id="btnToLayers" onclick={() => call('goS', 2)} style="display:none">
				Review layers →
			</button>
		</div>
	</div>
</div>
