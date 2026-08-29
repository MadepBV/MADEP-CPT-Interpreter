// SPDX-License-Identifier: AGPL-3.0-or-later
// verify_tokens.mjs — design-token integrity gate (worklog/refactor/02-design-system.md §5.2 / §5.3).
//
//   node scripts/verify_tokens.mjs            (npm run verify:tokens)
//
// 1. Every `var(--x)` used in legacy.css, retaining-styles.js, docs.css, report/**/*.svelte and
//    legacy-controller.js (HTML strings) is defined in src/lib/styles/tokens.css — or locally in the
//    same file (`--rpt-*`, `--st6-*`, inline `style="--x:…"`).
// 2. Both dark blocks exist and are identical: `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`
//    and `:root[data-theme="dark"]`.
// 3. Tokens that JS reads for canvases resolve (through the alias chain) to a literal colour —
//    never `color-mix()` / `light-dark()` (§3.1 rule b).
// 4. The WCAG contrast table of §4.2 (paper, glass over the darkest soil fill, dark chrome, dark paper,
//    dark data-viz ladder) — ratios printed and asserted.
// 5. (informational) when `.svelte-kit/output/client` exists: top-level rules outside `@layer` that are
//    not Svelte-scoped in the built CSS.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const rel = (p) => relative(root, p);
const read = (p) => readFileSync(p, 'utf8');

