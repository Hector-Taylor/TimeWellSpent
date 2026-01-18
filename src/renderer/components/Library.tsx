import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConsumptionDaySummary, ConsumptionLogEntry, LibraryItem, LibraryPurpose, RendererApi } from '@shared/types';

type Props = {
  api: RendererApi;
};

const PURPOSES: Array<{ value: LibraryPurpose; label: string; hint: string }> = [
  { value: 'replace', label: 'Replace', hint: 'Shown in “Try this instead” when you hit a paywall.' },
  { value: 'productive', label: 'Productive', hint: 'Counts as productive time and appears in your productive shelf.' },
  { value: 'allow', label: 'Allow', hint: 'Good stuff you want nearby. Optional one-time unlock pricing.' },
  { value: 'temptation', label: 'Temptation', hint: 'Things you enjoy, but want contained and intentional.' }
];

function purposeLabel(purpose: LibraryPurpose) {
  return PURPOSES.find((p) => p.value === purpose)?.label ?? purpose;
}

function purposeTone(purpose: LibraryPurpose) {
  if (purpose === 'replace' || purpose === 'productive') return 'productive';
  if (purpose === 'temptation') return 'frivolity';
  return 'neutral';
}

function normaliseUrl(raw: string) {
  let url = raw.trim();
  if (!url) return null;
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

function normalisePrice(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
}

function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  return date.toLocaleDateString();
}

