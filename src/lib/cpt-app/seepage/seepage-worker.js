// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
import { analyzeSeepageModel } from './solver.js';

self.onmessage = async (event) => {
  const payload = event?.data || {};
  if (payload.type !== 'run-seepage') return;
  try {
    const output = await analyzeSeepageModel(payload.input, (progress) => {
      self.postMessage({
        type: 'progress',
        runId: payload.runId,
        progress
      });
    });
    self.postMessage({
      type: 'result',
      runId: payload.runId,
      output
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      runId: payload.runId,
      error: error?.message || String(error)
    });
  }
};
