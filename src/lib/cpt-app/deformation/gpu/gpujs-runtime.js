// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// Local wrapper around gpu.js so Vite can resolve and bundle the dependency
// with its normal module pipeline. The probe/backend lazy-load this wrapper
// rather than issuing an opaque bare-module import from the browser runtime.

import * as gpuJsModule from 'gpu.js';

export const GPU = gpuJsModule?.GPU || gpuJsModule?.default?.GPU || gpuJsModule?.default || null;
export default GPU;
