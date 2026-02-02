import { useEffect, useMemo, useState } from 'react';
import type { FriendConnection, FriendProfile, FriendRequest, FriendSummary, FriendTimeline, RendererApi, TrophyStatus } from '@shared/types';
import FriendDetailModal from './FriendDetailModal';

type Props = {
  api: RendererApi;
};

function normalizeHandle(raw: string) {
  const trimmed = raw.trim().replace(/^@/, '');
  return trimmed.toLowerCase();
}

function formatHoursFromSeconds(seconds: number) {
  const hours = seconds / 3600;
  return hours >= 10 ? `${hours.toFixed(0)}h` : `${hours.toFixed(1)}h`;
}

function formatPct(n: number) {
  return `${Math.max(0, Math.min(100, Math.round(n)))}%`;
}

function formatMinutes(seconds: number) {
  return `${Math.round(seconds / 60)}m`;
}

function formatCount(value?: number | null) {
  if (typeof value !== 'number') return '—';
  return String(value);
}

function headToHeadPercent(me: FriendSummary | null, friend: FriendSummary | null) {
  const myProductive = me?.categoryBreakdown.productive ?? 0;
  const friendProductive = friend?.categoryBreakdown.productive ?? 0;
  const total = myProductive + friendProductive;
  if (total === 0) return 50;
  return Math.round((myProductive / total) * 100);
}

