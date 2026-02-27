import type { PaywallSession } from '../storage';
import { parseExtensionSyncEnvelope } from '../../../src/shared/extensionSyncContract';

type DesktopSyncStorage = {
  getAllSessions(): Promise<Record<string, PaywallSession>>;
  updateFromDesktop(desktopState: Record<string, unknown>): Promise<void>;
};

export type DesktopStateSyncController = {
  syncFromDesktop(): Promise<void>;
  requestDesktopSyncForGetStatus(): void;
};

export type CreateDesktopStateSyncDeps = {
  storage: DesktopSyncStorage;
  desktopApiUrl: string;
  getDevLogSessionDrift: () => boolean;
  getSyncThrottleMs: () => number;
};

export function logSessionDrift(
  before: Record<string, PaywallSession>,
  after: Record<string, PaywallSession>,
  context: string
) {
  const domains = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const domain of domains) {
    const prev = before[domain];
    const next = after[domain];
    if (!prev || !next) continue;
    const prevRemaining = prev.remainingSeconds;
    const nextRemaining = next.remainingSeconds;
    if (!Number.isFinite(prevRemaining) || !Number.isFinite(nextRemaining)) continue;
    const driftSeconds = Math.round(nextRemaining - prevRemaining);
    if (Math.abs(driftSeconds) >= 5) {
      console.info(
        `[dev] session drift (${context})`,
        domain,
        { localRemaining: prevRemaining, desktopRemaining: nextRemaining, driftSeconds }
      );
    }
  }
}

export function createDesktopStateSyncController(
  deps: CreateDesktopStateSyncDeps
): DesktopStateSyncController {
  let desktopSyncRequestInFlight: Promise<void> | null = null;
  let lastGetStatusDesktopSyncRequestedAt = 0;

  async function syncFromDesktop() {
    try {
      const before = deps.getDevLogSessionDrift() ? await deps.storage.getAllSessions() : null;
      const response = await fetch(`${deps.desktopApiUrl}/extension/state`, { cache: 'no-store' });
      if (response.ok) {
        const raw = await response.json();
        const parsed = parseExtensionSyncEnvelope(raw);
        if (parsed.warnings.length) {
          console.warn('[extension-sync]', ...parsed.warnings);
        }
        await deps.storage.updateFromDesktop(parsed.state as Record<string, unknown>);
        if (before && deps.getDevLogSessionDrift()) {
          const after = await deps.storage.getAllSessions();
          logSessionDrift(before, after, 'sync');
        }
        console.log('✅ Synced state from desktop app');
      }
    } catch {
      console.log('Desktop app not available for sync');
    }
  }

  function requestDesktopSyncForGetStatus() {
    const now = Date.now();
    if (desktopSyncRequestInFlight) return;
    if (now - lastGetStatusDesktopSyncRequestedAt < deps.getSyncThrottleMs()) return;
    lastGetStatusDesktopSyncRequestedAt = now;
    desktopSyncRequestInFlight = syncFromDesktop().finally(() => {
      desktopSyncRequestInFlight = null;
    });
  }

  return {
    syncFromDesktop,
    requestDesktopSyncForGetStatus
  };
}
