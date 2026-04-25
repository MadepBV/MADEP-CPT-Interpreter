<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import { call } from '$lib/cpt-app/ui';
</script>

<div class="panel active" id="p0">
	<div class="sec">
		<div>
			<div class="sec-title">Load CPT — GEF, Excel or CSV file</div>
			<div class="sec-sub">
				Belgian/Dutch GEF, Excel workbooks with Header/Data sheets, or a CSV with depth and
				qc columns. GEF quantity IDs: 1=depth, 2=qc, 3=fs, 4=Rf, 6=u2.
			</div>
		</div>
	</div>
	<div
		class="dz"
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
		<div style="font-size:28px;margin-bottom:10px">📂</div>
		<div style="font-size:14px;font-weight:600;margin-bottom:4px">
			Drop one or more .GEF, .XLS, .XLSX or .CSV files here or click to browse
		</div>
		<div style="font-size:12px;color:var(--tx2)">
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
	<div style="margin-top:10px;text-align:center">
		<span style="font-size:12px;color:var(--tx2)">No file?&nbsp;</span>
		<button class="btn sm" onclick={() => call('loadDemo')}>Load demo — anonymous profile</button>
	</div>

	<div id="s1body" style="display:none">
		<div class="mgrid" id="mgrid"></div>

		<div class="ctrl-row" id="ctrlRow" style="flex-wrap:wrap;row-gap:8px">
			<span class="ctrl-lbl">Surface elev. (m TAW):</span>
			<input
				class="ctrl-num"
				type="number"
				id="elevN"
				step="0.01"
				placeholder="e.g. 69.97"
				oninput={(event) => call('setElev', +(event.currentTarget as HTMLInputElement).value)}
				style="width:88px"
			/>
			<span id="elev-src" style="font-size:11px;color:var(--tx3)"></span>

			<div class="ctrl-sep"></div>

			<span class="ctrl-lbl">Water table (m below surface):</span>
			<input
				type="range"
				id="wtR"
				min="0"
				max="15"
				step="0.05"
				value="1.7"
				style="width:120px"
				oninput={(event) =>
					call('setWT', +(event.currentTarget as HTMLInputElement).value, false)}
			/>
			<input
				class="ctrl-num"
				type="number"
				id="wtN"
				min="0"
				max="30"
				step="0.05"
				value="1.7"
				oninput={(event) =>
					call('setWT', +(event.currentTarget as HTMLInputElement).value, true)}
			/>
			<span style="font-size:12px;color:var(--tx2)">m</span>
			<span id="wt-taw" style="font-size:11px;color:var(--tx3)"></span>
			<span id="wt-src" style="font-size:11px;color:var(--tx3)"></span>

			<div style="width:100%;height:0;flex-basis:100%"></div>
			<span class="ctrl-lbl">Coördinaten (m):</span>
			<span style="font-size:12px;color:var(--tx2)">X</span>
			<input
				class="ctrl-num"
				type="number"
				id="cptX"
				step="0.1"
				placeholder="easting"
				style="width:96px"
				oninput={(event) => call('setCptCoord', 'x', (event.currentTarget as HTMLInputElement).value)}
			/>
			<span style="font-size:12px;color:var(--tx2)">Y</span>
			<input
				class="ctrl-num"
				type="number"
				id="cptY"
				step="0.1"
				placeholder="northing"
				style="width:96px"
				oninput={(event) => call('setCptCoord', 'y', (event.currentTarget as HTMLInputElement).value)}
			/>
			<span style="font-size:11px;color:var(--tx3)"
				>Lokaal stelsel of RD — voor cross-sectie correlatie</span
			>
		</div>

		<div class="chart-area" id="chartArea">
			<div class="col-card">
				<div class="ct">layers</div>
				<svg id="layerColSvg" viewBox="0 0 60 400"></svg>
			</div>
			<div class="cc">
				<div class="ct">qc (MPa)</div>
				<div style="position:relative;height:380px">
					<canvas id="cQc" aria-label="qc vs depth">qc profile</canvas>
				</div>
			</div>
			<div class="cc">
				<div class="ct">fs (kPa)</div>
				<div style="position:relative;height:380px">
					<canvas id="cFs" aria-label="fs vs depth">fs profile</canvas>
				</div>
			</div>
			<div class="cc">
				<div class="ct">Rf (%)</div>
				<div style="position:relative;height:380px">
					<canvas id="cRf" aria-label="Rf vs depth">Rf profile</canvas>
				</div>
			</div>
		</div>

		<div class="foot">
			<span id="finfo" style="font-size:12px;color:var(--tx2)"></span>
			<button class="btn pri" onclick={() => call('goS', 1)}>Next: Classification →</button>
		</div>
	</div>
</div>
