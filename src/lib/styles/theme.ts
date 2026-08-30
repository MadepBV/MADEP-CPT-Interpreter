// SPDX-License-Identifier: AGPL-3.0-or-later
// src/lib/styles/theme.ts — token resolver for canvases + theme switch (worklog/refactor/02-design-system.md §3.14).
//
// `getComputedStyle(root).getPropertyValue('--x')` returns a custom property *unresolved* when it
// holds `color-mix()` / `light-dark()`; CanvasRenderingContext2D cannot parse that. Reading the
// token through a probe element's `color` resolves any token form to an `rgb()` string.
// The module is SSR-safe: probes are created lazily on first use in a browser.
//
// ONE PROBE PER TOKEN (PR 15). A single shared probe whose `color` is rewritten per lookup is wrong:
// inside one task Chromium serves `getComputedStyle().color` from the *previous* style recalc, so a
// batch read (vizTheme() resolves ~20 tokens in a row) returns the same stale colour for every name —
// which painted the whole retaining section in one hue. Writing `color` once, on a freshly attached
// element, always resolves correctly, so every name gets its own probe and the set is dropped on a
// theme change (the values behind the probes have changed; fresh elements re-resolve).

export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'madep-theme';
export const THEME_EVENT = 'madep:theme';

const probes = new Map<string, HTMLSpanElement>();

const PROBE_CSS = 'position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;overflow:hidden';

function dropProbes(): void {
	for (const el of probes.values()) el.remove();
	probes.clear();
}

/** Resolves a token (`--viz-1`, `--glass-bg`, …) to an `rgb()` / `rgba()` string usable by canvas + SVG. */
export function token(name: string): string {
	try {
		if (typeof document === 'undefined' || !document.body) return '';
		let el = probes.get(name);
		if (!el || !el.isConnected) {
			el = document.createElement('span');
			el.setAttribute('aria-hidden', 'true');
			el.style.cssText = `${PROBE_CSS};color:var(${name})`;
			document.body.append(el);
			probes.set(name, el);
		}
		const c = getComputedStyle(el)?.color;
		return typeof c === 'string' ? c : '';
	} catch {
		return '';   // no real DOM (Node verifiers, SSR): callers fall back to the literal palette
	}
}

/**
 * Light-theme literals of tokens.css, used when a token cannot be resolved (no DOM: Node verifiers,
 * golden suites, SSR). Same `rgb()` form the browser returns, so `withAlpha()` works on both.
 */
const FALLBACK: Record<string, string> = {
	'--viz-1': 'rgb(61, 107, 106)', '--viz-2': 'rgb(24, 24, 26)', '--viz-3': 'rgb(138, 98, 13)', '--viz-4': 'rgb(155, 58, 50)',
	'--viz-5': 'rgb(60, 111, 151)', '--viz-6': 'rgb(111, 143, 100)', '--viz-neutral': 'rgb(109, 105, 98)',
	'--viz-grid': 'rgba(24, 24, 26, 0.08)', '--viz-grid-strong': 'rgba(24, 24, 26, 0.16)', '--viz-axis': 'rgba(24, 24, 26, 0.55)',
	'--viz-text': 'rgb(24, 24, 26)', '--viz-text-muted': 'rgb(74, 74, 82)', '--viz-halo': 'rgba(255, 255, 255, 0.92)',
	'--viz-band': 'rgba(24, 24, 26, 0.05)', '--viz-tooltip-bg': 'rgba(255, 255, 255, 0.96)',
	'--canvas-paper': 'rgb(251, 249, 245)', '--canvas-grid': 'rgba(24, 24, 26, 0.05)',
	'--viz-water': 'rgb(60, 111, 151)', '--viz-water-soft': 'rgba(60, 111, 151, 0.1)'
};
const tok = (name: string) => token(name) || FALLBACK[name] || '';