export default function Friends({ api }: Props) {
  const [profile, setProfile] = useState<FriendProfile | null>(null);
  const [friends, setFriends] = useState<FriendConnection[]>([]);
  const [requests, setRequests] = useState<{ incoming: FriendRequest[]; outgoing: FriendRequest[] }>({ incoming: [], outgoing: [] });
  const [summaries, setSummaries] = useState<Record<string, FriendSummary>>({});
  const [mySummary, setMySummary] = useState<FriendSummary | null>(null);
  const [myProfile, setMyProfile] = useState<FriendProfile | null>(null);
  const [selectedFriend, setSelectedFriend] = useState<FriendConnection | null>(null);
  const [selectedTimeline, setSelectedTimeline] = useState<FriendTimeline | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [trophies, setTrophies] = useState<TrophyStatus[]>([]);
  const [handleInput, setHandleInput] = useState('');
  const [addHandle, setAddHandle] = useState('');
  const [handlePreview, setHandlePreview] = useState<FriendProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncReady, setSyncReady] = useState(false);
  const [competitiveOptIn, setCompetitiveOptIn] = useState(false);
  const [competitiveMinHours, setCompetitiveMinHours] = useState(2);

  async function refreshAll() {
    setError(null);
    try {
      const status = await api.sync.status();
      const ready = status.configured && status.authenticated;
      setSyncReady(ready);
      if (!ready) return;
      const [profileResult, friendResult, requestResult, summaryResult, mySummaryResult, trophyResult, competitive, minHours] = await Promise.all([
        api.friends.profile(),
        api.friends.list(),
        api.friends.requests(),
        api.friends.summaries(24),
        api.friends.meSummary(24),
        api.trophies.list(),
        api.settings.competitiveOptIn(),
        api.settings.competitiveMinActiveHours()
      ]);
      setProfile(profileResult);
      setMyProfile(profileResult);
      setHandleInput(profileResult?.handle ?? '');
      setFriends(friendResult);
      setRequests(requestResult);
      setSummaries(summaryResult);
      setMySummary(mySummaryResult);
      setTrophies(trophyResult);
      setCompetitiveOptIn(competitive);
      setCompetitiveMinHours(minHours);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    refreshAll();
  }, []);

  const friendCards = useMemo(() => {
    return friends.map((friend) => {
      const summary = summaries[friend.userId];
      const totals = summary?.categoryBreakdown ?? null;
      const active = summary?.totalActiveSeconds ?? 0;
      const draining = totals?.draining ?? 0;
      const productivePct = active > 0 ? (totals!.productive / active) * 100 : 0;
      const neutralPct = active > 0 ? (totals!.neutral / active) * 100 : 0;
      const frivolityPct = active > 0 ? (totals!.frivolity / active) * 100 : 0;
      const drainingPct = active > 0 ? (draining / active) * 100 : 0;
      return { friend, summary, totals, productivePct, neutralPct, frivolityPct, drainingPct };
    });
  }, [friends, summaries]);

  // Competitive head-to-head is gated until both sides cross a daily active-time threshold.
  const competitiveGateSeconds = Math.max(0, competitiveMinHours) * 3600;
  const meetsCompetitiveGate = (summary: FriendSummary | null) => {
    if (!summary) return false;
    return summary.totalActiveSeconds >= competitiveGateSeconds;
  };

  const trophyById = useMemo(() => {
    const map = new Map<string, TrophyStatus>();
    trophies.forEach((trophy) => map.set(trophy.id, trophy));
    return map;
  }, [trophies]);

  async function updateHandle() {
    setError(null);
    setBusy(true);
    try {
      const updated = await api.friends.updateProfile({ handle: normalizeHandle(handleInput) });
      setProfile(updated);
      setHandleInput(updated.handle ?? '');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function previewHandle() {
    setHandlePreview(null);
    const normalized = normalizeHandle(addHandle);
    if (!normalized) return;
    try {
      const result = await api.friends.findByHandle(normalized);
      setHandlePreview(result);
    } catch {
      setHandlePreview(null);
    }
  }

  async function sendRequest() {
    setError(null);
    setBusy(true);
    try {
      await api.friends.request(normalizeHandle(addHandle));
      setAddHandle('');
      setHandlePreview(null);
      await refreshAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function acceptRequest(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.friends.accept(id);
      await refreshAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function declineRequest(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.friends.decline(id);
      await refreshAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelRequest(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.friends.cancel(id);
      await refreshAll();
    } catch (err) {
      setError((err as Error).message);
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
      await refreshAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openFriendDetail(friend: FriendConnection) {
    setSelectedFriend(friend);
    setSelectedTimeline(null);
    setDetailOpen(true);
    try {
      const timeline = await api.friends.timeline(friend.userId, 24);
      setSelectedTimeline(timeline);
    } catch (err) {
      console.error('Failed to load friend detail', err);
    }
  }

  async function toggleCompetitive(next: boolean) {
    setCompetitiveOptIn(next);
    try {
      await api.settings.updateCompetitiveOptIn(next);
    } catch (err) {
      setError((err as Error).message || 'Failed to update preference');
      setCompetitiveOptIn(!next);
    }
  }

  async function updateCompetitiveMinHours(next: number) {
    setCompetitiveMinHours(next);
    try {
      await api.settings.updateCompetitiveMinActiveHours(next);
    } catch (err) {
      setError((err as Error).message || 'Failed to update competitive gate');
    }
  }

  if (!syncReady) {
    return (
      <section className="page store-page">
        <header className="page-header">
          <div>
            <h1>Friends</h1>
            <p className="subtle">Add a friend by handle once you are signed in.</p>
          </div>
        </header>
        <div className="card">
          <h3>Connect Sync</h3>
          <p className="subtle">Friends require Supabase auth. Go to Settings → Cloud sync and connect.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="page store-page">
      <header className="page-header">
        <div>
          <h1>Friends</h1>
          <p className="subtle">A low-key feed of daily focus — aggregates only (no URLs).</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="ghost" disabled={busy} onClick={refreshAll}>Refresh</button>
        </div>
      </header>

      {error && <p className="error-text">{error}</p>}

      <div className="card settings-section" style={{ marginBottom: 16 }}>
        <div className="settings-section-header">
          <h3>Competitive view</h3>
          <p className="subtle" style={{ margin: 0 }}>Opt in to show winners/losers and head-to-head bars.</p>
        </div>
        <div className="settings-row">
          <label className="settings-inline" style={{ alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={competitiveOptIn}
              onChange={(e) => toggleCompetitive(e.target.checked)}
            />
            <span className="subtle">{competitiveOptIn ? 'Enabled' : 'Disabled'}</span>
          </label>
          <label>
            Min active hours
            <input
              type="number"
              min="0"
              max="12"
              step="0.5"
              value={competitiveMinHours}
              onChange={(e) => updateCompetitiveMinHours(Number(e.target.value))}
            />
          </label>
        </div>
        <p className="subtle" style={{ margin: 0 }}>
          Head-to-head only shows once both sides cross this daily active time.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Your handle</h3>
        <div className="settings-grid" style={{ gridTemplateColumns: '1fr auto', alignItems: 'end' }}>
          <label>
            Handle
            <input
              value={handleInput}
              onChange={(e) => setHandleInput(e.target.value)}
              placeholder="e.g. timewell"
            />
          </label>
          <button className="primary" disabled={busy} onClick={updateHandle}>Update</button>
        </div>
        <p className="subtle" style={{ marginTop: 8 }}>
          Handles are lowercase letters, numbers, and underscores (3-20).
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Add friend</h3>
        <div className="settings-grid" style={{ gridTemplateColumns: '1fr auto', alignItems: 'end' }}>
          <label>
            Friend handle
            <input
              value={addHandle}
              onChange={(e) => setAddHandle(e.target.value)}
              onBlur={previewHandle}
              placeholder="@friend"
            />
          </label>
          <button className="primary" disabled={busy || !addHandle.trim()} onClick={sendRequest}>Send request</button>
        </div>
        {handlePreview && (
          <p className="subtle" style={{ marginTop: 8 }}>
            Found {handlePreview.displayName ?? handlePreview.handle ?? 'friend'}.
          </p>
        )}
      </div>

      {(requests.incoming.length > 0 || requests.outgoing.length > 0) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Requests</h3>
          {requests.incoming.map((request) => (
            <div key={request.id} className="device-row" style={{ marginBottom: 8 }}>
              <div>
                <strong>{request.displayName ?? request.handle ?? 'Friend'}</strong>
                <span className="subtle">Incoming</span>
              </div>
              <div className="settings-actions">
                <button className="primary" disabled={busy} onClick={() => acceptRequest(request.id)}>Accept</button>
                <button className="ghost" disabled={busy} onClick={() => declineRequest(request.id)}>Decline</button>
              </div>
            </div>
          ))}
          {requests.outgoing.map((request) => (
            <div key={request.id} className="device-row" style={{ marginBottom: 8 }}>
              <div>
                <strong>{request.displayName ?? request.handle ?? 'Friend'}</strong>
                <span className="subtle">Pending</span>
              </div>
              <div className="settings-actions">
                <button className="ghost" disabled={busy} onClick={() => cancelRequest(request.id)}>Cancel</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="store-grid">
        {friends.length === 0 ? (
          <div className="empty-state">
            <p>No friends yet.</p>
            <p className="subtle">Add a handle to start a tiny, supportive feed.</p>
          </div>
        ) : (
          friendCards.map(({ friend, summary, totals, productivePct, neutralPct, frivolityPct }) => {
            const friendTrophies = (friend.pinnedTrophies ?? [])
              .map((id) => trophyById.get(id))
              .filter((trophy): trophy is TrophyStatus => Boolean(trophy));
            return (
            <div key={friend.id} className="card store-item">
              <div className="store-item-headline">
                <div>
                  <p className="store-item-domain">{friend.displayName ?? friend.handle ?? 'Friend'}</p>
                  <h3 className="store-item-title">{summary ? `${summary.productivityScore}% productive` : 'No data yet'}</h3>
                </div>
                <div className="store-item-price-pill">
                  <strong>{summary ? formatHoursFromSeconds(summary.totalActiveSeconds) : '—'}</strong>
                  <span>active</span>
                </div>
                {summary && (
                  <div className="pill deepwork" style={{ marginLeft: 'auto' }}>
                    {formatMinutes(summary.deepWorkSeconds)} deep work
                  </div>
                )}
              </div>

              {competitiveOptIn ? (
                <div className="head-to-head">
                  {meetsCompetitiveGate(mySummary) && meetsCompetitiveGate(summary) ? (
                    <>
                      <div className="head-to-head-row">
                        <span>You</span>
                        <span>{summary ? friend.displayName ?? friend.handle ?? 'Friend' : 'Friend'}</span>
                      </div>
                      <div className="head-to-head-bar fancy">
                        <span
                          className="head-to-head-left"
                          style={{ width: `${headToHeadPercent(mySummary, summary)}%`, background: myProfile?.color ?? 'var(--accent)' }}
                        />
                        <span
                          className="head-to-head-right"
                          style={{ width: `${100 - headToHeadPercent(mySummary, summary)}%`, background: friend.color ?? 'rgba(255, 255, 255, 0.3)' }}
                        />
                        <div className="head-to-head-glow" />
                      </div>
                      <div className="head-to-head-row subtle">
                        <span>{formatMinutes(mySummary?.categoryBreakdown.productive ?? 0)} productive</span>
                        <span>{formatMinutes(summary?.categoryBreakdown.productive ?? 0)} productive</span>
                      </div>
                      <div className="head-to-head-row subtle">
                        <span>{formatCount(mySummary?.emergencySessions)} emergency</span>
                        <span>{formatCount(summary?.emergencySessions)} emergency</span>
                      </div>
                    </>
                  ) : (
                    <p className="subtle" style={{ marginTop: 6 }}>
                      Both need {competitiveMinHours}h active to unlock.
                    </p>
                  )}
                </div>
              ) : (
                <p className="subtle" style={{ marginTop: 10 }}>Competitive view is off.</p>
              )}

              {friendTrophies.length > 0 && (
                <div className="friends-trophies">
                  {friendTrophies.slice(0, 3).map((trophy) => (
                    <span key={trophy.id} className="trophy-badge">
                      <span className="emoji">{trophy.emoji}</span>
                      {trophy.name}
                    </span>
                  ))}
                </div>
              )}

              {summary && totals && (
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

                  <div className="subtle" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                    <span>Draining</span><span>{formatHoursFromSeconds(totals.draining ?? 0)} ({formatPct(drainingPct)})</span>
                  </div>
                  <div className="impact-meter" style={{ marginTop: 6 }}>
                    <span style={{ width: `${drainingPct}%`, background: 'var(--cat-draining)' }} />
                  </div>
                </div>
              )}

              <div className="store-item-meta">
                <span>Last update {summary ? new Date(summary.updatedAt).toLocaleString() : '—'}</span>
                <span>@{friend.handle ?? 'no-handle'}</span>
              </div>

              <div className="store-item-actions">
                <button className="ghost" disabled={busy} onClick={() => openFriendDetail(friend)}>Details</button>
                <button className="ghost danger" disabled={busy} onClick={() => removeFriend(friend.id)}>Remove</button>
              </div>
            </div>
          );
        })
        )}
      </div>

      <FriendDetailModal
        open={detailOpen}
        friend={selectedFriend}
        summary={selectedFriend ? summaries[selectedFriend.userId] ?? null : null}
        timeline={selectedTimeline}
        trophies={trophies}
        onClose={() => setDetailOpen(false)}
      />
    </section>
  );
}
