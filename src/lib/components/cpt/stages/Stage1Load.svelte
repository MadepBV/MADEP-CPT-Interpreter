<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import { call } from '$lib/cpt-app/ui';
</script>

<div class="panel active" id="p0">
	<div class="panel__head">
		<div>
			<div class="panel__title">Load CPT — GEF, Excel or CSV file</div>
			<div class="panel__sub">
				Belgian/Dutch GEF, Excel workbooks with Header/Data sheets, or a CSV with depth and
				qc columns. GEF quantity IDs: 1=depth, 2=qc, 3=fs, 4=Rf, 6=u2.
			</div>
		</div>
	</div>
	<div class="panel__body">
		<div
			class="empty dz"
			id="dz"
			role="button"
			tabindex="0"
			onclick={() => (document.getElementById('fi') as HTMLInputElement | null)?.click()}
			onkeydown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					(document.getElementById('fi') as HTMLInputElement | null)?.click();
				}
			}}
		>
			<svg class="empty__icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
				<path d="M4 7.5h5.2l1.5 2H20v8.5H4V7.5Z" />
				<path d="M4 9.5V6h4.3l1.6 1.5" />
				<path d="M12 12.5v4" />
				<path d="m10.3 14.2 1.7-1.7 1.7 1.7" />
			</svg>
			<div class="empty__title">
				Drop one or more .GEF, .XLS, .XLSX or .CSV files here or click to browse
			</div>
			<div class="empty__text">
				Select multiple files at once to create multiple CPT tabs. GEF column order comes from
				COLUMNINFO; Excel and CSV columns are detected from their headers.
			</div>
		</div>
		<input
			type="file"
			id="fi"
			accept=".gef,.GEF,.txt,.csv,.CSV,.xls,.XLS,.xlsx,.XLSX,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
			style="display:none"
			onchange={(event) => call('loadGEF', event)}
			multiple
		/>
		<div class="load-demo-row">
			<span class="field__hint">No file?&nbsp;</span>
			<button class="btn btn--sm" onclick={() => call('loadDemo')}>Load demo — anonymous profile</button>
		</div>

		<div id="s1body" class="stack" style="display:none">
			<div class="stats stats--meta" id="mgrid"></div>

			<div class="fields" id="ctrlRow">
				<div class="field">
					<span class="field__label">Surface elev. (m TAW):</span>
					<div class="field__row">
						<input
							class="input input--num"
							type="number"
							id="elevN"
							step="0.01"
							placeholder="e.g. 69.97"
							oninput={(event) => call('setElev', +(event.currentTarget as HTMLInputElement).value)}
						/>
						<span id="elev-src" class="field__hint"></span>
					</div>
				</div>

				<div class="field">
					<span class="field__label">Water table (m below surface):</span>
					<div class="field__row">
						<input
							class="range"
							type="range"
							id="wtR"
							min="0"
							max="15"
							step="0.05"
							value="1.7"
							oninput={(event) =>
								call('setWT', +(event.currentTarget as HTMLInputElement).value, false)}
						/>
						<input
							class="input input--num"
							type="number"
							id="wtN"
							min="0"
							max="30"
							step="0.05"
							value="1.7"
							oninput={(event) =>
								call('setWT', +(event.currentTarget as HTMLInputElement).value, true)}
						/>
						<span class="field__unit">m</span>
						<span id="wt-taw" class="field__hint"></span>
						<span id="wt-src" class="field__hint"></span>
					</div>
				</div>

				<div class="field">
					<span class="field__label">Coördinaten (m):</span>
					<div class="field__row">
						<span class="field__unit">X</span>
						<input
							class="input input--num"
							type="number"
							id="cptX"
							step="0.1"
							placeholder="easting"
							oninput={(event) => call('setCptCoord', 'x', (event.currentTarget as HTMLInputElement).value)}
						/>
						<span class="field__unit">Y</span>
						<input
							class="input input--num"
							type="number"
							id="cptY"
							step="0.1"
							placeholder="northing"
							oninput={(event) => call('setCptCoord', 'y', (event.currentTarget as HTMLInputElement).value)}
						/>
						<span class="field__hint">Lokaal stelsel of RD — voor cross-sectie correlatie</span>
					</div>
				</div>
			</div>

			<div class="chart-area" id="chartArea">
				<div class="viz">
					<div class="viz__title">layers</div>
					<svg id="layerColSvg" viewBox="0 0 60 400"></svg>
				</div>
				<div class="viz">
					<div class="viz__title">qc (MPa)</div>
					<div style="position:relative;height:380px">
						<canvas id="cQc" aria-label="qc vs depth">qc profile</canvas>
					</div>
				</div>
				<div class="viz">
					<div class="viz__title">fs (kPa)</div>
					<div style="position:relative;height:380px">
						<canvas id="cFs" aria-label="fs vs depth">fs profile</canvas>
					</div>
				</div>
				<div class="viz">
					<div class="viz__title">Rf (%)</div>
					<div style="position:relative;height:380px">
						<canvas id="cRf" aria-label="Rf vs depth">Rf profile</canvas>
					</div>
				</div>
			</div>

			<div class="panel__foot">
				<span id="finfo" class="panel__foot__note"></span>
				<button class="btn btn--primary" onclick={() => call('goS', 1)}>Next: Classification →</button>
			</div>
		</div>
	</div>
</div>