/** The data-viz palette, resolved for the current theme (§3.13 series assignment). */
export function vizTheme() {
	return {
		s1: tok('--viz-1'),
		s2: tok('--viz-2'),
		s3: tok('--viz-3'),
		s4: tok('--viz-4'),
		s5: tok('--viz-5'),
		s6: tok('--viz-6'),
		neutral: tok('--viz-neutral'),
		grid: tok('--viz-grid'),
		gridStrong: tok('--viz-grid-strong'),
		axis: tok('--viz-axis'),
		text: tok('--viz-text'),
		textMuted: tok('--viz-text-muted'),
		halo: tok('--viz-halo'),
		band: tok('--viz-band'),
		tooltipBg: tok('--viz-tooltip-bg'),
		paper: tok('--canvas-paper'),
		paperGrid: tok('--canvas-grid'),
		water: tok('--viz-water'),
		waterSoft: tok('--viz-water-soft')
	};
}

export type VizTheme = ReturnType<typeof vizTheme>;

/**
 * `rgba()` of a resolved token with the alpha replaced — for soft fills / muted series on canvases
 * (`token()` returns `rgb(r, g, b)` or `rgba(r, g, b, a)`). Any other colour form is returned unchanged.
 */
export function withAlpha(color: string, alpha: number): string {
	const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(color);
	if (!m) return color;
	return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
}

/**
 * The Stage 6 pile-app series (§3.13): the De Beer chain, the per-layer shaft status and the load /
 * settlement lines, resolved for the current theme. chart-factories.js still ships the legacy literal
 * rgba() set; pile/charts.js recolours the datasets with this map before Chart.js reads the config.
 */
export function pileVizSeries() {
	const t = vizTheme();
	return {
		qc: t.neutral,                        // cone resistance — the input, neutral
		qh: t.s2,                             // homogeneous — ink, dashed
		qd: t.s3,                             // downward — ochre
		qu: t.s5,                             // upward — slate
		qp: t.s6,                             // mixed (the result) — moss
		toe: t.s4,                            // pile toe marker — limit
		excluded: withAlpha(t.neutral, 0.6),  // shaft rows outside the shaft / peat
		aboveNeutral: t.s3,                   // downdrag zone — same family as the neutral plane
		contributing: t.s6,                   // positive friction — accepted
		curve: t.s1,                          // load–settlement, N(z)
		curveSoft: withAlpha(t.s1, 0.12),
		frep: t.s2,                           // representative load — ink, dashed
		rcd: t.s4,                            // design resistance — limit
		sAllow: t.s3                          // allowable settlement — warning
	};
}

/**
 * The Stage 6 retaining-wall series (§3.13 "Pile/retaining canvases"), resolved for the current theme:
 * the pressure / shear / moment diagrams, the drivability envelopes and the vibration curves of
 * retaining/retaining-charts.js, and the section canvas (retaining-canvas.js maps the literal palette
 * of the pure, golden-locked scenes/*.js onto these roles at paint time).
 */
