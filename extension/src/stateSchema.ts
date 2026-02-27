export const EXTENSION_STATE_SCHEMA_VERSION = 1;

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function migrateExtensionStateSnapshot<T extends PlainRecord = PlainRecord>(raw: unknown): T & { schemaVersion: number } {
  const base = isPlainRecord(raw) ? { ...raw } : {};
  const currentVersion = typeof base.schemaVersion === 'number' && Number.isFinite(base.schemaVersion)
    ? Math.trunc(base.schemaVersion)
    : 0;

  let next: PlainRecord = base;

  // Version 1 introduces explicit schemaVersion metadata for local extension storage snapshots.
  if (currentVersion < 1) {
    next = { ...next };
  }

  next.schemaVersion = EXTENSION_STATE_SCHEMA_VERSION;
  return next as T & { schemaVersion: number };
}
