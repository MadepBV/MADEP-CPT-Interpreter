<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import { call } from '$lib/cpt-app/ui';
</script>

<div class="panel" id="p1">
	<div class="sec">
		<div>
			<div class="sec-title">Classification method</div>
			<div class="sec-sub">
				Choose a method, set minimum layer thickness, then click Apply. Robertson 2016 is the
				recommended default for most projects in the current app.
			</div>
		</div>
	</div>
	<div class="mcards stage2-methods">
		<div
			class="mc stage2-method-card"
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
			<h3>Robertson (1990) — SBT / Ic</h3>
			<p>Normalised Qt and Fr. Stress-dependent — accounts for depth.</p>
		</div>
		<div
			class="mc stage2-method-card sel"
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
			<h3>Robertson (2016) — SBT / Qtn <span style="color:var(--ac)">Recommended</span></h3>
			<p>
				Iterative Qtn and Fr. Preferred default; may be especially useful when the input is a CPTu; still works when
				u2 is absent.
			</p>
		</div>
		<div
			class="mc stage2-method-card"
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
			<h3>CUR 3 layers</h3>
			<p>
				Broad practical layering chart using direct qc and Rf. Produces Sand, Silt, Clay,
				and Peat zones for layer generation.
			</p>
		</div>
		<div
			class="mc stage2-method-card"
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
			<h3>NEN 6740</h3>
			<p>
				Stress-dependent q<sub>c,NEN</sub> and friction ratio. Uses the 14-area NEN material
				chart for more detailed CPT interpretation.
			</p>
		</div>
		<div
			class="mc stage2-method-card"
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
			<h3>NEN Tabel 3</h3>
			<p>
				Direct subtype table from q<sub>c</sub> and R<sub>f</sub>. Fine-grained route that
				often aligns well with later parameter assignment.
			</p>
		</div>
	</div>

	<div class="ctrl-row" style="margin-top:14px">
		<label
			style="display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--tx2);cursor:pointer"
		>
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
		<div
			id="smartMergeControls"
			style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"
		>
			<span class="ctrl-lbl" style="font-size:12px">Sensitivity:</span>
			<input
				type="range"
				id="smartMergeSensR"
				min="0"
				max="6"
				step="0.05"
				value="1.10"
				style="width:120px"
				oninput={(event) =>
					call(
						'setSmartMergeSensitivity',
						+(event.currentTarget as HTMLInputElement).value,
						false
					)}
			/>
			<input
				class="ctrl-num"
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
		<div class="ctrl-sep"></div>
		<span class="ctrl-lbl">Minimum layer thickness:</span>
		<input
			type="range"
			id="minThkR"
			min="0.05"
			max="2.0"
			step="0.05"
			value="0.50"
			style="width:140px"
			oninput={(event) =>
				call('setMinThk', +(event.currentTarget as HTMLInputElement).value, false)}
		/>
		<input
			class="ctrl-num"
			type="number"
			id="minThkN"
			min="0.05"
			max="2.0"
			step="0.05"
			value="0.50"
			oninput={(event) =>
				call('setMinThk', +(event.currentTarget as HTMLInputElement).value, true)}
		/>
		<span style="font-size:12px;color:var(--tx2)">m</span>
		<span id="minThkInfo" style="font-size:11px;color:var(--tx3)"></span>
		<div
			id="assumedRfCtrl"
			style="display:none;align-items:center;gap:8px;flex-wrap:wrap"
		>
			<div class="ctrl-sep"></div>
			<span class="ctrl-lbl" style="display:inline-flex;align-items:center;gap:4px">
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
			<input
				class="ctrl-num"
				type="number"
				id="assumedRfN"
				min="0.1"
				max="10"
				step="0.1"
				value="3.0"
				style="width:70px"
				onchange={(event) =>
					call('setAssumedRf', +(event.currentTarget as HTMLInputElement).value)}
			/>
		</div>
	</div>

	<div id="classAssumedRfNote"></div>

	<div class="class-layout" id="classLayout" style="display:none">
		<div>
			<div class="mrow" id="cmet"></div>
			<div
				style="margin-top:14px;font-size:11px;font-weight:600;color:var(--tx2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px"
			>
				Preview — first 25 classified rows
			</div>
			<div
				style="overflow-x:auto;max-height:320px;overflow-y:auto;border:1px solid var(--bd);border-radius:var(--r)"
			>
				<table class="tbl" style="margin-top:0">
					<thead style="position:sticky;top:0;background:var(--bg);z-index:2">
						<tr>
							<th>depth (m)</th>
							<th>TAW (m)</th>
							<th>qc (MPa)</th>
							<th>fs (kPa)</th>
							<th>Rf (%)</th>
							<th>Soil type</th>
							<th>Sub-type</th>
							<th id="cmetricHead">Metric</th>
						</tr>
					</thead>
					<tbody id="cbody"></tbody>
				</table>
			</div>
		</div>
		<div>
			<div class="ct" style="margin-bottom:8px">Layer preview</div>
			<div class="preview-wrap">
				<svg
					id="layerPreviewSvg"
					viewBox="0 0 240 520"
					style="width:100%;border:1px solid var(--bd);border-radius:var(--r)"
				></svg>
				<div id="layerPreviewTip" class="section-tip"></div>
			</div>
		</div>
	</div>

	<div class="foot">
		<button class="btn" onclick={() => call('goS', 0)}>← Back</button>
		<button class="btn pri" onclick={() => call('runClass')}>Apply classification →</button>
		<button class="btn" id="btnToLayers" onclick={() => call('goS', 2)} style="display:none">
			Review layers →
		</button>
	</div>
</div>