let failures = 0;
const fail = (msg) => { failures++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

function walk(dir, out = []) {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

// ── tokens.css ────────────────────────────────────────────────────────────────
const tokensPath = join(root, 'src/lib/styles/tokens.css');
const tokensCss = read(tokensPath);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const tokensClean = stripComments(tokensCss);

/** name → value of the *first* (light, bare :root) definition; later blocks are theme/pref overrides. */
const defined = new Map();
for (const m of tokensClean.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) if (!defined.has(m[1])) defined.set(m[1], m[2].trim());

console.log(`tokens.css: ${defined.size} tokens defined`);

// ── 1. usage coverage ─────────────────────────────────────────────────────────
console.log('\n1. var(--…) coverage');
const scope = [
	join(root, 'src/lib/cpt-app/legacy.css'),
	join(root, 'src/lib/cpt-app/retaining/retaining-styles.js'),
	join(root, 'src/lib/styles/docs.css'),
	join(root, 'src/lib/cpt-app/legacy-controller.js'),
	...walk(join(root, 'src/routes/report')).filter((f) => f.endsWith('.svelte'))
];
let usedTotal = 0;
for (const file of scope) {
	const src = read(file);
	const local = new Set([...src.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
	const used = new Set([...src.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
	usedTotal += used.size;
	const missing = [...used].filter((u) => !defined.has(u) && !local.has(u));
	if (missing.length) fail(`${rel(file)}: undefined ${missing.join(', ')}`);
	else ok(`${rel(file)}: ${used.size} tokens, all defined`);
}
// informational sweep of the rest of the app (string-rendered modules outside the §5.2 list)
const extra = walk(join(root, 'src/lib')).filter((f) => /\.(js|ts|svelte|css)$/.test(f) && !scope.includes(f) && f !== tokensPath);
const extraMissing = [];
for (const file of extra) {
	const src = read(file);
	const local = new Set([...src.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
	for (const m of src.matchAll(/var\(\s*(--[\w-]+)/g)) if (!defined.has(m[1]) && !local.has(m[1])) extraMissing.push(`${rel(file)} → ${m[1]}`);
}
if (extraMissing.length) console.log(`  · info: ${extraMissing.length} var() outside the gated set not in tokens.css:\n    ${[...new Set(extraMissing)].join('\n    ')}`);
else ok(`no undefined var() anywhere else under src/lib (${extra.length} files swept)`);

// ── 2. dark blocks ────────────────────────────────────────────────────────────
console.log('\n2. dark blocks');
function blockBody(source, headRe) {
	const m = headRe.exec(source);
	if (!m) return null;
	let i = m.index + m[0].length, depth = 1, start = i;
	for (; i < source.length && depth > 0; i++) { if (source[i] === '{') depth++; else if (source[i] === '}') depth--; }
	return source.slice(start, i - 1);
}
const norm = (s) => s.replace(/\s+/g, ' ').replace(/\s*([:;{}])\s*/g, '$1').trim();
const mediaDark = blockBody(tokensClean, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{/);
const attrDark = blockBody(tokensClean, /:root\[data-theme="dark"\]\s*\{/);
if (!mediaDark) fail('missing @media (prefers-color-scheme: dark) :root:not([data-theme="light"]) block');
if (!attrDark) fail('missing :root[data-theme="dark"] block');
if (mediaDark && attrDark) {
	const a = norm(mediaDark), b = norm(attrDark);
	if (a === b) ok(`media-dark and [data-theme="dark"] blocks are identical (${(a.match(/--[\w-]+:/g) || []).length} tokens)`);
	else {
		const A = new Set(a.split(';')), B = new Set(b.split(';'));
		fail(`dark blocks differ: only-in-media=[${[...A].filter((x) => !B.has(x)).join('; ')}] only-in-attr=[${[...B].filter((x) => !A.has(x)).join('; ')}]`);
	}
}
for (const sel of ['@supports not ((backdrop-filter', '@media (prefers-reduced-transparency: reduce)', ':root[data-transparency="reduce"]', '@media (prefers-reduced-motion: reduce)']) {
	if (tokensClean.includes(sel)) ok(`${sel} block present`); else fail(`${sel} block missing`);
}

// ── 3. JS-read tokens resolve to literals ─────────────────────────────────────
console.log('\n3. canvas-read tokens are literal (rule b)');
const jsRead = new Set();
for (const file of walk(join(root, 'src/lib')).filter((f) => f.endsWith('.js') || f.endsWith('.ts'))) {
	const src = stripComments(read(file)).replace(/^\s*\/\/.*$/gm, '');
	for (const m of src.matchAll(/(?:readCssToken|getPropertyValue)\(\s*['"](--[\w-]+)['"]/g)) jsRead.add(m[1]);
}
for (const name of ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6', '--viz-grid', '--viz-text', '--viz-halo', '--canvas-paper', '--canvas-grid']) jsRead.add(name);
function resolve(name, seen = new Set()) {
	if (seen.has(name)) return `<cycle ${name}>`;
	seen.add(name);
	let v = defined.get(name);
	if (v == null) return `<undefined ${name}>`;
	return v.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, n) => resolve(n, seen));
}
for (const name of [...jsRead].sort()) {
	const v = resolve(name);
	if (/color-mix|light-dark|<cycle|<undefined/.test(v)) fail(`${name} → ${v}`);
	else ok(`${name} → ${v}`);
}

// ── 4. contrast (§4.2) ────────────────────────────────────────────────────────
console.log('\n4. WCAG contrast');
function parseColor(s) {
	s = s.trim();
	let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
	if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
	m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(s);
	if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
	throw new Error(`cannot parse colour "${s}"`);
}
const mix = (a, b, wa) => ({ r: a.r * wa + b.r * (1 - wa), g: a.g * wa + b.g * (1 - wa), b: a.b * wa + b.b * (1 - wa), a: 1 });
const over = (fg, bg) => mix(fg, bg, fg.a); // fg with alpha composited over opaque bg
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
function luminance({ r, g, b }) {
	const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) { const l1 = luminance(a), l2 = luminance(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
const light = (n) => parseColor(resolve(n));
const darkVals = new Map([...(mediaDark || '').matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)].map((m) => [m[1], m[2].trim()]));
const dark = (n) => parseColor((darkVals.get(n) || resolve(n)).replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, k) => darkVals.get(k) || resolve(k)));

const bone = light('--color-bg');
const rows = [];
const check = (label, fg, bg, min, { expectFail = false } = {}) => {
	const r = contrast(fg, bg);
	const pass = r >= min;
	rows.push({ label, fg: hex(fg), bg: hex(bg), ratio: r.toFixed(2), min, pass });
	if (expectFail) { if (pass) fail(`${label}: ${r.toFixed(2)}:1 unexpectedly passes (spec says this pair fails; update the table)`); else ok(`${label}: ${r.toFixed(2)}:1 < ${min} (documented — not allowed in the design)`); }
	else if (pass) ok(`${label}: ${r.toFixed(2)}:1 ≥ ${min}`); else fail(`${label}: ${r.toFixed(2)}:1 < ${min}`);
};
check('paper · ink', light('--color-ink'), bone, 15);
check('paper · ink-2', light('--color-ink-2'), bone, 8);
check('paper · ink-3 (muted, AA)', light('--color-ink-3'), bone, 4.5);
check('paper · accent-text', light('--color-accent-text'), bone, 7);
check('paper · accent (UI 3:1)', light('--color-accent'), bone, 3);
check('paper · good', light('--color-good'), bone, 4.5);
check('paper · warn', light('--color-warn'), bone, 4.5);
check('paper · bad', light('--color-bad'), bone, 4.5);
check('paper · neutral', light('--color-neutral'), bone, 4.5);

// glass float over the darkest soil fill (soil-clay at 0.85 over canvas paper)
const glassTint = mix(parseColor('#F7F4EF'), parseColor('#FFFFFF'), 0.62);
const soilClay = mix(light('--soil-clay'), light('--canvas-paper'), 0.85);
const glassFloat = mix(glassTint, soilClay, Number(resolve('--glass-alpha')));
const glassStrong = mix(glassTint, soilClay, 0.86);
check(`glass-bg (66 %) over soil-clay (${hex(soilClay)}) · ink`, light('--color-ink'), glassFloat, 12);
check('glass-bg (66 %) over soil-clay · ink-3 (borderline — rule (a): muted text only on --glass-bg-strong)', light('--color-ink-3'), glassFloat, 4.5);
check(`glass-bg-strong (86 %) over soil-clay (${hex(glassStrong)}) · ink-3`, light('--color-ink-3'), glassStrong, 4.5);

// dark chrome over the cream page
const tintDark = mix(parseColor('#111110'), parseColor('#18181A'), 0.78);
const chrome = mix(tintDark, bone, Number(resolve('--glass-alpha-chrome')));
const chromeScrolled = over(light('--glass-bg-chrome-scrolled'), bone);
check(`chrome (${Math.round(Number(resolve('--glass-alpha-chrome')) * 100)} %) over cream (${hex(chrome)}) · on-dark`, light('--color-on-dark'), chrome, 4.5);
check('chrome over cream · on-dark-2 (72 %)', over(light('--color-on-dark-2'), chrome), chrome, 4.5);
check(`chrome scrolled (${hex(chromeScrolled)}) · on-dark`, light('--color-on-dark'), chromeScrolled, 10);

// dark theme paper
const dBg = dark('--color-bg');
check('dark paper · ink', dark('--color-ink'), dBg, 15);
check('dark paper · ink-2', dark('--color-ink-2'), dBg, 9);
check('dark paper · ink-3', dark('--color-ink-3'), dBg, 6);
check('dark paper · accent', dark('--color-accent'), dBg, 7);
check('dark paper · good', dark('--color-good'), dBg, 4.5);
check('dark paper · warn', dark('--color-warn'), dBg, 4.5);
check('dark paper · bad', dark('--color-bad'), dBg, 4.5);
// dark data-viz ladder on the dark canvas paper (§4.5)
const dCanvas = dark('--canvas-paper');
for (const n of ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6']) check(`dark canvas (${hex(dCanvas)}) · ${n}`, dark(n), dCanvas, 4.5);
check('dark canvas · viz-text-muted', dark('--viz-text-muted'), dCanvas, 4.5);
// light data-viz ladder on canvas paper (graphics, 3:1)
const lCanvas = light('--canvas-paper');
for (const n of ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6', '--viz-neutral']) check(`canvas (${hex(lCanvas)}) · ${n} (graphic 3:1)`, light(n), lCanvas, 3);

console.log('\n   contrast table');
console.log('   ' + ['pair', 'fg', 'bg', 'ratio', 'min', 'ok'].join(' | '));
for (const r of rows) console.log('   ' + [r.label, r.fg, r.bg, r.ratio, r.min, r.pass ? 'yes' : 'no'].join(' | '));

// ── 5. built CSS: unlayered rules (informational) ─────────────────────────────
const buildDir = join(root, '.svelte-kit/output/client/_app/immutable/assets');
if (existsSync(buildDir)) {
	console.log('\n5. built CSS outside @layer (informational)');
	const cssFiles = readdirSync(buildDir).filter((f) => f.endsWith('.css'));
	let unlayered = 0;
	const samples = [];
	for (const f of cssFiles) {
		const css = stripComments(read(join(buildDir, f)));
		let depth = 0, buf = '';
		for (let i = 0; i < css.length; i++) {
			const c = css[i];
			if (c === '{') {
				if (depth === 0) {
					const head = buf.trim();
					const layered = head.startsWith('@layer') || head.startsWith('@import') || head.startsWith('@charset');
					const svelte = /\.svelte-[a-z0-9]+/.test(head) || /^@(font-face|keyframes|-webkit-keyframes|page)/.test(head) || head.startsWith('@media');
					if (!layered && !svelte) { unlayered++; if (samples.length < 12) samples.push(`${f}: ${head.slice(0, 80)}`); }
				}
				depth++; buf = '';
			} else if (c === '}') { depth--; buf = ''; }
			else if (depth === 0) buf += c;
		}
	}
	console.log(`  · ${cssFiles.length} css files, ${unlayered} top-level unlayered non-Svelte rules${unlayered ? ':' : ''}`);
	for (const s of samples) console.log(`    ${s}`);
} else {
	console.log('\n5. built CSS check skipped (run `npm run build` first)');
}

console.log(failures ? `\nverify_tokens: ${failures} failure(s)` : `\nverify_tokens: OK (${usedTotal} var() usages checked)`);
process.exit(failures ? 1 : 0);
