import { useEffect, useMemo, useState } from 'react';
import type { FriendEntry, FriendFeedSummary, FriendIdentity, RendererApi } from '@shared/types';

type Props = {
  api: RendererApi;
};

function parseFriendCode(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Accept formats:
  // - userId:readKey
  // - userId|readKey
  // - JSON {"userId":"...","readKey":"..."}
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { userId?: string; readKey?: string };
      if (parsed.userId && parsed.readKey) return { userId: String(parsed.userId), readKey: String(parsed.readKey) };
    } catch { }
  }

  const parts = trimmed.split(/[:|]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { userId: parts[0], readKey: parts[1] };
  return null;
}

function formatHoursFromSeconds(seconds: number) {
  const hours = seconds / 3600;
  return hours >= 10 ? `${hours.toFixed(0)}h` : `${hours.toFixed(1)}h`;
}

function formatPct(n: number) {
  return `${Math.max(0, Math.min(100, Math.round(n)))}%`;
}

export default function Friends({ api }: Props) {
  const [identity, setIdentity] = useState<FriendIdentity | null>(null);
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [feed, setFeed] = useState<Record<string, FriendFeedSummary | null>>({});
  const [relayUrl, setRelayUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [addName, setAddName] = useState('');
  const [addCode, setAddCode] = useState('');

  const myCode = useMemo(() => {
    if (!identity) return null;
    return `${identity.userId}:${identity.readKey}`;
  }, [identity]);

  useEffect(() => {
    api.friends.identity().then((ident) => {
      setIdentity(ident);
      setRelayUrl(ident?.relayUrl ?? '');
    });
    api.friends.list().then(setFriends);
  }, [api.friends]);

  useEffect(() => {
    const unsubUpdated = api.events.on<Record<string, FriendFeedSummary | null>>('friends:updated', setFeed);
    const unsubPublished = api.events.on('friends:published', () => { });
    return () => {
      unsubUpdated();
      unsubPublished();
    };
  }, [api.events]);

  async function enable() {
    setError(null);
    setBusy(true);
    try {
      const ident = await api.friends.enable({ relayUrl });
      setIdentity(ident);
      setRelayUrl(ident.relayUrl);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!confirm('Disable Friends Feed? This only disables publishing from this device.')) return;
    setError(null);
    setBusy(true);
    try {
      await api.friends.disable();
      setIdentity(null);
      setFeed({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setError(null);
    setBusy(true);
    try {
      await api.friends.publishNow();
      const ident = await api.friends.identity();
      setIdentity(ident);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!identity) return;
    setError(null);
    setBusy(true);
    try {
      const data = await api.friends.fetchAll();
      setFeed(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addFriend() {
    setError(null);
    const parsed = parseFriendCode(addCode);
    if (!parsed) {
      setError('Friend code must look like userId:readKey');
      return;
    }
    if (!addName.trim()) {
      setError('Name is required');
      return;
    }
    setBusy(true);
    try {
      const entry = await api.friends.add({ name: addName.trim(), userId: parsed.userId, readKey: parsed.readKey });
      setFriends((cur) => [entry, ...cur]);
      setAddName('');
      setAddCode('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeFriend(id: string) {
    if (!confirm('Remove this friend?')) return;
    setBusy(true);
    setError(null);
    try {
      await api.friends.remove(id);
      setFriends((cur) => cur.filter((f) => f.id !== id));
      setFeed((cur) => {
        const next = { ...cur };
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page store-page">
      <header className="page-header">
        <div>
          <h1>Friends</h1>
          <p className="subtle">A low-key feed of daily focus — aggregates only (no URLs).</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="ghost" disabled={busy || !identity} onClick={refresh}>Refresh</button>
          <button className="primary" disabled={busy || !identity} onClick={publish}>Publish now</button>
        </div>
      </header>

      {error && <p className="error-text">{error}</p>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Setup</h3>
        <p className="subtle" style={{ marginTop: 6 }}>
          Deploy the free relay in `relay/` (Cloudflare Workers + D1), then paste its URL here.
        </p>
        <div className="form-group" style={{ marginTop: 12 }}>
          <label>Relay URL</label>
          <input
            type="text"
            placeholder="https://tws-relay.yourname.workers.dev"
            value={relayUrl}
            onChange={(e) => setRelayUrl(e.target.value)}
          />
        </div>
        <div className="form-actions">
          {!identity ? (
            <button className="primary" disabled={busy} onClick={enable}>Enable Friends Feed</button>
          ) : (
            <>
              <button className="ghost" disabled={busy} onClick={disable}>Disable</button>
              <button className="ghost" disabled={busy} onClick={enable}>Update relay URL</button>
            </>
          )}
        </div>
        {identity && (
          <div style={{ marginTop: 12 }}>
            <p className="subtle">Share this friend code (treat it like a secret link):</p>
            <div className="card" style={{ padding: 12, marginTop: 8, background: 'rgba(255,255,255,0.03)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                <code style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{myCode}</code>
                <button
                  className="ghost"
                  disabled={!myCode}
                  onClick={() => myCode && navigator.clipboard.writeText(myCode)}
                >
                  Copy
                </button>
              </div>
              <p className="subtle" style={{ marginTop: 8 }}>
                Last published: {identity.lastPublishedAt ? new Date(identity.lastPublishedAt).toLocaleString() : 'never'}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Add friend</h3>
        <div className="settings-grid" style={{ gridTemplateColumns: '1fr 1.2fr auto', alignItems: 'end' }}>
          <label>
            Name
            <input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="e.g. Sam" />
          </label>
          <label>
            Friend code
            <input value={addCode} onChange={(e) => setAddCode(e.target.value)} placeholder="userId:readKey" />
          </label>
          <button className="primary" disabled={busy || !identity} onClick={addFriend}>Add</button>
        </div>
        {!identity && <p className="subtle" style={{ marginTop: 8 }}>Enable Friends Feed first.</p>}
      </div>

      <div className="store-grid">
        {friends.length === 0 ? (
          <div className="empty-state">
            <p>No friends yet.</p>
            <p className="subtle">Add one friend code to start a tiny, supportive feed.</p>
          </div>
        ) : (
          friends.map((friend) => {
            const summary = feed[friend.userId] ?? null;
            const payload = summary?.payload ?? null;
            const totals = payload?.categoryBreakdown ?? null;
            const active = totals ? (totals.productive + totals.neutral + totals.frivolity) : 0;
            const productivePct = active > 0 ? (totals!.productive / active) * 100 : 0;
            const frivolityPct = active > 0 ? (totals!.frivolity / active) * 100 : 0;
            const neutralPct = Math.max(0, 100 - productivePct - frivolityPct);

            return (
              <div key={friend.id} className="card store-item">
                <div className="store-item-headline">
                  <div>
                    <p className="store-item-domain">{friend.name}</p>
                    <h3 className="store-item-title">{payload ? `${payload.productivityScore}% productive` : 'No data yet'}</h3>
                  </div>
                  <div className="store-item-price-pill">
                    <strong>{payload ? `${payload.totalActiveHours}h` : '—'}</strong>
                    <span>active</span>
                  </div>
                </div>

                {payload && totals && (
                  <div style={{ marginTop: 10 }}>
                    <div className="subtle" style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Productive</span><span>{formatHoursFromSeconds(totals.productive)} ({formatPct(productivePct)})</span>
                    </div>
                    <div className="impact-meter" style={{ marginTop: 6 }}>
                      <span style={{ width: `${productivePct}%`, background: 'var(--cat-productive)' }} />
                    </div>

                    <div className="subtle" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                      <span>Neutral</span><span>{formatHoursFromSeconds(totals.neutral)} ({formatPct(neutralPct)})</span>
                    </div>
                    <div className="impact-meter day" style={{ marginTop: 6 }}>
                      <span style={{ width: `${neutralPct}%`, background: 'var(--cat-neutral)' }} />
                    </div>

                    <div className="subtle" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                      <span>Frivolity</span><span>{formatHoursFromSeconds(totals.frivolity)} ({formatPct(frivolityPct)})</span>
                    </div>
                    <div className="impact-meter" style={{ marginTop: 6 }}>
                      <span style={{ width: `${frivolityPct}%`, background: 'var(--cat-frivolity)' }} />
                    </div>
                  </div>
                )}

                <div className="store-item-meta">
                  <span>Last update {summary ? new Date(summary.updatedAt).toLocaleString() : '—'}</span>
                  <span>{summary ? `Date ${summary.date}` : ''}</span>
                </div>

                <div className="store-item-actions">
                  <button className="ghost danger" disabled={busy} onClick={() => removeFriend(friend.id)}>Remove</button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

