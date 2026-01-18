import { useEffect, useMemo, useState } from 'react';
import type { RendererApi, TrophyProfileSummary, TrophyStatus } from '@shared/types';
import { TROPHY_CATEGORY_LABELS } from '@shared/trophies';

type Props = {
  api: RendererApi;
};

const MAX_PINNED = 6;

function formatMinutes(value: number) {
  return `${Math.round(value)}m`;
}

function formatHours(value: number) {
  return value >= 10 ? `${value.toFixed(0)}h` : `${value.toFixed(1)}h`;
}

export default function Profile({ api }: Props) {
  const [summary, setSummary] = useState<TrophyProfileSummary | null>(null);
  const [trophies, setTrophies] = useState<TrophyStatus[]>([]);
  const [previewMode, setPreviewMode] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [profileSummary, statuses] = await Promise.all([
      api.trophies.profile(),
      api.trophies.list()
    ]);
    setSummary(profileSummary);
    setTrophies(statuses);
  };

  useEffect(() => {
    refresh();
  }, []);

  const pinnedIds = useMemo(() => {
    if (summary?.pinnedTrophies?.length) return summary.pinnedTrophies;
    return trophies.filter((t) => t.pinned).map((t) => t.id);
  }, [summary, trophies]);

  const trophyById = useMemo(() => {
    const map = new Map<string, TrophyStatus>();
    trophies.forEach((trophy) => map.set(trophy.id, trophy));
    return map;
  }, [trophies]);

  const pinnedTrophies = pinnedIds
    .map((id) => trophyById.get(id))
    .filter((trophy): trophy is TrophyStatus => Boolean(trophy));

  const nextUp = useMemo(() => {
    return trophies
      .filter((trophy) => trophy.progress.state === 'locked')
      .sort((a, b) => (b.progress.ratio - a.progress.ratio))
      .slice(0, 4);
  }, [trophies]);

  const grouped = useMemo(() => {
    const groups = new Map<string, TrophyStatus[]>();
    trophies.forEach((trophy) => {
      const key = trophy.category;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(trophy);
    });
    return groups;
  }, [trophies]);

  const handleTogglePin = async (trophyId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = pinnedIds.includes(trophyId)
        ? pinnedIds.filter((id) => id !== trophyId)
        : [...pinnedIds, trophyId].slice(0, MAX_PINNED);
      const pinned = await api.trophies.pin(next);
      setSummary((prev) => (prev ? { ...prev, pinnedTrophies: pinned } : prev));
      setTrophies((prev) => prev.map((trophy) => ({
        ...trophy,
        pinned: pinned.includes(trophy.id)
      })));
    } finally {
      setBusy(false);
    }
  };

  const profileName = summary?.profile?.displayName ?? summary?.profile?.handle ?? 'You';
  const profileHandle = summary?.profile?.handle ? `@${summary.profile.handle}` : 'Not synced yet';
  const profileColor = summary?.profile?.color ?? 'var(--accent)';

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Profile</p>
          <h1>Trophy case</h1>
          <p className="subtle">Your public card, progression, and achievements.</p>
        </div>
        <button
          type="button"
          className={`pill ghost ${previewMode ? 'active' : ''}`}
          onClick={() => setPreviewMode((prev) => !prev)}
        >
          {previewMode ? 'Hide preview' : 'Public preview'}
        </button>
      </header>

      <div className="profile-grid">
        <div className="card profile-card">
          <div className="profile-card-header">
            <div className="profile-avatar" style={{ background: profileColor }}>
              {profileName.trim().slice(0, 2).toUpperCase()}
            </div>
            <div>
              <h2>{profileName}</h2>
              <span className="subtle">{profileHandle}</span>
            </div>
          </div>
          <div className="profile-stats">
            <div>
              <span className="label">Weekly productive</span>
              <strong>{summary ? formatMinutes(summary.stats.weeklyProductiveMinutes) : '--'}</strong>
            </div>
            <div>
              <span className="label">Best run</span>
              <strong>{summary ? formatHours(summary.stats.bestRunMinutes / 60) : '--'}</strong>
            </div>
            <div>
              <span className="label">Recovery median</span>
              <strong>{summary?.stats.recoveryMedianMinutes != null ? `${Math.round(summary.stats.recoveryMedianMinutes)}m` : '--'}</strong>
            </div>
            <div>
              <span className="label">Frivolity streak</span>
              <strong>{summary ? `${summary.stats.currentFrivolityStreakHours}h` : '--'}</strong>
            </div>
          </div>
          <div className="profile-pinned">
            <div className="profile-pinned-header">
              <span className="label">Pinned trophies</span>
              <span className="subtle">{pinnedTrophies.length}/{MAX_PINNED}</span>
            </div>
            {pinnedTrophies.length === 0 ? (
              <p className="subtle" style={{ margin: 0 }}>Pin a few trophies so friends can see them.</p>
            ) : (
              <div className="profile-badges">
                {pinnedTrophies.map((trophy) => (
                  <div key={trophy.id} className="trophy-badge">
                    <span className="emoji">{trophy.emoji}</span>
                    <span>{trophy.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="card profile-next">
          <div className="card-header-row">
            <div>
              <p className="eyebrow">Next up</p>
              <h2>Close to unlocking</h2>
            </div>
          </div>
          {nextUp.length === 0 ? (
            <p className="subtle">No tracked trophies yet. Keep logging activity.</p>
          ) : (
            <div className="next-list">
              {nextUp.map((trophy) => (
                <div key={trophy.id} className="next-item">
                  <div className="next-item-header">
                    <span className="emoji">{trophy.emoji}</span>
                    <div>
                      <strong>{trophy.name}</strong>
                      <span className="subtle">{trophy.description}</span>
                    </div>
                  </div>
                  <div className="progress-bar">
                    <span style={{ width: `${Math.round(trophy.progress.ratio * 100)}%` }} />
                  </div>
                  <span className="subtle">{trophy.progress.label ?? `${trophy.progress.current}/${trophy.progress.target}`}</span>
                </div>
              ))}
            </div>
          )}
          {summary?.earnedToday?.length ? (
            <div className="earned-today">
              <span className="label">Earned today</span>
              <div className="profile-badges">
                {summary.earnedToday.map((id) => {
                  const trophy = trophyById.get(id);
                  if (!trophy) return null;
                  return (
                    <div key={id} className="trophy-badge">
                      <span className="emoji">{trophy.emoji}</span>
                      <span>{trophy.name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {previewMode && (
        <div className="card profile-preview">
          <div className="card-header-row">
            <div>
              <p className="eyebrow">Public preview</p>
              <h2>What friends see</h2>
            </div>
          </div>
          <div className="profile-preview-card">
            <div className="profile-avatar" style={{ background: profileColor }}>
              {profileName.trim().slice(0, 2).toUpperCase()}
            </div>
            <div>
              <strong>{profileName}</strong>
              <span className="subtle">{profileHandle}</span>
            </div>
            <div className="profile-preview-badges">
              {pinnedTrophies.length === 0 ? (
                <span className="subtle">No pinned trophies yet.</span>
              ) : pinnedTrophies.map((trophy) => (
                <span key={trophy.id} className="trophy-badge">
                  <span className="emoji">{trophy.emoji}</span>
                  {trophy.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="card trophy-case">
        <div className="card-header-row">
          <div>
            <p className="eyebrow">Trophy case</p>
            <h2>Full collection</h2>
          </div>
          <span className="subtle">Pin trophies to feature them on your card.</span>
        </div>
        {Array.from(grouped.entries()).map(([category, list]) => (
          <div key={category} className="trophy-group">
            <h3>{TROPHY_CATEGORY_LABELS[category as keyof typeof TROPHY_CATEGORY_LABELS]}</h3>
            <div className="trophy-grid">
              {list.map((trophy) => {
                const locked = !trophy.earnedAt;
                const isSecret = trophy.secret && locked;
                return (
                  <div key={trophy.id} className={`trophy-card ${locked ? 'locked' : 'earned'}`}>
                    <div className="trophy-card-header">
                      <span className="emoji">{isSecret ? '❓' : trophy.emoji}</span>
                      <button
                        type="button"
                        className={`pill ghost ${trophy.pinned ? 'active' : ''}`}
                        onClick={() => handleTogglePin(trophy.id)}
                        disabled={busy || !trophy.earnedAt}
                        title={trophy.earnedAt ? 'Pin to profile' : 'Earn to pin'}
                      >
                        {trophy.pinned ? 'Pinned' : 'Pin'}
                      </button>
                    </div>
                    <strong>{isSecret ? 'Classified' : trophy.name}</strong>
                    <p className="subtle">{isSecret ? 'Keep going to reveal this trophy.' : trophy.description}</p>
                    {trophy.progress.state === 'untracked' ? (
                      <span className="subtle">{trophy.progress.label}</span>
                    ) : (
                      <div className="progress-bar">
                        <span style={{ width: `${Math.round(trophy.progress.ratio * 100)}%` }} />
                      </div>
                    )}
                    {trophy.earnedAt && (
                      <span className="subtle">Earned {new Date(trophy.earnedAt).toLocaleDateString()}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
