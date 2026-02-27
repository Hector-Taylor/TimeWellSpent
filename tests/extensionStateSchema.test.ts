import { describe, expect, it } from 'vitest';
import {
  EXTENSION_STATE_SCHEMA_VERSION,
  migrateExtensionStateSnapshot
} from '../extension/src/stateSchema';

describe('extension state schema', () => {
  it('adds schemaVersion to legacy snapshots', () => {
    const migrated = migrateExtensionStateSnapshot({
      wallet: { balance: 10 },
      sessions: {}
    });
    expect(migrated.schemaVersion).toBe(EXTENSION_STATE_SCHEMA_VERSION);
    expect((migrated as any).wallet).toEqual({ balance: 10 });
  });

  it('normalizes invalid payloads to a valid schema version shell', () => {
    const migrated = migrateExtensionStateSnapshot(null);
    expect(migrated).toEqual({ schemaVersion: EXTENSION_STATE_SCHEMA_VERSION });
  });
});
