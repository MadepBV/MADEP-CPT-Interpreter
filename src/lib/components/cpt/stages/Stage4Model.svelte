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
		<button class="btn sm" onclick={() => call('exportCSV')}>Export CSV</button>
	</div>
	<div class="ctrl-row" style="margin-bottom:16px;flex-wrap:wrap;gap:16px">
		<div style="display:flex;align-items:center;gap:8px">
			<span class="ctrl-lbl" style="white-space:nowrap">α-method:</span>
			<div style="display:flex;border:1px solid var(--bd2);border-radius:var(--r);overflow:hidden">
				<button id="btnAlphaA" class="togbtn" onclick={() => call('setAlphaMethod', 'A')}>
					A — Sanglerat (fixed)
				</button>
				<button id="btnAlphaB" class="togbtn active" onclick={() => call('setAlphaMethod', 'B')}>
					B — SB260 qc-dependent
				</button>
			</div>
		</div>
		<div style="display:flex;align-items:center;gap:8px">
			<span class="ctrl-lbl" style="white-space:nowrap">Stiffness method:</span>
			<div style="display:flex;border:1px solid var(--bd2);border-radius:var(--r);overflow:hidden">
				<button id="btnStiffA" class="togbtn" onclick={() => call('setStiffMethod', 'A')}>
					A — CUR 2003-7 ratios
				</button>
				<button id="btnStiffB" class="togbtn active" onclick={() => call('setStiffMethod', 'B')}>
					B — E₅₀ = E_oed
				</button>
			</div>
		</div>
	</div>
	<div id="ma"></div>
	<div class="foot">
		<button class="btn" onclick={() => call('goS', 2)}>← Back</button>
		<span style="font-size:12px;color:var(--tx2)"
			>Review m-values. Use Tuning (Stage 5) to fit m from CPT data.</span
		>
		<button class="btn" onclick={() => call('goS', 4)} style="border-color:var(--wn);color:var(--wn)">
			Stage 5 — Tuning ⚗
		</button>
	</div>
</div>
