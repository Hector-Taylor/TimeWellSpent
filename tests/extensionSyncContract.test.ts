import { describe, expect, it } from 'vitest';
import {
  EXTENSION_SYNC_PROTOCOL_VERSION,
  createExtensionSyncEnvelope,
  parseExtensionSyncEnvelope
} from '../src/shared/extensionSyncContract';

describe('extension sync contract', () => {
  it('wraps state in a versioned envelope', () => {
    const envelope = createExtensionSyncEnvelope({ wallet: { balance: 12 } });
    expect(envelope.protocolVersion).toBe(EXTENSION_SYNC_PROTOCOL_VERSION);
    expect(typeof envelope.generatedAt).toBe('number');
    expect(envelope.state).toEqual({ wallet: { balance: 12 } });
  });

  it('parses current envelopes without warnings', () => {
    const payload = createExtensionSyncEnvelope({ sessions: {} });
    const parsed = parseExtensionSyncEnvelope(payload);
    expect(parsed.isLegacyPayload).toBe(false);
    expect(parsed.protocolVersion).toBe(EXTENSION_SYNC_PROTOCOL_VERSION);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.state).toEqual({ sessions: {} });
  });

  it('accepts legacy unwrapped payloads with a warning', () => {
    const parsed = parseExtensionSyncEnvelope({ sessions: { 'x.com': { mode: 'pack' } } });
    expect(parsed.isLegacyPayload).toBe(true);
    expect(parsed.protocolVersion).toBeNull();
    expect(parsed.warnings.join(' ')).toContain('Legacy');
    expect(parsed.state).toEqual({ sessions: { 'x.com': { mode: 'pack' } } });
  });
});
