// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from '@sveltejs/kit';

export const prerender = true;

export const load = () => {
	throw redirect(308, '/docs/engineering/bishop');
};
