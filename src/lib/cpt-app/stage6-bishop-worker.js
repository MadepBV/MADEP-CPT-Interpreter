// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
import { analyzeBishopSearch } from './stage6-bishop';

self.onmessage = (event) => {
  const payload = event?.data || {};
  if (payload.type !== 'analyze') return;
  try {
    const result = analyzeBishopSearch(payload.input, (progress) => {
      self.postMessage({
        type: 'progress',
        runId: payload.runId,
        progress
      });
    });
    self.postMessage({
      type: 'result',
      runId: payload.runId,
      result
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      runId: payload.runId,
      error: error?.message || String(error)
    });
  }
};
