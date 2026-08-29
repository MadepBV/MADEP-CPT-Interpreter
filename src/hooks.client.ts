// SPDX-License-Identifier: AGPL-3.0-or-later
// Client-side error hook: keep the real message and stack on the error page instead of the
// generic "unexpected error" text, so a failing route can be diagnosed from a screenshot.
import type { HandleClientError } from '@sveltejs/kit';

export const handleError: HandleClientError = ({ error, status, message }) => {
	const e = error as any;
	const detail = e?.message ? String(e.message) : String(e ?? message);
	console.error('[cpt-app] route error', status, error);
	return { message: detail, stack: typeof e?.stack === 'string' ? e.stack.split('\n').slice(0, 8).join('\n') : undefined } as any;
};
