// SPDX-License-Identifier: AGPL-3.0-or-later
// src/lib/styles/theme.ts — token resolver for canvases + theme switch (worklog/refactor/02-design-system.md §3.14).
//
// `getComputedStyle(root).getPropertyValue('--x')` returns a custom property *unresolved* when it
// holds `color-mix()` / `light-dark()`; CanvasRenderingContext2D cannot parse that. Reading the
// token through a probe element's `color` resolves any token form to an `rgb()` string.
// The module is SSR-safe: the probe is created lazily on first use in a browser.

export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'madep-theme';
export const THEME_EVENT = 'madep:theme';

let probe: HTMLSpanElement | null = null;

function getProbe(): HTMLSpanElement | null {
	if (typeof document === 'undefined') return null;
	if (probe && probe.isConnected) return probe;
	probe = document.createElement('span');
	probe.setAttribute('aria-hidden', 'true');
	probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;overflow:hidden';
	document.body.append(probe);
	return probe;
}

/** Resolves a token (`--viz-1`, `--glass-bg`, …) to an `rgb()` / `rgba()` string usable by canvas + SVG. */
export function token(name: string): string {
	const el = getProbe();
	if (!el) return '';
	el.style.color = `var(${name})`;
	return getComputedStyle(el).color;
}

/** The data-viz palette, resolved for the current theme (§3.13 series assignment). */
export function vizTheme() {
	return {
		s1: token('--viz-1'),
		s2: token('--viz-2'),
		s3: token('--viz-3'),
		s4: token('--viz-4'),
		s5: token('--viz-5'),
		s6: token('--viz-6'),
		neutral: token('--viz-neutral'),
		grid: token('--viz-grid'),
		gridStrong: token('--viz-grid-strong'),
		axis: token('--viz-axis'),
		text: token('--viz-text'),
		textMuted: token('--viz-text-muted'),
		halo: token('--viz-halo'),
		band: token('--viz-band'),
		tooltipBg: token('--viz-tooltip-bg'),
		paper: token('--canvas-paper'),
		paperGrid: token('--canvas-grid'),
		water: token('--viz-water'),
		waterSoft: token('--viz-water-soft')
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

// Phase 2 boot probe (§4.1): ~300 ms of rAF while a test glass element animates; < 45 fps →
// document.documentElement.dataset.transparency = 'reduce'. Not wired in phase 1 (no glass class is
// on a live surface yet).
