import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  EmergencyPolicyId,
  JournalConfig,
  PeekConfig,
  RendererApi,
  SyncDevice,
  SyncStatus,
  ZoteroCollection,
  ZoteroIntegrationConfig,
  ZoteroIntegrationMode
} from '@shared/types';
import Domains from './Domains';
import EconomyTuner from './EconomyTuner';

interface SettingsProps {
  api: RendererApi;
}

const SETTINGS_PANES = [
  {
    id: 'sync',
    label: 'Sync & Profile',
    description: 'Devices, cloud sync, and identity.'
  },
  {
    id: 'activity',
    label: 'Activity',
    description: 'Idle thresholds and continuity rules.'
  },
  {
    id: 'paywall',
    label: 'Paywall & Rituals',
    description: 'Emergency access, peek, and journaling.'
  },
  {
    id: 'integrations',
    label: 'Integrations',
    description: 'Bring in external libraries.'
  },
  {
    id: 'domains',
    label: 'Domains',
    description: 'Productive vs neutral vs frivolous.'
  },
  {
    id: 'economy',
    label: 'Economy',
    description: 'Tune earn + spend profiles.'
  },
  {
    id: 'system',
    label: 'System',
    description: 'Reset data and permissions.'
  }
] as const;

type SettingsPaneId = typeof SETTINGS_PANES[number]['id'];