export function retainingVizSeries() {
	const t = vizTheme();
	return {
		// ── structure ───────────────────────────────────────────────────────────
		wall: t.s2,                            // sheet / soldier pile outline — ink (§3.13 "wall --viz-2")
		wallFill: withAlpha(t.neutral, 0.55),  // steel body — warm grey, the legacy #8a8f98 role
		lagging: withAlpha(t.neutral, 0.28),
		concrete: withAlpha(t.neutral, 0.35),  // gravity / cantilever stem + base
		concreteStroke: t.neutral,
		// ── ground, water and pressures ─────────────────────────────────────────
		retained: t.s4,                        // earth + q on the retained side — the load
		retainedSoft: withAlpha(t.s4, 0.10),
		retainedFill: withAlpha(t.s4, 0.16),
		passive: t.s6,                         // excavation-side resistance — accepted
		passiveSoft: withAlpha(t.s6, 0.10),
		passiveWedge: withAlpha(t.s6, 0.16),
		passiveFill: withAlpha(t.s6, 0.14),
		overdig: withAlpha(t.s4, 0.10),        // over-excavation band
		overdigLine: withAlpha(t.s4, 0.35),
		berm: withAlpha(t.s3, 0.45),           // retained berm / backfill — ochre
		bermHatch: withAlpha(t.s3, 0.30),
		bermLine: withAlpha(t.s3, 0.50),
		water: t.water,
		waterFront: withAlpha(t.water, 0.6),
		net: t.s2,                             // factored net pressure — ink
		shear: t.s3,                           // V — ochre
		shearSoft: withAlpha(t.s3, 0.10),
		shearFill: withAlpha(t.s3, 0.16),
		moment: t.s1,                          // M — teal (was the purple of the legacy palette)
		momentSoft: withAlpha(t.s1, 0.12),
		momentFill: withAlpha(t.s1, 0.16),
		load: t.s3,                            // surcharge arrows
		anchor: t.s2,                          // tendon + head plate — ink
		anchorGrout: t.s3,                     // grout body (§3.13 "anchors --viz-3")
		// ── annotation ──────────────────────────────────────────────────────────
		dim: t.neutral,                        // dimension lines
		excavation: t.s4,                      // design-excavation marker
		closure: t.s6,                         // free-earth closure marker
		target: t.neutral,                     // target toe depth
		handle: t.s1,                          // drag handles (§3.13 "handles --viz-1")
		bad: t.s4, warn: t.s3, good: t.s6,     // drivability outcome markers on the section
		// ── drivability / vibration charts ──────────────────────────────────────
		refusal: t.s4, marginal: t.s3, reaches: t.s6,
		machine: t.s1,                         // the candidate / chosen machine
		required: t.s4, required125: t.s3,     // F_c,min at m_R 1.0 / 1.25
		drive: t.s6, staticRef: t.neutral,     // R_drive / R_static
		zero: t.s2,
		blows: t.s4, blowsSoft: withAlpha(t.s4, 0.10), stress: t.s3, capacity: t.s6,
		p50: t.s6, p5: t.s3, startup: t.s4, impact: t.s4,   // PPV curves
		fit: t.s2, measurements: t.s2,
		characteristic: t.s1, limit: t.s4, warning: t.s3,
		// ── paper, ink and hatching shared with vizTheme() ──────────────────────
		paper: t.paper, halo: t.halo, text: t.text, textMuted: t.textMuted, axis: t.axis, gridStrong: t.gridStrong,
		hatch: withAlpha(t.axis, 0.25),        // soil-band hatching
		soilLine: withAlpha(t.axis, 0.18)      // soil-band outline
	};
}

/** Stored choice ('system' when nothing is stored). */
export function getTheme(): ThemeChoice {
	if (typeof localStorage === 'undefined') return 'system';
	try {
		const v = localStorage.getItem(THEME_STORAGE_KEY);
		return v === 'light' || v === 'dark' ? v : 'system';
	} catch {
		return 'system';
	}
}

/** Whether the document currently renders dark (explicit choice or OS preference). */
export function isDark(): boolean {
	if (typeof document === 'undefined') return false;
	const forced = document.documentElement.dataset.theme;
	if (forced === 'dark') return true;
	if (forced === 'light') return false;
	return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Sets the theme: `data-theme` on <html> (tokens.css redefines under `[data-theme="dark"]` and
 * `:not([data-theme="light"])`), persists the choice, and emits `madep:theme` so canvases re-read tokens.
 * The same key is read by the pre-paint script in src/app.html.
 */
export function setTheme(t: ThemeChoice): void {
	if (typeof document === 'undefined') return;
	if (t === 'system') delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = t;
	try {
		if (t === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
		else localStorage.setItem(THEME_STORAGE_KEY, t);
	} catch {
		/* private mode / storage disabled — the attribute still applies for this session */
	}
	window.dispatchEvent(new CustomEvent(THEME_EVENT));
}

/** Subscribe to theme changes (explicit toggle or OS change). Returns the unsubscribe function. */
export function onThemeChange(fn: () => void): () => void {
	if (typeof window === 'undefined') return () => {};
	window.addEventListener(THEME_EVENT, fn);
	return () => window.removeEventListener(THEME_EVENT, fn);
}

// OS preference changes reach the same subscribers as the in-app toggle.
if (typeof window !== 'undefined' && typeof matchMedia === 'function') {
	matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
		window.dispatchEvent(new CustomEvent(THEME_EVENT));
	});
}

// The probes hold the *old* theme's colours after a switch; drop them first, so every subscriber that
// re-reads tokens in its `madep:theme` handler resolves against fresh elements (see `token()` above).
if (typeof window !== 'undefined') window.addEventListener(THEME_EVENT, dropProbes, true);

// Phase 2 boot probe (§4.1): ~300 ms of rAF while a test glass element animates; < 45 fps →
// document.documentElement.dataset.transparency = 'reduce'. Not wired in phase 1 (no glass class is
// on a live surface yet).
