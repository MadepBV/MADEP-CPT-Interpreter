// SPDX-License-Identifier: AGPL-3.0-or-later
// src/lib/styles/toast.ts — the app's transient feedback queue (worklog/refactor/02-design-system.md §3.15, §4.4).
//
// `alert()` stops the world for a message the engineer can do nothing about ("the file could not be
// read", "no layers to export"). A toast says the same thing without taking the keyboard: it appears
// bottom-right in an `aria-live="polite"` region, auto-dismisses (errors stay until dismissed), and
// stacks — at most MAX_VISIBLE at a time, the rest queued in order so a multi-file import cannot bury
// the screen. An identical message repeated while it is still on screen bumps a `×n` counter instead
// of adding a second card (the "import errors accumulate into one toast with a count" rule of §3.15).
//
// Blocking semantics are NOT provided here on purpose: an `alert()` the flow waits on, and every
// `confirm()`, keeps a real dialog (see `confirmDialog` in src/lib/cpt-app/import-review/).
//
// Styling is tokens-only in components.css §26; this module owns no colours and no geometry. Motion
// comes from `--motion-*`, which tokens.css already zeroes under `prefers-reduced-motion: reduce`.
//
// SSR / Node safe: with no document (or before <body> exists) messages are buffered and flushed on
// the first call that finds a DOM, so a module-scope call during hydration is never lost or thrown.

export type ToastTone = 'info' | 'ok' | 'warn' | 'bad';

export interface ToastOptions {
	/** Visual + semantic tone. `bad` announces with `role="alert"` and does not auto-dismiss. */
	tone?: ToastTone;
	/** Auto-dismiss delay in ms. `0` (the default for `bad`) keeps the toast until it is dismissed. */
	timeout?: number;
}

/** Short mono word next to the dot, so tone is never colour-only (§4.2 rule b). */
const TAG: Record<ToastTone, string> = { info: 'info', ok: 'ok', warn: 'let op', bad: 'fout' };
const DEFAULT_TIMEOUT: Record<ToastTone, number> = { info: 6000, ok: 6000, warn: 8000, bad: 0 };

const MAX_VISIBLE = 3;
const MAX_BUFFERED = 20;

interface Entry {
	message: string;
	tone: ToastTone;
	timeout: number;
}

interface Live extends Entry {
	el: HTMLElement;
	count: number;
	countEl: HTMLElement;
	timer: ReturnType<typeof setTimeout> | null;
}

/** Calls made before a DOM existed (SSR, module scope during hydration). Flushed on the first DOM call. */
const buffered: Entry[] = [];
/** Waiting their turn because MAX_VISIBLE are already on screen. */
const queued: Entry[] = [];
const live: Live[] = [];

let region: HTMLElement | null = null;

function hasDom(): boolean {
	return typeof document !== 'undefined' && !!document.body && typeof document.createElement === 'function';
}

function ensureRegion(): HTMLElement | null {
	if (!hasDom()) return null;
	if (region && region.isConnected !== false) return region;
	const el = document.createElement('div');
	el.className = 'toast-region';
	// The region is the live announcer; each toast keeps its own role so an error interrupts (§4.4).
	el.setAttribute('aria-live', 'polite');
	el.setAttribute('aria-atomic', 'false');
	el.setAttribute('aria-label', 'Meldingen');
	document.body.appendChild(el);
	region = el;
	return el;
}

function clearTimer(t: Live): void {
	if (t.timer != null) {
		clearTimeout(t.timer);
		t.timer = null;
	}
}

function arm(t: Live): void {
	clearTimer(t);
	if (!t.timeout) return;
	t.timer = setTimeout(() => dismiss(t), t.timeout);
	// A pending toast must never hold a Node process (the golden tier loads the app under Node).
	(t.timer as unknown as { unref?: () => void })?.unref?.();
}

function dismiss(t: Live): void {
	const i = live.indexOf(t);
	if (i < 0) return;
	live.splice(i, 1);
	clearTimer(t);
	t.el.classList.add('is-leaving');
	// The card is removed on its own transition end; a timer is the fallback for reduced motion,
	// `animations: disabled` and browsers that skip the event for an element already off-screen.
	const drop = () => {
		t.el.remove();
		pump();
	};
	t.el.addEventListener('animationend', drop, { once: true });
	const bail = setTimeout(drop, 400);
	(bail as unknown as { unref?: () => void })?.unref?.();
}

