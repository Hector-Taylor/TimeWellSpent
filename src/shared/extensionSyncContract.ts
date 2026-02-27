export const EXTENSION_SYNC_PROTOCOL_VERSION = 1;

export type ExtensionSyncEnvelope<TState = unknown> = {
  protocolVersion: number;
  generatedAt: number;
  state: TState;
};

export function createExtensionSyncEnvelope<TState>(state: TState): ExtensionSyncEnvelope<TState> {
  return {
    protocolVersion: EXTENSION_SYNC_PROTOCOL_VERSION,
    generatedAt: Date.now(),
    state
  };
}

export type ParsedExtensionSyncEnvelope = {
  state: unknown;
  protocolVersion: number | null;
  generatedAt: number | null;
  isLegacyPayload: boolean;
  warnings: string[];
};

export function parseExtensionSyncEnvelope(payload: unknown): ParsedExtensionSyncEnvelope {
  const warnings: string[] = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      state: {},
      protocolVersion: null,
      generatedAt: null,
      isLegacyPayload: true,
      warnings: ['Invalid extension sync payload shape; expected object.']
    };
  }

  const record = payload as Record<string, unknown>;
  const hasEnvelopeFields = Object.prototype.hasOwnProperty.call(record, 'state')
    || Object.prototype.hasOwnProperty.call(record, 'protocolVersion')
    || Object.prototype.hasOwnProperty.call(record, 'generatedAt');

  if (!hasEnvelopeFields) {
    warnings.push('Legacy extension sync payload received (missing envelope fields).');
    return {
      state: record,
      protocolVersion: null,
      generatedAt: null,
      isLegacyPayload: true,
      warnings
    };
  }

  const protocolVersion = typeof record.protocolVersion === 'number' && Number.isFinite(record.protocolVersion)
    ? Math.trunc(record.protocolVersion)
    : null;
  const generatedAt = typeof record.generatedAt === 'number' && Number.isFinite(record.generatedAt)
    ? Math.trunc(record.generatedAt)
    : null;
  const state = (record.state && typeof record.state === 'object' && !Array.isArray(record.state))
    ? record.state
    : {};

  if (protocolVersion == null) {
    warnings.push('Extension sync payload missing valid protocolVersion.');
  } else if (protocolVersion !== EXTENSION_SYNC_PROTOCOL_VERSION) {
    warnings.push(
      `Extension sync protocol mismatch (got ${protocolVersion}, expected ${EXTENSION_SYNC_PROTOCOL_VERSION}).`
    );
  }
  if (generatedAt == null) {
    warnings.push('Extension sync payload missing valid generatedAt timestamp.');
  }
  if (!record.state || typeof record.state !== 'object' || Array.isArray(record.state)) {
    warnings.push('Extension sync payload missing valid state object.');
  }

  return {
    state,
    protocolVersion,
    generatedAt,
    isLegacyPayload: false,
    warnings
  };
}