export default function Settings({ api }: SettingsProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<SettingsPaneId>('sync');

  const [idleThreshold, setIdleThreshold] = useState(15);
  const [frivolousIdleThreshold, setFrivolousIdleThreshold] = useState(15);
  const [emergencyPolicy, setEmergencyPolicy] = useState<EmergencyPolicyId>('balanced');
  const [emergencyReminderInterval, setEmergencyReminderInterval] = useState(300);
  const [journalUrl, setJournalUrl] = useState('');
  const [journalMinutes, setJournalMinutes] = useState(10);
  const [peekEnabled, setPeekEnabled] = useState(true);
  const [peekAllowNewPages, setPeekAllowNewPages] = useState(false);
  const [continuityWindowSeconds, setContinuityWindowSeconds] = useState(120);
  const [excludedKeywordsText, setExcludedKeywordsText] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncDevices, setSyncDevices] = useState<SyncDevice[]>([]);
  const [deviceName, setDeviceName] = useState('');
  const [handle, setHandle] = useState('');
  const [profileColor, setProfileColor] = useState('#7cf4d4');
  const [syncBusy, setSyncBusy] = useState(false);

  const [zoteroConfig, setZoteroConfig] = useState<ZoteroIntegrationConfig>({
    mode: 'recent',
    collectionId: null,
    includeSubcollections: true
  });
  const [zoteroCollections, setZoteroCollections] = useState<ZoteroCollection[]>([]);
  const [zoteroCollectionsLoading, setZoteroCollectionsLoading] = useState(false);
  const [resetScope, setResetScope] = useState<'trophies' | 'all'>('trophies');
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!resetMessage) return;
    const timer = window.setTimeout(() => setResetMessage(null), 5000);
    return () => window.clearTimeout(timer);
  }, [resetMessage]);

  useEffect(() => {
    api.settings.idleThreshold().then(setIdleThreshold);
    api.settings.frivolousIdleThreshold().then(setFrivolousIdleThreshold);
    api.settings.emergencyPolicy().then(setEmergencyPolicy);
    api.settings.emergencyReminderInterval().then(setEmergencyReminderInterval);
    api.settings.journalConfig().then((cfg: JournalConfig) => {
      setJournalUrl(cfg.url ?? '');
      setJournalMinutes(cfg.minutes ?? 10);
    }).catch(() => { });
    api.settings.peekConfig().then((cfg: PeekConfig) => {
      setPeekEnabled(cfg.enabled);
      setPeekAllowNewPages(cfg.allowOnNewPages);
    }).catch(() => { });
    api.settings.continuityWindowSeconds().then(setContinuityWindowSeconds).catch(() => { });
    api.settings.excludedKeywords().then((keywords) => {
      setExcludedKeywordsText((keywords ?? []).join('\n'));
    }).catch(() => { });
    api.integrations.zotero.config().then(setZoteroConfig).catch(() => { });
  }, [api.settings, api.integrations.zotero]);

  const refreshSync = async () => {
    try {
      const status = await api.sync.status();
      setSyncStatus(status);
      setDeviceName(status.device?.name ?? '');
      if (status.configured && status.authenticated) {
        const profile = await api.friends.profile();
        setHandle(profile?.handle ?? '');
        setProfileColor(profile?.color ?? '#7cf4d4');
        const devices = await api.sync.listDevices();
        setSyncDevices(devices);
      } else {
        setSyncDevices([]);
      }
    } catch (err) {
      console.error('Failed to load sync status', err);
    }
  };

  useEffect(() => {
    refreshSync();
  }, []);

  const selectedZoteroCollection = useMemo(() => {
    if (zoteroConfig.collectionId == null) return null;
    return zoteroCollections.find((c) => c.id === zoteroConfig.collectionId) ?? null;
  }, [zoteroCollections, zoteroConfig.collectionId]);

  async function refreshZoteroCollections() {
    setZoteroCollectionsLoading(true);
    try {
      const cols = await api.integrations.zotero.collections();
      setZoteroCollections(cols);
    } catch (err) {
      console.error('Failed to load Zotero collections', err);
      setError('Failed to load Zotero collections. Is Zotero installed and opened at least once?');
    } finally {
      setZoteroCollectionsLoading(false);
    }
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api.settings.updateIdleThreshold(idleThreshold);
      await api.settings.updateFrivolousIdleThreshold(frivolousIdleThreshold);
      const keywords = excludedKeywordsText
        .split(/[\n,]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
      await api.settings.updateExcludedKeywords(keywords);
      setExcludedKeywordsText(keywords.join('\n'));
      await api.settings.updateEmergencyPolicy(emergencyPolicy);
      await api.settings.updateEmergencyReminderInterval(emergencyReminderInterval);
      await api.settings.updateJournalConfig({ url: journalUrl.trim() ? journalUrl.trim() : null, minutes: journalMinutes });
      await api.settings.updatePeekConfig({ enabled: peekEnabled, allowOnNewPages: peekAllowNewPages });
      await api.settings.updateContinuityWindowSeconds(continuityWindowSeconds);
      await api.integrations.zotero.updateConfig(zoteroConfig);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (resetBusy) return;
    setResetMessage(null);
    const warning =
      resetScope === 'trophies'
        ? 'This will clear all earned trophies, pinned trophies, and personal bests.'
        : 'This will clear trophies, activity history, wallet, library, and sync state. This cannot be undone.';
    if (!window.confirm(`${warning}\n\nContinue?`)) return;
    if (resetScope === 'all' && !window.confirm('Final check: erase all local/cloud stats now?')) return;

    setResetBusy(true);
    setError(null);
    try {
      await api.system.reset(resetScope);
      setResetMessage(resetScope === 'trophies' ? 'Trophy case reset locally and in sync.' : 'All stats reset locally and in sync.');
      await refreshSync();
    } catch (err) {
      setError((err as Error).message || 'Failed to reset');
    } finally {
      setResetBusy(false);
    }
  }

  const activePaneConfig = SETTINGS_PANES.find((pane) => pane.id === activePane) ?? SETTINGS_PANES[0];
  const showPaneHeader = activePane !== 'domains' && activePane !== 'economy';

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h1>Settings</h1>
          <p className="subtle">Tune policies, domains, economy, and sync.</p>
        </div>
      </header>

      {error && <p className="error-text">{error}</p>}

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SETTINGS_PANES.map((pane) => (
            <button
              key={pane.id}
              type="button"
              className={activePane === pane.id ? 'active' : ''}
              onClick={() => setActivePane(pane.id)}
            >
              <span className="settings-nav-label">{pane.label}</span>
              <span className="settings-nav-desc">{pane.description}</span>
            </button>
          ))}
        </nav>

        <div className="settings-pane">
          {showPaneHeader && (
            <div className="settings-pane-header">
              <h2>{activePaneConfig.label}</h2>
              <p className="subtle">{activePaneConfig.description}</p>
            </div>
          )}

          {activePane === 'sync' && (
            <div className="settings-pane-body">
              <div className="card settings-section">
                <div className="card-header-row">
                  <div>
                    <h2>Cloud sync</h2>
                    <p className="subtle" style={{ margin: 0 }}>Keep wallet, library, and summaries aligned across devices.</p>
                  </div>
                  <button type="button" className="ghost" onClick={refreshSync} disabled={syncBusy}>
                    Refresh
                  </button>
                </div>

                {!syncStatus?.configured && (
                  <p className="subtle">
                    Supabase not configured. Add `SUPABASE_URL` and `SUPABASE_ANON_KEY`, then restart the app.
                  </p>
                )}

                {syncStatus?.configured && !syncStatus.authenticated && (
                  <div className="settings-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={async () => {
                        setSyncBusy(true);
                        await api.sync.signIn('google');
                        setSyncBusy(false);
                      }}
                      disabled={syncBusy}
                    >
                      Connect with Google
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={async () => {
                        setSyncBusy(true);
                        await api.sync.signIn('github');
                        setSyncBusy(false);
                      }}
                      disabled={syncBusy}
                    >
                      Connect with GitHub
                    </button>
                  </div>
                )}

                {syncStatus?.configured && syncStatus.authenticated && (
                  <div className="settings-stack">
                    <div className="settings-pills">
                      <span className="pill ghost">{syncStatus.user?.email ?? syncStatus.user?.id}</span>
                      <span className="pill ghost">Device {syncStatus.device?.id?.slice(0, 8)}</span>
                      {syncStatus.lastSyncAt && <span className="pill ghost">Last sync {new Date(syncStatus.lastSyncAt).toLocaleString()}</span>}
                    </div>
                    <div className="settings-row">
                      <label>
                        Device name
                        <input
                          type="text"
                          value={deviceName}
                          onChange={(e) => setDeviceName(e.target.value)}
                          placeholder="My MacBook"
                        />
                      </label>
                      <label>
                        Handle
                        <input
                          type="text"
                          value={handle}
                          onChange={(e) => setHandle(e.target.value)}
                          placeholder="your_handle"
                        />
                      </label>
                      <label>
                        Accent color
                        <input
                          type="color"
                          value={profileColor}
                          onChange={(e) => setProfileColor(e.target.value)}
                        />
                      </label>
                    </div>
                    <div className="settings-actions">
                      <button
                        type="button"
                        className="primary"
                        onClick={async () => {
                          setSyncBusy(true);
                          setError(null);
                          try {
                            await api.sync.setDeviceName(deviceName);
                            await api.friends.updateProfile({ handle: handle.trim() || undefined, color: profileColor });
                            await api.sync.syncNow();
                            await refreshSync();
                          } catch (err) {
                            setError((err as Error).message || 'Failed to sync now');
                          } finally {
                            setSyncBusy(false);
                          }
                        }}
                        disabled={syncBusy}
                      >
                        Sync now
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={async () => {
                          setSyncBusy(true);
                          await api.sync.signOut();
                          await refreshSync();
                          setSyncBusy(false);
                        }}
                        disabled={syncBusy}
                      >
                        Sign out
                      </button>
                    </div>

                    {syncDevices.length > 0 && (
                      <div className="devices-list">
                        {syncDevices.map((device) => (
                          <div key={device.id} className={`device-row ${device.isCurrent ? 'current' : ''}`}>
                            <div>
                              <strong>{device.name}</strong>
                              <span className="subtle">{device.platform}</span>
                            </div>
                            <span className="subtle">
                              {device.lastSeenAt ? `Seen ${new Date(device.lastSeenAt).toLocaleString()}` : 'Pending'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {activePane === 'activity' && (
            <form className="settings-pane-form" onSubmit={save}>
              <div className="card settings-section">
                <div className="settings-section-header">
                  <h3>Activity detection</h3>
                  <p className="subtle">Tune idle detection.</p>
                </div>
                <div className="settings-row">
                  <label>
                    Idle threshold (seconds)
                    <input
                      type="number"
                      min="5"
                      max="300"
                      value={idleThreshold}
                      onChange={(e) => setIdleThreshold(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Frivolous idle (seconds)
                    <input
                      type="number"
                      min="5"
                      max="300"
                      value={frivolousIdleThreshold}
                      onChange={(e) => setFrivolousIdleThreshold(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Continuity window (seconds)
                    <input
                      type="number"
                      min="0"
                      max="900"
                      value={continuityWindowSeconds}
                      onChange={(e) => setContinuityWindowSeconds(Number(e.target.value))}
                    />
                  </label>
                </div>
                <label>
                  Keywords to exclude
                  <textarea
                    rows={3}
                    value={excludedKeywordsText}
                    onChange={(e) => setExcludedKeywordsText(e.target.value)}
                    placeholder="One keyword per line"
                  />
                </label>
                <p className="subtle" style={{ margin: 0 }}>Lower values mark passive browsing as idle sooner.</p>
                <p className="subtle" style={{ margin: 0 }}>Excluded keywords stay neutral and are hidden from stream trackers.</p>
                <p className="subtle" style={{ margin: 0 }}>Continuity keeps short research hops in the same productive run.</p>
              </div>
              <div className="settings-actions">
                <button className="primary" type="submit" disabled={saving}>
                  {saving ? 'Saving…' : saved ? 'Saved!' : 'Save changes'}
                </button>
              </div>
            </form>
          )}

          {activePane === 'paywall' && (
            <form className="settings-pane-form" onSubmit={save}>
              <div className="card settings-section">
                <div className="settings-section-header">
                  <h3>Paywall controls</h3>
                  <p className="subtle">Emergency + peek behavior.</p>
                </div>
                <div className="settings-row">
                  <label>
                    Emergency policy
                    <select value={emergencyPolicy} onChange={(e) => setEmergencyPolicy(e.target.value as EmergencyPolicyId)}>
                      <option value="off">Off</option>
                      <option value="gentle">Gentle</option>
                      <option value="balanced">Balanced</option>
                      <option value="strict">Strict</option>
                    </select>
                  </label>
                  <label>
                    Reminder interval (seconds)
                    <input
                      type="number"
                      min="30"
                      max="3600"
                      value={emergencyReminderInterval}
                      onChange={(e) => setEmergencyReminderInterval(Number(e.target.value))}
                    />
                  </label>
                </div>
                <details className="settings-details">
                  <summary>Policy details</summary>
                  <div className="subtle">
                    <div><strong>Off</strong>: no emergency access.</div>
                    <div><strong>Gentle</strong>: 5m, URL-locked, unlimited/day.</div>
                    <div><strong>Balanced</strong>: 3m, 2/day, 30m cooldown.</div>
                    <div><strong>Strict</strong>: 2m, 1/day, 60m cooldown.</div>
                  </div>
                </details>
                <div className="settings-inline">
                  <label>
                    <input
                      type="checkbox"
                      checked={peekEnabled}
                      onChange={(e) => setPeekEnabled(e.target.checked)}
                    />
                    <span className="subtle">Enable peek</span>
                  </label>
                  <label style={{ opacity: peekEnabled ? 1 : 0.6 }}>
                    <input
                      type="checkbox"
                      checked={peekAllowNewPages}
                      onChange={(e) => setPeekAllowNewPages(e.target.checked)}
                      disabled={!peekEnabled}
                    />
                    <span className="subtle">Allow peek on new pages</span>
                  </label>
                </div>
              </div>

              <div className="card settings-section">
                <div className="settings-section-header">
                  <h3>Journaling</h3>
                  <p className="subtle">Quick launch for reset prompts.</p>
                </div>
                <label>
                  Journal URL
                  <input
                    type="text"
                    placeholder="https://app.tana.inc/…"
                    value={journalUrl}
                    onChange={(e) => setJournalUrl(e.target.value)}
                  />
                </label>
                <label style={{ maxWidth: 260 }}>
                  Duration (minutes)
                  <input
                    type="number"
                    min="1"
                    max="180"
                    value={journalMinutes}
                    onChange={(e) => setJournalMinutes(Number(e.target.value))}
                  />
                </label>
              </div>

              <div className="settings-actions">
                <button className="primary" type="submit" disabled={saving}>
                  {saving ? 'Saving…' : saved ? 'Saved!' : 'Save changes'}
                </button>
              </div>
            </form>
          )}

          {activePane === 'integrations' && (
            <form className="settings-pane-form" onSubmit={save}>
              <div className="card settings-section">
                <div className="settings-section-header">
                  <h3>Integrations</h3>
                  <p className="subtle">Curate “Try this instead”.</p>
                </div>
                <label>
                  Zotero source
                  <select
                    value={zoteroConfig.mode}
                    onChange={(e) => {
                      const mode = e.target.value as ZoteroIntegrationMode;
                      setZoteroConfig((cur) => ({
                        ...cur,
                        mode: mode === 'collection' ? 'collection' : 'recent'
                      }));
                    }}
                  >
                    <option value="recent">Recent items</option>
                    <option value="collection">Specific collection</option>
                  </select>
                </label>
                {zoteroConfig.mode === 'collection' && (
                  <div className="settings-stack">
                    <div className="settings-actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={refreshZoteroCollections}
                        disabled={zoteroCollectionsLoading}
                      >
                        {zoteroCollectionsLoading ? 'Loading…' : 'Refresh collections'}
                      </button>
                      <label className="settings-inline">
                        <input
                          type="checkbox"
                          checked={zoteroConfig.includeSubcollections}
                          onChange={(e) => setZoteroConfig((cur) => ({ ...cur, includeSubcollections: e.target.checked }))}
                        />
                        <span className="subtle">Include subcollections</span>
                      </label>
                    </div>
                    <select
                      value={zoteroConfig.collectionId ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const id = raw ? Number(raw) : null;
                        setZoteroConfig((cur) => ({ ...cur, collectionId: id && Number.isFinite(id) ? id : null }));
                      }}
                    >
                      <option value="">Select a collection…</option>
                      {zoteroCollections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.path}
                        </option>
                      ))}
                    </select>
                    <p className="subtle" style={{ margin: 0 }}>
                      {selectedZoteroCollection ? `Selected: ${selectedZoteroCollection.path}` : 'No collection selected.'}
                    </p>
                  </div>
                )}
              </div>

              <div className="settings-actions">
                <button className="primary" type="submit" disabled={saving}>
                  {saving ? 'Saving…' : saved ? 'Saved!' : 'Save changes'}
                </button>
              </div>
            </form>
          )}

          {activePane === 'domains' && (
            <Domains api={api} variant="settings" />
          )}

          {activePane === 'economy' && (
            <EconomyTuner api={api} />
          )}

          {activePane === 'system' && (
            <div className="settings-pane-body">
              {resetMessage && (
                <div className={`settings-banner ${resetScope === 'all' ? 'danger' : 'success'}`}>
                  <div>
                    <strong>{resetMessage}</strong>
                    <div className="subtle">You may need to refresh to see empty states.</div>
                  </div>
                </div>
              )}
              <section className="card settings-section">
                <div className="settings-section-header">
                  <h3>Reset data</h3>
                  <p className="subtle">Start fresh. Choose what to clear.</p>
                </div>
                <div className="settings-stack">
                  <label className="settings-inline">
                    <input
                      type="radio"
                      name="reset-scope"
                      value="trophies"
                      checked={resetScope === 'trophies'}
                      onChange={() => setResetScope('trophies')}
                    />
                    <span className="subtle">Reset trophy case only</span>
                  </label>
                  <label className="settings-inline">
                    <input
                      type="radio"
                      name="reset-scope"
                      value="all"
                      checked={resetScope === 'all'}
                      onChange={() => setResetScope('all')}
                    />
                    <span className="subtle">Reset everything (wallet, history, trophies, library)</span>
                  </label>
                  <p className="subtle" style={{ margin: 0 }}>
                    This also removes the selected data from cloud sync if you are signed in.
                  </p>
                  <button type="button" className="secondary" onClick={handleReset} disabled={resetBusy}>
                    {resetBusy ? 'Resetting…' : 'Reset now'}
                  </button>
                </div>
              </section>

              <section className="card">
                <h2>Accessibility permissions</h2>
                <ol className="instructions">
                  <li>Open System Settings → Privacy &amp; Security → Accessibility.</li>
                  <li>Click the lock to make changes and authenticate.</li>
                  <li>Find “TimeWellSpent” in the list and toggle it on.</li>
                  <li>Repeat under “Automation” to allow browser control.</li>
                </ol>
                <p className="subtle">You can paste <code>x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility</code> into Spotlight to jump there quickly.</p>
              </section>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