/** Shows queued entries until MAX_VISIBLE are on screen. */
function pump(): void {
	while (live.length < MAX_VISIBLE && queued.length) show(queued.shift() as Entry);
}

function show(entry: Entry): void {
	const host = ensureRegion();
	if (!host) return;

	const el = document.createElement('div');
	el.className = `toast toast--${entry.tone}`;
	el.setAttribute('role', entry.tone === 'bad' ? 'alert' : 'status');
	el.dataset.toast = entry.tone;

	const dot = document.createElement('span');
	dot.className = 'toast__dot';
	dot.setAttribute('aria-hidden', 'true');

	const body = document.createElement('div');
	body.className = 'toast__body';
	const tag = document.createElement('span');
	tag.className = 'toast__tag';
	tag.textContent = TAG[entry.tone];
	const text = document.createElement('span');
	text.className = 'toast__text';
	text.textContent = entry.message;
	const count = document.createElement('span');
	count.className = 'toast__count';
	count.hidden = true;
	// Real spaces between the parts: the card is announced as one string by `role="status"`, and
	// a CSS margin is not a word boundary ("LET OPLaad eerst…").
	body.appendChild(tag);
	body.appendChild(document.createTextNode(' '));
	body.appendChild(text);
	body.appendChild(document.createTextNode(' '));
	body.appendChild(count);

	const close = document.createElement('button');
	close.type = 'button';
	close.className = 'toast__close';
	close.dataset.toastClose = '';
	close.setAttribute('aria-label', 'Melding sluiten');
	close.textContent = '✕';

	el.appendChild(dot);
	el.appendChild(body);
	el.appendChild(close);
	host.appendChild(el);

	const t: Live = { ...entry, el, count: 1, countEl: count, timer: null };
	close.addEventListener('click', () => dismiss(t));
	// Reading a message should not race the clock: hovering or focusing holds it.
	el.addEventListener('pointerenter', () => clearTimer(t));
	el.addEventListener('pointerleave', () => arm(t));
	el.addEventListener('focusin', () => clearTimer(t));
	el.addEventListener('focusout', () => arm(t));

	live.push(t);
	arm(t);
}

function flushBuffered(): void {
	if (!buffered.length || !hasDom()) return;
	const pending = buffered.splice(0, buffered.length);
	for (const entry of pending) enqueue(entry);
}

function enqueue(entry: Entry): void {
	const same = live.find((t) => t.message === entry.message && t.tone === entry.tone);
	if (same) {
		same.count += 1;
		same.countEl.textContent = `×${same.count}`;
		same.countEl.hidden = false;
		arm(same);
		return;
	}
	if (live.length < MAX_VISIBLE) show(entry);
	else queued.push(entry);
}

/**
 * Shows a transient message. Never blocks, never throws, safe before the DOM exists.
 *
 *   toast('Laad eerst een GEF bestand.');
 *   toast(`Error importing ${name}: ${err.message}`, { tone: 'bad' });
 */
export function toast(message: unknown, options: ToastOptions = {}): void {
	const text = String(message ?? '').trim();
	if (!text) return;
	const tone: ToastTone = options.tone && TAG[options.tone] ? options.tone : 'info';
	const timeout = Number.isFinite(options.timeout as number) ? Math.max(0, options.timeout as number) : DEFAULT_TIMEOUT[tone];
	const entry: Entry = { message: text, tone, timeout };

	if (!hasDom()) {
		if (buffered.length < MAX_BUFFERED) buffered.push(entry);
		return;
	}
	flushBuffered();
	enqueue(entry);
}

/** Dismisses everything on screen and drops the queue (used by the visual suite between shots). */
export function toastClear(): void {
	queued.length = 0;
	for (const t of live.slice()) {
		clearTimer(t);
		const i = live.indexOf(t);
		if (i >= 0) live.splice(i, 1);
		t.el.remove();
	}
}
