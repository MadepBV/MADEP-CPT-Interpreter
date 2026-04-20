// @ts-nocheck
export const STAGE7_REPORT_STORAGE_PREFIX = 'stage7-report:';

export function makeStage7ReportKey() {
  return `${STAGE7_REPORT_STORAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function saveStage7Payload(storage, payload) {
  const key = makeStage7ReportKey();
  storage.setItem(key, JSON.stringify(payload));
  return key;
}

export function loadStage7Payload(storage, key) {
  if (!key) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function cleanupStage7Payloads(storage, keepKey) {
  const keys = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith(STAGE7_REPORT_STORAGE_PREFIX) && key !== keepKey) keys.push(key);
  }
  keys.forEach((key) => storage.removeItem(key));
}
