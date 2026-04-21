// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
import { analyzeSeepageModel } from './solver.js';

let activeRunId = 0;
let stopRequested = false;

function shouldStop(runId) {
  return stopRequested && runId === activeRunId;
}

function createRunControl(runId) {
  let lastYieldAt = performance.now();
  return {
    shouldStop: () => shouldStop(runId),
    checkpoint: async ({ force = false } = {}) => {
      const now = performance.now();
      if (force || now - lastYieldAt >= 24) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYieldAt = performance.now();
      }
      return shouldStop(runId);
    }
  };
}

self.onmessage = async (event) => {
  const payload = event?.data || {};
  if (payload.type === 'stop-seepage') {
    if (payload.runId === activeRunId) stopRequested = true;
    return;
  }
  if (payload.type !== 'run-seepage') return;
  activeRunId = payload.runId;
  stopRequested = false;
  try {
    const output = await analyzeSeepageModel(payload.input, (progress) => {
      self.postMessage({
        type: 'progress',
        runId: payload.runId,
        progress
      });
    }, createRunControl(payload.runId));
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
  } finally {
    if (activeRunId === payload.runId) {
      activeRunId = 0;
      stopRequested = false;
    }
  }
};
