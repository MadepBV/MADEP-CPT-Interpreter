<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import { call } from '$lib/cpt-app/ui';
</script>

<div class="panel" id="p3">
	<div class="sec">
		<div>
			<div class="sec-title">Model parameters</div>
			<div class="sec-sub">
				Mohr-Coulomb and Hardening Soil (p_ref = 100 kPa). Eoed,i = αE × qc (Sanglerat /
				SB260). Review m and Eoed,ref per layer.
			</div>
		</div>
		<div style="display:flex;gap:8px;flex-wrap:wrap">
			<button class="btn sm" onclick={() => call('exportPlaxisCommands')}>
				Export PLAXIS Commands
			</button>
			<button class="btn sm" onclick={() => call('exportCSV')}>Export CSV</button>
		</div>
	</div>
	<div class="ctrl-row" style="margin-bottom:16px;flex-wrap:wrap;gap:14px">
		<div style="display:flex;align-items:center;gap:8px">
			<span class="ctrl-lbl" style="white-space:nowrap">α-method:</span>
			<div style="display:flex;border:1px solid var(--bd2);border-radius:var(--r);overflow:hidden">
				<button
					id="btnAlphaA"
					class="togbtn"
					onclick={() => call('setAlphaMethod', 'A')}
					title="Sanglerat — fixed α per behavioural soil type, applied uniformly across the layer. Conservative default."
				>
					A — Sanglerat
				</button>
				<button
					id="btnAlphaB"
					class="togbtn active"
					onclick={() => call('setAlphaMethod', 'B')}
					title="SB260 qc-dependent — α varies with qc within the layer following the SB260 family rules. More representative when qc spans multiple ranges."
				>
					B — SB260 q_c
				</button>
			</div>
		</div>
		<div style="display:flex;align-items:center;gap:8px">
			<span class="ctrl-lbl" style="white-space:nowrap">Stiffness:</span>
			<div style="display:flex;border:1px solid var(--bd2);border-radius:var(--r);overflow:hidden">
				<button
					id="btnStiffA"
					class="togbtn"
					onclick={() => call('setStiffMethod', 'A')}
					title="CUR 2003-7 ratios — granular: E₅₀,ref = E_oed,ref; cohesive (klei en leem incl. Sandy clay): E₅₀,ref = 1.25·E_oed,ref; E_ur,ref = 3·E₅₀,ref."
				>
					A — CUR 2003-7
				</button>
				<button
					id="btnStiffB"
					class="togbtn active"
					onclick={() => call('setStiffMethod', 'B')}
					title="E₅₀,ref = E_oed,ref for all soils; E_ur,ref = 3·E_oed,ref. Single consistent reference stiffness."
				>
					B — E₅₀ = E_oed
				</button>
			</div>
		</div>
		<div style="display:flex;align-items:center;gap:8px">
			<span class="ctrl-lbl" style="white-space:nowrap">k_h/k_v:</span>
			<div style="display:flex;border:1px solid var(--bd2);border-radius:var(--r);overflow:hidden">
				<button
					id="btnKhKvA"
					class="togbtn active"
					onclick={() => call('setKhKvMethod', 'A')}
					title="OVAM / I/RA/11461 (Belgian engineering practice). Conservative anisotropy: clean sand and gravel k_h/k_v = 1; fine/silty sand grouped with fine soils → k_h/k_v = 3; clay, sandy clay (leem), and peat → k_h/k_v = 3. Default."
				>
					A — OVAM
				</button>
				<button
					id="btnKhKvB"
					class="togbtn"
					onclick={() => call('setKhKvMethod', 'B')}
					title="Bear (1979) Hydraulics of Groundwater — academic literature-typical anisotropy with an intermediate value for silty / fine sand: clean sand and gravel k_h/k_v = 1; silty sand → k_h/k_v = 2; clay, sandy clay (leem), and peat → k_h/k_v = 3."
				>
					B — Bear (1979)
				</button>
			</div>
		</div>
	</div>
	<div id="ma"></div>
	<div class="foot">
		<button class="btn" onclick={() => call('goS', 2)}>← Back</button>
		<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
			<span style="font-size:12px;color:var(--tx2)"
				>Review m-values. Use Tuning (Stage 5) to fit m from CPT data.</span
			>
			<button class="btn sm" onclick={() => call('openStage7Report')}>Stage 7 Report</button>
		</div>
		<button class="btn" onclick={() => call('goS', 4)} style="border-color:var(--wn);color:var(--wn)">
			Stage 5 — Tuning ⚗
		</button>
	</div>
</div>
