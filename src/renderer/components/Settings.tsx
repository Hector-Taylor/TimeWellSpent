import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { EmergencyPolicyId, JournalConfig, RendererApi, ZoteroCollection, ZoteroIntegrationConfig, ZoteroIntegrationMode } from '@shared/types';

interface SettingsProps {
  api: RendererApi;
}

export default function Settings({ api }: SettingsProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [idleThreshold, setIdleThreshold] = useState(15);
  const [frivolousIdleThreshold, setFrivolousIdleThreshold] = useState(15);
  const [emergencyPolicy, setEmergencyPolicy] = useState<EmergencyPolicyId>('balanced');
  const [emergencyReminderInterval, setEmergencyReminderInterval] = useState(300);
  const [journalUrl, setJournalUrl] = useState('');
  const [journalMinutes, setJournalMinutes] = useState(10);

  const [zoteroConfig, setZoteroConfig] = useState<ZoteroIntegrationConfig>({
    mode: 'recent',
    collectionId: null,
    includeSubcollections: true
  });
  const [zoteroCollections, setZoteroCollections] = useState<ZoteroCollection[]>([]);
  const [zoteroCollectionsLoading, setZoteroCollectionsLoading] = useState(false);

  useEffect(() => {
    api.settings.idleThreshold().then(setIdleThreshold);
    api.settings.frivolousIdleThreshold().then(setFrivolousIdleThreshold);
    api.settings.emergencyPolicy().then(setEmergencyPolicy);
    api.settings.emergencyReminderInterval().then(setEmergencyReminderInterval);
    api.settings.journalConfig().then((cfg: JournalConfig) => {
      setJournalUrl(cfg.url ?? '');
      setJournalMinutes(cfg.minutes ?? 10);
    }).catch(() => { });
    api.integrations.zotero.config().then(setZoteroConfig).catch(() => { });
  }, [api.settings, api.integrations.zotero]);

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

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api.settings.updateIdleThreshold(idleThreshold);
      await api.settings.updateFrivolousIdleThreshold(frivolousIdleThreshold);
      await api.settings.updateEmergencyPolicy(emergencyPolicy);
      await api.settings.updateEmergencyReminderInterval(emergencyReminderInterval);
      await api.settings.updateJournalConfig({ url: journalUrl.trim() ? journalUrl.trim() : null, minutes: journalMinutes });
      await api.integrations.zotero.updateConfig(zoteroConfig);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h1>Settings</h1>
          <p className="subtle">Policies + integrations. Domain classification lives in the Domains page.</p>
        </div>
      </header>

      {error && <p className="error-text">{error}</p>}

      <form className="settings-grid" onSubmit={save}>
        <label>
          Idle Threshold (seconds)
          <input
            type="number"
            min="5"
            max="300"
            value={idleThreshold}
            onChange={(e) => setIdleThreshold(Number(e.target.value))}
          />
          <p className="subtle">Time before activity is considered idle.</p>
        </label>

        <label>
          Frivolous Idle Threshold (seconds)
          <input
            type="number"
            min="5"
            max="300"
            value={frivolousIdleThreshold}
            onChange={(e) => setFrivolousIdleThreshold(Number(e.target.value))}
          />
          <p className="subtle">Treat passive scrolling/buffering on frivolous domains as idle sooner.</p>
        </label>

        <label>
          Emergency Policy
          <select value={emergencyPolicy} onChange={(e) => setEmergencyPolicy(e.target.value as EmergencyPolicyId)}>
            <option value="off">Off</option>
            <option value="gentle">Gentle</option>
            <option value="balanced">Balanced</option>
            <option value="strict">Strict</option>
          </select>
          <p className="subtle">Controls how “I need it” behaves in the browser paywall.</p>
          <div className="subtle" style={{ marginTop: 8 }}>
            <div><strong>Off</strong>: removes the emergency escape hatch.</div>
            <div><strong>Gentle</strong>: 5m window, URL-locked, unlimited/day, no cost.</div>
            <div><strong>Balanced</strong>: 3m window, URL-locked, 2/day, 30m cooldown, adds a small “debt” cost.</div>
            <div><strong>Strict</strong>: 2m window, URL-locked, 1/day, 60m cooldown, larger “debt” cost.</div>
          </div>
        </label>

        <label>
          Emergency Reminder Interval (seconds)
          <input
            type="number"
            min="30"
            max="3600"
            value={emergencyReminderInterval}
            onChange={(e) => setEmergencyReminderInterval(Number(e.target.value))}
          />
          <p className="subtle">How often to nudge you during an emergency session.</p>
        </label>

        <label style={{ gridColumn: '1 / -1' }}>
          Zotero “Try this instead” source
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
            <option value="recent">Recent items (automatic)</option>
            <option value="collection">Specific collection</option>
          </select>
          <p className="subtle">
            Choose a Zotero collection if you want the paywall to only suggest papers you intentionally curated.
          </p>
          {zoteroConfig.mode === 'collection' && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
                <button
                  type="button"
                  className="ghost"
                  onClick={refreshZoteroCollections}
                  disabled={zoteroCollectionsLoading}
                >
                  {zoteroCollectionsLoading ? 'Loading collections…' : 'Refresh collections'}
                </button>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0 }}>
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
                <option value="">Select a Zotero collection…</option>
                {zoteroCollections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.path}
                  </option>
                ))}
              </select>
              <p className="subtle" style={{ margin: 0 }}>
                {selectedZoteroCollection ? `Selected: ${selectedZoteroCollection.path}` : 'Select a collection to use.'}
              </p>
            </div>
          )}
        </label>

        <label style={{ gridColumn: '1 / -1' }}>
          Journaling shortcut
          <input
            type="text"
            placeholder="https://app.tana.inc/… (or Notion, etc)"
            value={journalUrl}
            onChange={(e) => setJournalUrl(e.target.value)}
          />
          <div style={{ marginTop: 10, display: 'grid', gap: 8, maxWidth: 260 }}>
            <div style={{ fontWeight: 500, fontSize: 13 }}>Duration (minutes)</div>
            <input
              type="number"
              min="1"
              max="180"
              value={journalMinutes}
              onChange={(e) => setJournalMinutes(Number(e.target.value))}
            />
            <p className="subtle" style={{ margin: 0 }}>Used by “Try this instead” journaling prompts.</p>
          </div>
          <p className="subtle" style={{ marginTop: 6 }}>
            Set this to the place you write: Tana, Notion, Obsidian publish link, etc. Leave blank to hide the journaling ritual.
          </p>
        </label>

        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : saved ? 'Saved!' : 'Save changes'}
        </button>
      </form>

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
    </section>
  );
}
