// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
export const STAGE7_REPORT_STORAGE_PREFIX = 'stage7-report:';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function makeStage7ReportKey() {
  return `${STAGE7_REPORT_STORAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function saveStage7Payload(storage, payload) {
  const key = makeStage7ReportKey();
  storage.setItem(key, JSON.stringify(payload));
  return key;
}

export function isStage7Payload(payload) {
  return (
    isPlainObject(payload) &&
    payload.stage === 'stage7' &&
    typeof payload.generatedAt === 'string' &&
    isPlainObject(payload.project) &&
    isPlainObject(payload.cpt) &&
    typeof payload.cpt.displayId === 'string' &&
    isPlainObject(payload.metadata) &&
    isPlainObject(payload.replication) &&
    isPlainObject(payload.summary) &&
    Array.isArray(payload.summary.stage6Annexes) &&
    isPlainObject(payload.visuals) &&
    isPlainObject(payload.visuals.layerColumn) &&
    isPlainObject(payload.visuals.layerProfile) &&
    isPlainObject(payload.chartInputs) &&
    isPlainObject(payload.chartInputs.raw) &&
    Array.isArray(payload.rawRows) &&
    Array.isArray(payload.classifiedRows) &&
    Array.isArray(payload.layers) &&
    Array.isArray(payload.layerWarnings) &&
    (payload.tuning == null || Array.isArray(payload.tuning)) &&
    (payload.stage6 == null || isPlainObject(payload.stage6))
  );
}

export function parseStage7Payload(raw) {
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    return isStage7Payload(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function loadStage7Payload(storage, key) {
  if (!key) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  return parseStage7Payload(raw);
}

export function cleanupStage7Payloads(storage, keepKey) {
  const keys = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith(STAGE7_REPORT_STORAGE_PREFIX) && key !== keepKey) keys.push(key);
  }
  keys.forEach((key) => storage.removeItem(key));
}

export function persistStage7Payload(storage, payload) {
  if (!storage || !isStage7Payload(payload)) return '';
  const key = saveStage7Payload(storage, payload);
  cleanupStage7Payloads(storage, key);
  return key;
}

function slugifyReportName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function reportDateStamp(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.valueOf())) return 'undated';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function stage7PayloadFilename(payload) {
  const displayId = slugifyReportName(payload?.cpt?.displayId || payload?.metadata?.testid || 'cpt');
  return `${displayId || 'cpt'}-stage7-report-${reportDateStamp(payload?.generatedAt)}.json`;
}