function formatTime(dateStr: string) {
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(day: string) {
  const date = new Date(`${day}T00:00:00`);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDayInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function capitalize(value: string) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function hashString(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function shortenUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function faviconUrl(url: string) {
  const domain = shortenUrl(url);
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function thumbUrl(url: string) {
  return `https://image.thum.io/get/width/640/${encodeURIComponent(url)}`;
}

export default function Library({ api }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<LibraryPurpose | 'all'>('replace');
  const [pricedOnly, setPricedOnly] = useState(false);
  const [viewMode, setViewMode] = useState<'library' | 'history'>('library');
  const [historyDay, setHistoryDay] = useState(() => formatDayInput(new Date()));
  const [historyEntries, setHistoryEntries] = useState<ConsumptionLogEntry[]>([]);
  const [historyDays, setHistoryDays] = useState<ConsumptionDaySummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [isAdding, setIsAdding] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newPurpose, setNewPurpose] = useState<LibraryPurpose>('replace');
  const [newPriceEnabled, setNewPriceEnabled] = useState(false);
  const [newPrice, setNewPrice] = useState(12);
  const [newTitle, setNewTitle] = useState('');
  const [newNote, setNewNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPurpose, setEditPurpose] = useState<LibraryPurpose>('replace');
  const [editPriceEnabled, setEditPriceEnabled] = useState(false);
  const [editPrice, setEditPrice] = useState(12);
  const [editTitle, setEditTitle] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const [isSaving, setIsSaving] = useState(false);

  const loadItems = useCallback(async () => {
    try {
      const data = await api.library.list();
      setItems(data);
      if (editingId && !data.some((item) => item.id === editingId)) {
        setEditingId(null);
      }
    } catch (err) {
      console.error('Failed to load library items:', err);
    } finally {
      setLoading(false);
    }
  }, [api.library, editingId]);

  const loadHistory = useCallback(async (day: string) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const [entries, days] = await Promise.all([
        api.history.list(day),
        api.history.days(30)
      ]);
      setHistoryEntries(entries);
      setHistoryDays(days);
    } catch (err) {
      console.error('Failed to load consumption history:', err);
      setHistoryError((err as Error).message || 'Failed to load history');
    } finally {
      setHistoryLoading(false);
    }
  }, [api.history]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  useEffect(() => {
    if (viewMode !== 'history') return;
    loadHistory(historyDay);
  }, [historyDay, loadHistory, viewMode]);

  useEffect(() => {
    const unsub = api.events.on('library:changed', () => loadItems());
    return () => unsub();
  }, [api, loadItems]);

  useEffect(() => {
    if (viewMode === 'history') {
      setIsAdding(false);
    }
  }, [viewMode]);

  const visible = useMemo(() => {
    let next = filter === 'all' ? items : items.filter((item) => item.purpose === filter);
    if (pricedOnly) next = next.filter((item) => typeof item.price === 'number');
    return next;
  }, [filter, items, pricedOnly]);

  const resetAddForm = () => {
    setNewUrl('');
    setNewPurpose('replace');
    setNewPriceEnabled(false);
    setNewPrice(12);
    setNewTitle('');
    setNewNote('');
    setError(null);
  };

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const url = normaliseUrl(newUrl);
    if (!url) return setError('Enter a valid URL (e.g. https://example.com).');

    let price: number | null | undefined = null;
    if (newPurpose === 'allow' && newPriceEnabled) {
      const n = normalisePrice(newPrice);
      if (!n) return setError('Unlock price must be a whole number of at least 1.');
      price = n;
    }

    setIsSaving(true);
    try {
      await api.library.add({
        kind: 'url',
        url,
        title: newTitle.trim() || undefined,
        note: newNote.trim() || undefined,
        purpose: newPurpose,
        price
      });
      setIsAdding(false);
      resetAddForm();
      await loadItems();
    } catch (err) {
      setError((err as Error).message || 'Failed to add item');
    } finally {
      setIsSaving(false);
    }
  };

  const startEdit = (item: LibraryItem) => {
    setEditingId(item.id);
    setEditPurpose(item.purpose);
    setEditPriceEnabled(typeof item.price === 'number');
    setEditPrice(typeof item.price === 'number' ? item.price : 12);
    setEditTitle(item.title ?? '');
    setEditNote(item.note ?? '');
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditError(null);
  };

  const handleUpdate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingId) return;
    setEditError(null);

    let price: number | null | undefined = null;
    if (editPurpose === 'allow' && editPriceEnabled) {
      const n = normalisePrice(editPrice);
      if (!n) return setEditError('Unlock price must be a whole number of at least 1.');
      price = n;
    }

    setIsSaving(true);
    try {
      const title = editTitle.trim();
      const note = editNote.trim();
      await api.library.update(editingId, {
        title: title ? title : null,
        note: note ? note : null,
        purpose: editPurpose,
        price
      });
      setEditingId(null);
      await loadItems();
    } catch (err) {
      setEditError((err as Error).message || 'Failed to update item');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async (id: number) => {
    if (!confirm('Remove this item from your library?')) return;
    try {
      await api.library.remove(id);
      await loadItems();
    } catch (err) {
      console.error('Failed to remove library item:', err);
    }
  };

  const handleToggleConsumed = async (item: LibraryItem) => {
    setIsSaving(true);
    try {
      const next = item.consumedAt ? null : new Date().toISOString();
      await api.library.update(item.id, { consumedAt: next });
      await loadItems();
    } catch (err) {
      console.error('Failed to update consumed status:', err);
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return <div className="panel">Loading library...</div>;
  }

  return (
    <section className="page store-page">
      <header className="page-header">
        <div>
          <h1>Library</h1>
          <p className="subtle">
            {viewMode === 'history'
              ? 'Review what you consumed by day — productive items and frivolous sessions.'
              : 'A calm, curated pool of “what I meant to do”. Replace is what the paywall offers you first.'}
          </p>
          <div className="library-tabs">
            <button
              type="button"
              className={`library-tab ${viewMode === 'library' ? 'active' : ''}`}
              onClick={() => setViewMode('library')}
            >
              Library
            </button>
            <button
              type="button"
              className={`library-tab ${viewMode === 'history' ? 'active' : ''}`}
              onClick={() => setViewMode('history')}
            >
              History
            </button>
          </div>
        </div>
        {viewMode === 'library' && (
          <button className="primary" onClick={() => setIsAdding(true)}>
            + Add Link
          </button>
        )}
      </header>

      {viewMode === 'library' && (
        <>
          <div className="card">
            <div className="settings-grid" style={{ gridTemplateColumns: '1fr auto', gap: 14 }}>
              <label>
                View
                <select value={filter} onChange={(e) => setFilter(e.target.value as any)} disabled={isSaving}>
                  <option value="replace">Replace</option>
                  <option value="productive">Productive</option>
                  <option value="allow">Allow</option>
                  <option value="temptation">Temptation</option>
                  <option value="all">All</option>
                </select>
              </label>
              <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 22 }}>
                <input type="checkbox" checked={pricedOnly} onChange={(e) => setPricedOnly(e.target.checked)} disabled={isSaving} />
                <span className="subtle">Priced only</span>
              </label>
            </div>
            <p className="subtle" style={{ marginTop: 8 }}>
              {filter === 'all' ? 'All library items.' : PURPOSES.find((p) => p.value === filter)?.hint}
            </p>
          </div>

          {isAdding && (
            <div className="card add-item-form">
              <h3>Add to Library</h3>
              <form onSubmit={handleAdd}>
                {error && <p className="error-text">{error}</p>}
                <div className="form-group">
                  <label>URL</label>
                  <input type="text" placeholder="https://…" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} disabled={isSaving} />
                </div>
                <div className="form-group">
                  <label>Purpose</label>
                  <select
                    value={newPurpose}
                    onChange={(e) => {
                      const purpose = e.target.value as LibraryPurpose;
                      setNewPurpose(purpose);
                      if (purpose !== 'allow') setNewPriceEnabled(false);
                    }}
                    disabled={isSaving}
                  >
                    {PURPOSES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <p className="subtle" style={{ marginTop: 8 }}>{PURPOSES.find((p) => p.value === newPurpose)?.hint}</p>
                </div>
                <div className="form-group">
                  <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={newPriceEnabled}
                      disabled={isSaving || newPurpose !== 'allow'}
                      onChange={(e) => setNewPriceEnabled(e.target.checked)}
                    />
                    One-time unlock price (optional)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    step={1}
                    value={newPrice}
                    disabled={isSaving || newPurpose !== 'allow' || !newPriceEnabled}
                    onChange={(e) => {
                      const next = Number.parseInt(e.target.value, 10);
                      setNewPrice(Number.isNaN(next) ? 1 : next);
                    }}
                  />
                  <p className="subtle" style={{ marginTop: 8 }}>
                    Pricing only applies to <strong>Allow</strong> items. It appears under “Proceed anyway” when you land on that exact URL.
                  </p>
                </div>
                <div className="form-group">
                  <label>Title (optional)</label>
                  <input type="text" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} disabled={isSaving} />
                </div>
                <div className="form-group">
                  <label>Note (optional)</label>
                  <textarea value={newNote} onChange={(e) => setNewNote(e.target.value)} disabled={isSaving} />
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setIsAdding(false);
                      resetAddForm();
                    }}
                    disabled={isSaving}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="primary" disabled={isSaving}>
                    Add
                  </button>
                </div>
              </form>
            </div>
          )}

          {visible.length === 0 ? (
            <div className="empty-state">
              <p>No items here yet.</p>
              <p className="subtle">Tip: right-click a page or link and “Save to TimeWellSpent”.</p>
            </div>
          ) : (
            <div className="library-grid">
              {visible.map((item) => {
                const title = item.title || item.domain || item.app || 'Saved item';
                const subtitle = item.note || (item.url ? shortenUrl(item.url) : item.app || item.domain || '');
                const urlLabel = item.url ? shortenUrl(item.url) : '';
                const icon = item.url ? faviconUrl(item.url) : null;
                const cover = item.url ? thumbUrl(item.url) : null;
                const coverSeed = item.domain ?? item.app ?? title;
                const coverHue = hashString(coverSeed) % 360;
                const coverStyle = { '--cover-hue': `${coverHue}` } as React.CSSProperties;
                const coverInitial = title.trim().charAt(0).toUpperCase() || 'T';
                const isEditing = editingId === item.id;
                const doneLabel = item.consumedAt ? 'Unmark done' : 'Mark done';

                return (
                  <article key={item.id} className={`card library-card ${item.consumedAt ? 'is-done' : ''}`}>
                    <div className={`library-thumb ${item.kind === 'app' ? 'app' : ''}`} style={coverStyle}>
                      {cover && item.kind === 'url' && (
                        <img
                          src={cover}
                          alt=""
                          loading="lazy"
                          onError={(event) => {
                            event.currentTarget.style.display = 'none';
                          }}
                        />
                      )}
                      <div className="library-thumb-fallback">
                        <span>{coverInitial}</span>
                        {item.kind === 'app' && <small>App</small>}
                      </div>
                      {icon ? (
                        <img className="library-favicon" src={icon} alt="" loading="lazy" />
                      ) : (
                        <div className="library-favicon library-favicon-placeholder" aria-hidden="true" />
                      )}
                      {item.consumedAt && (
                        <div className="library-done-badge" title="Completed">
                          ✓
                        </div>
                      )}
                    </div>

                    <div className="library-body">
                      <div className="library-title-row">
                        <div>
                          <h3>{title}</h3>
                          <p className="subtle">{subtitle}</p>
                        </div>
                        <span className={`pill ${purposeTone(item.purpose)}`}>{purposeLabel(item.purpose)}</span>
                      </div>

                      <div className="library-meta">
                        <span>{urlLabel || item.app || 'Saved item'}</span>
                        {typeof item.price === 'number' && <span>{item.price} f-coins unlock</span>}
                        {item.kind === 'app' && <span>Desktop app</span>}
                      </div>

                      <div className="library-dates">
                        <span>Added {formatDate(item.createdAt)}</span>
                        {item.consumedAt
                          ? <span>Done {formatDate(item.consumedAt)}</span>
                          : item.lastUsedAt
                            ? <span>Last used {formatDate(item.lastUsedAt)}</span>
                            : <span>Not used yet</span>}
                      </div>

                      <div className="library-actions">
                        {item.url ? (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="icon-button"
                            title="Open link"
                            aria-label="Open link"
                          >
                            <IconOpen />
                          </a>
                        ) : (
                          <button className="icon-button" type="button" disabled title="Open link" aria-label="Open link">
                            <IconOpen />
                          </button>
                        )}
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => handleToggleConsumed(item)}
                          disabled={isSaving}
                          title={doneLabel}
                          aria-label={doneLabel}
                        >
                          <IconCheck />
                        </button>
                        {isEditing ? (
                          <button className="icon-button" onClick={cancelEdit} disabled={isSaving} title="Cancel edit" aria-label="Cancel edit">
                            X
                          </button>
                        ) : (
                          <button className="icon-button" onClick={() => startEdit(item)} disabled={isSaving} title="Edit" aria-label="Edit">
                            <IconEdit />
                          </button>
                        )}
                        <button
                          className="icon-button danger"
                          onClick={() => handleRemove(item.id)}
                          disabled={isSaving}
                          title="Remove"
                          aria-label="Remove"
                        >
                          <IconTrash />
                        </button>
                      </div>

                      {isEditing && (
                        <form className="library-edit" onSubmit={handleUpdate}>
                          {editError && <p className="error-text">{editError}</p>}
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label>Purpose</label>
                            <select
                              value={editPurpose}
                              onChange={(e) => {
                                const purpose = e.target.value as LibraryPurpose;
                                setEditPurpose(purpose);
                                if (purpose !== 'allow') setEditPriceEnabled(false);
                              }}
                              disabled={isSaving}
                            >
                              {PURPOSES.map((p) => (
                                <option key={p.value} value={p.value}>
                                  {p.label}
                                </option>
                              ))}
                            </select>
                            <p className="subtle" style={{ margin: 0 }}>{PURPOSES.find((p) => p.value === editPurpose)?.hint}</p>
                          </div>

                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                              <input
                                type="checkbox"
                                checked={editPriceEnabled}
                                disabled={isSaving || editPurpose !== 'allow'}
                                onChange={(e) => setEditPriceEnabled(e.target.checked)}
                              />
                              One-time unlock price (optional)
                            </label>
                            <input
                              type="number"
                              min={1}
                              max={500}
                              step={1}
                              value={editPrice}
                              disabled={isSaving || editPurpose !== 'allow' || !editPriceEnabled}
                              onChange={(e) => {
                                const next = Number.parseInt(e.target.value, 10);
                                setEditPrice(Number.isNaN(next) ? 1 : next);
                              }}
                            />
                          </div>

                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label>Title</label>
                            <input type="text" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} disabled={isSaving} />
                          </div>

                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label>Note</label>
                            <textarea value={editNote} onChange={(e) => setEditNote(e.target.value)} disabled={isSaving} />
                          </div>

                          <div className="form-actions" style={{ justifyContent: 'flex-end' }}>
                            <button type="submit" className="primary" disabled={isSaving}>
                              Save
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}

      {viewMode === 'history' && (
        <div className="card history-card">
          <div className="history-header">
            <div>
              <h2>Consumption log</h2>
              <p className="subtle">Productive items and frivolous sessions you opened each day.</p>
            </div>
            <label className="history-picker">
              Day
              <input
                type="date"
                value={historyDay}
                onChange={(event) => setHistoryDay(event.target.value)}
              />
            </label>
          </div>

          {historyDays.length > 0 && (
            <div className="history-days">
              {historyDays.map((day) => (
                <button
                  key={day.day}
                  type="button"
                  className={`history-day ${day.day === historyDay ? 'active' : ''}`}
                  onClick={() => setHistoryDay(day.day)}
                >
                  <span>{formatDayLabel(day.day)}</span>
                  <span className="history-day-count">{day.count}</span>
                </button>
              ))}
            </div>
          )}

          {historyLoading ? (
            <div className="subtle">Loading history…</div>
          ) : historyError ? (
            <div className="error-text">{historyError}</div>
          ) : historyEntries.length === 0 ? (
            <div className="empty-state">
              <p>No entries for this day yet.</p>
              <p className="subtle">Mark items as consumed or open a session to see them here.</p>
            </div>
          ) : (
            <ul className="history-list">
              {historyEntries.map((entry) => {
                const isSession = entry.kind === 'frivolous-session';
                const purpose = typeof entry.meta?.purpose === 'string' ? entry.meta.purpose : null;
                const tone = purpose === 'temptation' ? 'frivolity' : purpose === 'productive' || purpose === 'replace' ? 'productive' : 'neutral';
                const pillClass = isSession ? 'pill frivolity' : `pill ${tone}`;
                const title = entry.title ?? entry.domain ?? 'Untitled';
                const subtitle = isSession
                  ? `Mode ${entry.meta?.mode ?? 'session'}`
                  : entry.url ?? entry.domain ?? 'Library item';
                const sessionMode = typeof entry.meta?.mode === 'string' ? entry.meta.mode : null;
                const label = isSession
                  ? sessionMode === 'store'
                    ? 'Store unlock'
                    : 'Frivolous session'
                  : purpose
                    ? `${capitalize(purpose)} item`
                    : 'Library item';
                return (
                  <li key={entry.id} className="history-item">
                    <div className="history-time">{formatTime(entry.occurredAt)}</div>
                    <div className="history-main">
                      <strong>{title}</strong>
                      <span className="subtle">{subtitle}</span>
                    </div>
                    <div className="history-actions">
                      <span className={pillClass}>{label}</span>
                      {entry.url && (
                        <a className="ghost" href={entry.url} target="_blank" rel="noopener noreferrer">
                          Open
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function IconOpen() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 4h6v6M10 14l10-10M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4l10-10-4-4L4 16v4zM14 6l4 4" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 7h12M9 7V5h6v2M8 7l1 12h6l1-12" />
    </svg>
  );
}
