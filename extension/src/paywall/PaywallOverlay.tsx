import { useEffect, useMemo, useState } from 'react';

type LinkPreview = {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  iconUrl?: string;
  updatedAt: number;
};

type ReadingItem = {
  id: string;
  source: 'zotero' | 'books';
  title: string;
  subtitle?: string;
  updatedAt: number;
  progress?: number;
  action: { kind: 'deeplink' | 'file'; url?: string; path?: string; app?: string };
  thumbDataUrl?: string;
  iconDataUrl?: string;
};

type LibraryItem = {
  id: number;
  kind: 'url' | 'app';
  url?: string;
  app?: string;
  domain: string;
  title?: string;
  note?: string;
  purpose: 'replace' | 'allow' | 'temptation';
  price?: number;
};

type StatusResponse = {
  balance: number;
  rate: {
    domain: string;
    ratePerMin: number;
    packs: Array<{ minutes: number; price: number }>;
  } | null;
  session: {
    domain: string;
    mode: 'metered' | 'pack' | 'emergency' | 'store';
    ratePerMin: number;
    remainingSeconds: number;
    paused?: boolean;
    allowedUrl?: string;
  } | null;
  matchedPricedItem?: LibraryItem | null;
  journal?: { url: string | null; minutes: number };
  library?: {
    items: LibraryItem[];
    replaceItems: LibraryItem[];
    productiveDomains: string[];
    readingItems?: ReadingItem[];
  };
  lastSync: number | null;
  desktopConnected: boolean;
  emergencyPolicy?: 'off' | 'gentle' | 'balanced' | 'strict';
  emergency?: {
    lastEnded: { domain: string; justification?: string; endedAt: number } | null;
    reviewStats: { total: number; kept: number; notKept: number };
  };
};

type Props = {
  domain: string;
  status: StatusResponse;
  reason?: string;
  onClose(): void;
};

type EmergencyPolicyConfig = {
  id: 'off' | 'gentle' | 'balanced' | 'strict';
  label: string;
  minutes: number;
  tokensPerDay: number | null;
  cooldownMinutes: number;
  urlLocked: boolean;
  debtCoins: number;
};

type Suggestion =
  | { type: 'url'; id: string; title: string; subtitle?: string; url: string; libraryId?: number }
  | { type: 'app'; id: string; title: string; subtitle?: string; app: string; requiresDesktop: boolean }
  | { type: 'ritual'; id: string; ritual: 'meditation' | 'journal'; title: string; subtitle?: string; minutes: number; url?: string }
  | {
      type: 'desktop';
      id: string;
      source: ReadingItem['source'];
      readingId: string;
      title: string;
      subtitle?: string;
      action: ReadingItem['action'];
      thumbDataUrl?: string;
      iconDataUrl?: string;
      progress?: number;
      requiresDesktop: boolean;
    };

function formatCoins(value: number) {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2).replace(/\.?0+$/, '');
}

function pickRandom<T>(items: T[], count: number, seed: number) {
  if (!items.length || count <= 0) return [];
  const copy = items.slice();

  // Deterministic-ish shuffle based on seed (simple LCG) to keep React stable.
  let state = (seed + 1) * 1_103_515_245;
  const rand = () => {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    return state / 0xffff_ffff;
  };

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

function formatClock(seconds: number) {
  const clamped = Math.max(0, Math.floor(seconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function playSoftChime() {
  try {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) return;
    const ctx = new AudioContextCtor();
    const now = ctx.currentTime;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    gain.connect(ctx.destination);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(528, now);
    osc1.connect(gain);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(792, now);
    osc2.connect(gain);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 1.2);
    osc2.stop(now + 1.2);

    ctx.close().catch(() => { });
  } catch {
    // ignore
  }
}

export default function PaywallOverlay({ domain, status, reason, onClose }: Props) {
  const [selectedMinutes, setSelectedMinutes] = useState(15);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showEmergencyForm, setShowEmergencyForm] = useState(false);
  const [justification, setJustification] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [spinKey, setSpinKey] = useState(0);
  const [proceedOpen, setProceedOpen] = useState(reason === 'insufficient-funds');
  const [linkPreviews, setLinkPreviews] = useState<Record<string, LinkPreview | null>>({});
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Record<string, true>>({});
  const [ritual, setRitual] = useState<{ kind: 'meditation'; minutes: number } | null>(null);
  const [ritualRemaining, setRitualRemaining] = useState(0);
  const [ritualRunning, setRitualRunning] = useState(false);
  const [ritualDone, setRitualDone] = useState(false);

  const ratePerMin = status.rate?.ratePerMin ?? status.session?.ratePerMin ?? 1;
  const emergencyPolicy = status.emergencyPolicy ?? 'balanced';

  const emergencyPolicyConfig = useMemo<EmergencyPolicyConfig>(() => {
    switch (emergencyPolicy) {
      case 'off':
        return { id: 'off', label: 'Off', minutes: 0, tokensPerDay: 0, cooldownMinutes: 0, urlLocked: true, debtCoins: 0 };
      case 'gentle':
        return { id: 'gentle', label: 'Gentle', minutes: 5, tokensPerDay: null, cooldownMinutes: 0, urlLocked: true, debtCoins: 0 };
      case 'strict':
        return { id: 'strict', label: 'Strict', minutes: 2, tokensPerDay: 1, cooldownMinutes: 60, urlLocked: true, debtCoins: 15 };
      case 'balanced':
      default:
        return { id: 'balanced', label: 'Balanced', minutes: 3, tokensPerDay: 2, cooldownMinutes: 30, urlLocked: true, debtCoins: 8 };
    }
  }, [emergencyPolicy]);

  const faviconUrl = (url: string) => `chrome://favicon2/?size=64&url=${encodeURIComponent(url)}`;

  const previewFor = (url: string) => {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return linkPreviews[parsed.toString()] ?? null;
    } catch {
      return null;
    }
  };

  const suggestionCandidates = useMemo<Suggestion[]>(() => {
    const candidates: Suggestion[] = [];

    const replaceItems = status.library?.replaceItems ?? [];
    for (const item of replaceItems) {
      if (!item) continue;
      if (item.kind === 'url') {
        if (!item.url || item.domain === domain) continue;
        candidates.push({
          type: 'url',
          id: `lib:${item.id}`,
          libraryId: item.id,
          title: item.title ?? item.domain,
          subtitle: item.note ? item.note : 'your replace pool',
          url: item.url
        });
      } else {
        candidates.push({
          type: 'app',
          id: `lib:${item.id}`,
          title: item.title ?? item.app ?? 'Open app',
          subtitle: item.note ? item.note : 'your replace pool',
          app: item.app ?? '',
          requiresDesktop: true
        });
      }
    }

    const readingItems = status.library?.readingItems ?? [];
    for (const item of readingItems) {
      if (!item || !item.id || !item.action) continue;
      candidates.push({
        type: 'desktop',
        id: `reading:${item.id}`,
        source: item.source,
        readingId: item.id,
        title: item.title ?? (item.source === 'zotero' ? 'Zotero' : 'Books'),
        subtitle: item.subtitle ? item.subtitle : item.source === 'zotero' ? 'Zotero • curated reading' : 'Books • recent',
        action: item.action,
        thumbDataUrl: item.thumbDataUrl,
        iconDataUrl: item.iconDataUrl,
        progress: item.progress,
        requiresDesktop: true
      });
    }

    const productive = status.library?.productiveDomains ?? [];
    for (const entry of productive) {
      const trimmed = (entry ?? '').trim();
      if (!trimmed || !trimmed.includes('.') || trimmed === domain) continue;
      candidates.push({
        type: 'url',
        id: `prod:${trimmed}`,
        title: trimmed,
        subtitle: 'productive',
        url: `https://${trimmed}`
      });
    }

    candidates.push({
      type: 'app',
      id: 'app:Books',
      title: 'Open Books',
      subtitle: 'read something long-form',
      app: 'Books',
      requiresDesktop: true
    });
    candidates.push({
      type: 'app',
      id: 'app:Zotero',
      title: 'Open Zotero',
      subtitle: 'pick a paper instead',
      app: 'Zotero',
      requiresDesktop: true
    });

    candidates.push({
      type: 'ritual',
      id: 'ritual:meditation',
      ritual: 'meditation',
      title: 'Meditation',
      subtitle: '3-minute reset',
      minutes: 3
    });
    const journalUrl = status.journal?.url ?? null;
    const journalMinutes = status.journal?.minutes ?? 10;
    if (journalUrl) {
      candidates.push({
        type: 'ritual',
        id: 'ritual:journal',
        ritual: 'journal',
        title: `${journalMinutes}m journal`,
        subtitle: 'write a few lines instead',
        minutes: journalMinutes,
        url: journalUrl
      });
    }

    const seen = new Set<string>();
    return candidates.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      if (dismissedIds[c.id]) return false;
      return true;
    });
  }, [dismissedIds, domain, status.library?.productiveDomains, status.library?.replaceItems, status.library?.readingItems]);

  const picks = useMemo(() => pickRandom(suggestionCandidates, 3, spinKey), [suggestionCandidates, spinKey]);

  useEffect(() => {
    const urls = picks
      .filter((p): p is Extract<Suggestion, { type: 'url' }> => p.type === 'url')
      .map((p) => p.url);
    const unlockUrl = status.matchedPricedItem?.kind === 'url' ? status.matchedPricedItem.url : undefined;
    if (unlockUrl) urls.push(unlockUrl);

    const deduped = [...new Set(urls)];
    if (!deduped.length) return;

    chrome.runtime
      .sendMessage({ type: 'GET_LINK_PREVIEWS', payload: { urls: deduped } })
      .then((result) => {
        if (!result?.success || !result.previews) return;
        setLinkPreviews((cur) => ({ ...cur, ...(result.previews as Record<string, LinkPreview | null>) }));
      })
      .catch(() => {});
  }, [picks, status.matchedPricedItem?.url]);

  const handleOpenSuggestion = async (item: Suggestion) => {
    if (!item || isProcessing) return;
    setMenuOpenId(null);
    setIsProcessing(true);
    setError(null);
    try {
      if (item.type === 'ritual') {
        if (item.ritual === 'meditation') {
          setRitual({ kind: 'meditation', minutes: item.minutes });
          setRitualRemaining(item.minutes * 60);
          setRitualRunning(false);
          setRitualDone(false);
          return;
        }
        if (item.ritual === 'journal' && item.url) {
          const result = await chrome.runtime.sendMessage({
            type: 'OPEN_URL',
            payload: { url: item.url, roulette: { title: item.title } }
          });
          if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to open journal');
          onClose();
          return;
        }
        return;
      }

      if (item.type === 'url') {
        const preview = previewFor(item.url);
        const rouletteTitle = preview?.title ?? item.title;
        const result = await chrome.runtime.sendMessage({
          type: 'OPEN_URL',
          payload: { url: item.url, roulette: { title: rouletteTitle, libraryId: item.libraryId } }
        });
        if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to open URL');
        onClose();
        return;
      }

      if (item.type === 'desktop') {
        if (item.requiresDesktop && !status.desktopConnected) {
          throw new Error('Desktop app required for this action');
        }
        const result = await chrome.runtime.sendMessage({ type: 'OPEN_DESKTOP_ACTION', payload: item.action });
        if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to open in desktop app');
        onClose();
        return;
      }

      if (item.requiresDesktop && !status.desktopConnected) {
        throw new Error('Desktop app required for this action');
      }
      const result = await chrome.runtime.sendMessage({ type: 'OPEN_APP', payload: { app: item.app } });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to open app');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleMarkConsumed = async (item: Suggestion) => {
    if (isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      if (item.type === 'url' && typeof item.libraryId === 'number') {
        const result = await chrome.runtime.sendMessage({
          type: 'MARK_LIBRARY_CONSUMED',
          payload: { id: item.libraryId, consumed: true }
        });
        if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to mark consumed');
      } else if (item.type === 'desktop' && item.readingId) {
        const result = await chrome.runtime.sendMessage({
          type: 'MARK_READING_CONSUMED',
          payload: { id: item.readingId, consumed: true }
        });
        if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to mark consumed');
      } else {
        return;
      }

      setDismissedIds((cur) => ({ ...cur, [item.id]: true }));
      setMenuOpenId(null);
      setSpinKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const sortedPacks = useMemo(() => {
    return [...(status.rate?.packs ?? [])].sort((a, b) => a.minutes - b.minutes);
  }, [status.rate?.packs]);

  const sliderBounds = useMemo(() => {
    if (sortedPacks.length) {
      return {
        min: sortedPacks[0].minutes,
        max: sortedPacks[sortedPacks.length - 1].minutes,
        step: 1
      };
    }
    return { min: 5, max: 120, step: 5 };
  }, [sortedPacks]);

  useEffect(() => {
    if (sortedPacks.length) setSelectedMinutes(sortedPacks[0].minutes);
    else setSelectedMinutes(15);
  }, [domain, sortedPacks]);

  const snapMinutes = (value: number) => {
    if (!sortedPacks.length) return value;
    return sortedPacks.reduce((closest, pack) => {
      const distance = Math.abs(pack.minutes - value);
      const closestDistance = Math.abs(closest - value);
      return distance < closestDistance ? pack.minutes : closest;
    }, sortedPacks[0].minutes);
  };

  const matchedPack = sortedPacks.find((pack) => pack.minutes === selectedMinutes);
  const sliderPrice = matchedPack ? matchedPack.price : Math.max(1, Math.round(selectedMinutes * ratePerMin));
  const sliderAffordable = status.balance >= sliderPrice;

  const handleBuyPack = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'BUY_PACK',
        payload: { domain, minutes: selectedMinutes }
      });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to start session');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStartMetered = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'START_METERED', payload: { domain } });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to start metered');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUnlockSavedItem = async () => {
    const item = status.matchedPricedItem;
    if (isProcessing || !item || typeof item.price !== 'number') return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'START_STORE_SESSION',
        payload: { domain, price: item.price, url: window.location.href }
      });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to unlock');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStartEmergency = async () => {
    if (isProcessing || !justification.trim()) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'START_EMERGENCY',
        payload: { domain, justification, url: window.location.href }
      });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to start emergency');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleEmergencyReview = async (outcome: 'kept' | 'not-kept') => {
    if (isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'EMERGENCY_REVIEW',
        payload: { outcome, domain }
      });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to record review');
      setReviewed(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const heading =
    reason === 'url-locked'
      ? 'This pass is locked to a specific page'
      : reason === 'insufficient-funds'
        ? 'Insufficient f-coins'
        : status.session?.paused
          ? 'Session paused'
          : 'Choose what this tab becomes';

  useEffect(() => {
    if (!ritual || !ritualRunning) return;
    const timer = window.setInterval(() => {
      setRitualRemaining((cur) => {
        if (cur <= 1) {
          window.clearInterval(timer);
          setRitualRunning(false);
          setRitualDone(true);
          playSoftChime();
          return 0;
        }
        return cur - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ritual, ritualRunning]);

  if (ritual) {
    return (
      <div className="tws-paywall-overlay">
        <div className="tws-paywall-modal">
          <header className="tws-paywall-header">
            <div>
              <p className="tws-eyebrow">TimeWellSpent</p>
              <h2>{ritual.kind === 'meditation' ? 'Meditation' : 'Ritual'}</h2>
              <p className="tws-subtle">
                A small reset helps you exit the attractor. Keep it simple: breathe, notice, return.
              </p>
            </div>
            <div className="tws-wallet-badge">
              <span>Balance</span>
              <strong>{status.balance} f-coins</strong>
            </div>
          </header>

          <div className="tws-paywall-body">
            {error && <p className="tws-error-text">{error}</p>}
            <section className="tws-paywall-option">
              <div className="tws-option-header">
                <h3>{ritual.kind === 'meditation' ? `${ritual.minutes} minute timer` : 'Timer'}</h3>
                <p className="tws-subtle" style={{ margin: 0 }}>
                  {ritualDone ? 'Complete.' : ritualRunning ? 'In progress.' : 'Ready when you are.'}
                </p>
              </div>

              <div style={{ display: 'grid', gap: 12 }}>
                <div className="tws-ritual-timer">{formatClock(ritualRemaining)}</div>
                <div className="tws-emergency-actions">
                  <button
                    className="tws-secondary"
                    onClick={() => {
                      setRitual(null);
                      setRitualRunning(false);
                      setRitualDone(false);
                      setSpinKey((k) => k + 1);
                    }}
                    disabled={isProcessing}
                  >
                    Back
                  </button>
                  {!ritualDone ? (
                    <button
                      className="tws-primary"
                      onClick={() => setRitualRunning((v) => !v)}
                      disabled={isProcessing}
                    >
                      {ritualRunning ? 'Pause' : 'Start'}
                    </button>
                  ) : (
                    <button
                      className="tws-primary"
                      onClick={() => {
                        setRitual(null);
                        setSpinKey((k) => k + 1);
                      }}
                      disabled={isProcessing}
                    >
                      Pick next
                    </button>
                  )}
                  {!ritualDone && (
                    <button
                      className="tws-secondary"
                      onClick={() => {
                        setRitualRunning(false);
                        setRitualRemaining(ritual.minutes * 60);
                        setRitualDone(false);
                      }}
                      disabled={isProcessing}
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  }

  if (showEmergencyForm) {
    return (
      <div className="tws-paywall-overlay">
        <div className="tws-paywall-modal">
          <header className="tws-paywall-header">
            <div>
              <p className="tws-eyebrow">TimeWellSpent</p>
              <h2>I need it</h2>
              <p className="tws-subtle">
                Emergency access is a safety hatch. Use it when you have a real purpose — not when you want a dopamine hit.
              </p>
            </div>
            <div className="tws-wallet-badge">
              <span>Balance</span>
              <strong>{status.balance} f-coins</strong>
            </div>
          </header>

          <div className="tws-paywall-body">
            {error && <p className="tws-error-text">{error}</p>}
            <div className="tws-emergency-form">
              <p className="tws-subtle" style={{ marginTop: 0 }}>
                Policy: <strong>{emergencyPolicyConfig.label}</strong>
                {emergencyPolicyConfig.id !== 'off' && (
                  <>
                    {' '}
                    • {emergencyPolicyConfig.minutes}m window
                    {typeof emergencyPolicyConfig.tokensPerDay === 'number' ? ` • ${emergencyPolicyConfig.tokensPerDay}/day` : ' • unlimited/day'}
                    {emergencyPolicyConfig.cooldownMinutes > 0 ? ` • ${emergencyPolicyConfig.cooldownMinutes}m cooldown` : ''}
                    {emergencyPolicyConfig.debtCoins > 0 ? ` • ${emergencyPolicyConfig.debtCoins} coin debt` : ''}
                  </>
                )}
              </p>
              <textarea
                placeholder="I need to…"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                autoFocus
              />
              <div className="tws-emergency-actions">
                <button className="tws-secondary" onClick={() => setShowEmergencyForm(false)} disabled={isProcessing}>
                  Back
                </button>
                <button className="tws-primary" onClick={handleStartEmergency} disabled={!justification.trim() || isProcessing}>
                  Start emergency ({emergencyPolicyConfig.minutes}m)
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const unlock: (LibraryItem & { price: number }) | null =
    status.matchedPricedItem && typeof status.matchedPricedItem.price === 'number'
      ? (status.matchedPricedItem as LibraryItem & { price: number })
      : null;
  const unlockPreview = unlock?.kind === 'url' && unlock.url ? previewFor(unlock.url) : null;
  const unlockThumb = unlockPreview?.imageUrl ?? null;
  const unlockIcon = unlock?.kind === 'url' && unlock.url ? unlockPreview?.iconUrl ?? faviconUrl(unlock.url) : null;

  return (
    <div className="tws-paywall-overlay">
      <div className="tws-paywall-modal">
        <header className="tws-paywall-header">
          <div>
            <p className="tws-eyebrow">TimeWellSpent</p>
            <h2>{domain}</h2>
            <p className="tws-subtle">{heading}</p>
          </div>
          <div className="tws-wallet-badge">
            <span>Balance</span>
            <strong>{status.balance} f-coins</strong>
          </div>
        </header>

        <div className="tws-paywall-body">
          {error && <p className="tws-error-text" style={{ marginBottom: 0 }}>{error}</p>}

          {reason === 'emergency-expired' && !reviewed && (
            <section className="tws-paywall-option" style={{ borderColor: '#d07f00' }}>
              <div className="tws-option-header">
                <h3>Emergency ended</h3>
                <p className="tws-subtle">
                  Quick check-in: did you do the thing you came for?
                  {status.emergency?.lastEnded?.domain === domain && status.emergency.lastEnded.justification
                    ? ` (“${status.emergency.lastEnded.justification}”)`
                    : ''}
                </p>
              </div>
              <div className="tws-option-action">
                <button className="tws-secondary" disabled={isProcessing} onClick={() => handleEmergencyReview('not-kept')}>
                  Not really
                </button>
                <button className="tws-primary" disabled={isProcessing} onClick={() => handleEmergencyReview('kept')}>
                  Yes
                </button>
              </div>
            </section>
          )}

          <section className="tws-paywall-option tws-attractors">
            <div className="tws-option-header tws-attractors-header">
              <div>
                <h3>Try this instead</h3>
                <p className="tws-subtle">
                  You’re not here because this site is irresistible. You’re here because something else mattered — pick it.
                </p>
              </div>
              <button className="tws-link" type="button" disabled={isProcessing} onClick={() => setSpinKey((k) => k + 1)}>
                Spin
              </button>
            </div>

            {picks.length === 0 ? (
              <p className="tws-subtle" style={{ margin: 0 }}>
                Your Replace pool is empty. Save a few links with right-click → “Save to TimeWellSpent” → “Replace”.
              </p>
            ) : (
              <div className="tws-attractors-grid">
                {picks.map((item) => {
                  const cardDisabled =
                    isProcessing ||
                    (item.type === 'desktop' && item.requiresDesktop && !status.desktopConnected) ||
                    (item.type === 'app' && item.requiresDesktop && !status.desktopConnected);

                  if (item.type === 'url') {
                    const preview = previewFor(item.url);
                    const thumb = preview?.imageUrl ?? null;
                    const icon = preview?.iconUrl ?? faviconUrl(item.url);
                    return (
                      <div
                        key={item.id}
                        className="tws-attractor-card"
                        onClick={() => {
                          if (cardDisabled) return;
                          handleOpenSuggestion(item);
                        }}
                        role="button"
                        tabIndex={cardDisabled ? -1 : 0}
                        aria-disabled={cardDisabled}
                        onKeyDown={(e) => {
                          if (cardDisabled) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleOpenSuggestion(item);
                          }
                        }}
                      >
                        <div className="tws-attractor-thumb">
                          {thumb ? (
                            <img className="tws-attractor-thumb-img" src={thumb} alt="" loading="lazy" />
                          ) : (
                            <div className="tws-attractor-thumb-placeholder" aria-hidden="true" />
                          )}
                          {typeof item.libraryId === 'number' && (
                            <button
                              type="button"
                              className="tws-card-menu-trigger"
                              aria-label="More"
                              disabled={isProcessing}
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuOpenId((cur) => (cur === item.id ? null : item.id));
                              }}
                            >
                              ⋯
                            </button>
                          )}
                          {menuOpenId === item.id && typeof item.libraryId === 'number' && (
                            <div className="tws-card-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                className="tws-card-menu-item"
                                disabled={isProcessing}
                                onClick={() => handleMarkConsumed(item)}
                              >
                                Already consumed
                              </button>
                            </div>
                          )}
                          <img className="tws-attractor-favicon" src={icon} alt="" loading="lazy" />
                        </div>
                        <div className="tws-attractor-meta">
                          <strong>{preview?.title ?? item.title}</strong>
                          <span>{preview?.description ?? item.subtitle ?? 'saved in your replace pool'}</span>
                          <small>{new URL(item.url).hostname.replace(/^www\\./, '')}</small>
                        </div>
                      </div>
                    );
                  }

                  if (item.type === 'desktop') {
                    const progressPct =
                      item.source === 'zotero' && typeof item.progress === 'number'
                        ? Math.round(Math.max(0, Math.min(1, item.progress)) * 100)
                        : null;
                    return (
                      <div
                        key={item.id}
                        className="tws-attractor-card"
                        onClick={() => {
                          if (cardDisabled) return;
                          handleOpenSuggestion(item);
                        }}
                        title={item.requiresDesktop && !status.desktopConnected ? 'Requires desktop app' : undefined}
                        role="button"
                        tabIndex={cardDisabled ? -1 : 0}
                        aria-disabled={cardDisabled}
                        onKeyDown={(e) => {
                          if (cardDisabled) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleOpenSuggestion(item);
                          }
                        }}
                      >
                        <div className="tws-attractor-thumb">
                          {item.thumbDataUrl ? (
                            <img className="tws-attractor-thumb-img" src={item.thumbDataUrl} alt="" loading="lazy" />
                          ) : (
                            <div className="tws-attractor-thumb-placeholder" aria-hidden="true" />
                          )}
                          {progressPct !== null && (
                            <div className="tws-progress-bar" aria-hidden="true">
                              <div className="tws-progress-fill" style={{ width: `${progressPct}%` }} />
                            </div>
                          )}
                          <button
                            type="button"
                            className="tws-card-menu-trigger"
                            aria-label="More"
                            disabled={isProcessing}
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpenId((cur) => (cur === item.id ? null : item.id));
                            }}
                          >
                            ⋯
                          </button>
                          {menuOpenId === item.id && (
                            <div className="tws-card-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                className="tws-card-menu-item"
                                disabled={isProcessing}
                                onClick={() => handleMarkConsumed(item)}
                              >
                                Already consumed
                              </button>
                            </div>
                          )}
                          {item.iconDataUrl ? (
                            <img className="tws-attractor-favicon" src={item.iconDataUrl} alt="" loading="lazy" />
                          ) : (
                            <div className="tws-attractor-favicon" aria-hidden="true" />
                          )}
                        </div>
                        <div className="tws-attractor-meta">
                          <strong>{item.title}</strong>
                          <span>{item.subtitle ?? 'reading suggestion'}</span>
                          <small>desktop</small>
                        </div>
                      </div>
                    );
                  }

                  if (item.type === 'ritual') {
                    return (
                      <div
                        key={item.id}
                        className="tws-attractor-card"
                        onClick={() => {
                          if (cardDisabled) return;
                          handleOpenSuggestion(item);
                        }}
                        role="button"
                        tabIndex={cardDisabled ? -1 : 0}
                        aria-disabled={cardDisabled}
                        onKeyDown={(e) => {
                          if (cardDisabled) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleOpenSuggestion(item);
                          }
                        }}
                      >
                        <div className="tws-attractor-thumb tws-attractor-thumb-ritual">
                          <div className="tws-attractor-thumb-placeholder" aria-hidden="true" />
                          <div className="tws-attractor-app-badge">Ritual</div>
                        </div>
                        <div className="tws-attractor-meta">
                          <strong>{item.title}</strong>
                          <span>{item.subtitle ?? 'a small reset'}</span>
                          <small>{item.ritual === 'meditation' ? `${item.minutes}m` : 'journal'}</small>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={item.id}
                      className="tws-attractor-card"
                      onClick={() => {
                        if (cardDisabled) return;
                        handleOpenSuggestion(item);
                      }}
                      title={item.requiresDesktop && !status.desktopConnected ? 'Requires desktop app' : undefined}
                      role="button"
                      tabIndex={cardDisabled ? -1 : 0}
                      aria-disabled={cardDisabled}
                      onKeyDown={(e) => {
                        if (cardDisabled) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleOpenSuggestion(item);
                        }
                      }}
                    >
                      <div className="tws-attractor-thumb tws-attractor-thumb-app">
                        <div className="tws-attractor-thumb-placeholder" aria-hidden="true" />
                        <div className="tws-attractor-app-badge">App</div>
                      </div>
                      <div className="tws-attractor-meta">
                        <strong>{item.title}</strong>
                        <span>{item.subtitle ?? 'open an app'}</span>
                        <small>desktop</small>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <details className="tws-details" open={proceedOpen} onToggle={(e) => setProceedOpen((e.target as HTMLDetailsElement).open)}>
            <summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <strong>Proceed anyway</strong>
                <span>Timebox recommended • metered and emergency are intentionally harder.</span>
              </div>
              <span>{proceedOpen ? '−' : '+'}</span>
            </summary>
            <div className="tws-details-body">
              {unlock && (
                <section className="tws-paywall-option" style={{ margin: 0 }}>
                  <div className="tws-option-header">
                    <h3>Unlock your saved item</h3>
                    <p className="tws-subtle">Pay once for this exact page, then leave when you’re done.</p>
                  </div>

                  {unlock.url && (
                    <div className="tws-attractors-grid" style={{ gridTemplateColumns: '1fr', marginBottom: 12 }}>
                      <button type="button" className="tws-attractor-card" disabled style={{ cursor: 'default' }}>
                        <div className="tws-attractor-thumb">
                          {unlockThumb ? (
                            <img className="tws-attractor-thumb-img" src={unlockThumb} alt="" loading="lazy" />
                          ) : (
                            <div className="tws-attractor-thumb-placeholder" aria-hidden="true" />
                          )}
                          {unlockIcon && <img className="tws-attractor-favicon" src={unlockIcon} alt="" loading="lazy" />}
                          <div className="tws-price-pill">
                            {unlock.price}
                            <span>f-coins</span>
                          </div>
                        </div>
                        <div className="tws-attractor-meta">
                          <strong>{unlockPreview?.title ?? unlock.title ?? unlock.domain}</strong>
                          <span>{unlockPreview?.description ?? 'Saved one-time unlock'}</span>
                          <small>{unlock.domain}</small>
                        </div>
                      </button>
                    </div>
                  )}

                  <div className="tws-option-action">
                    <div className="tws-price-tag">
                      <strong>{unlock.price}</strong>
                      <small>f-coins</small>
                    </div>
                    <button className="tws-primary" onClick={handleUnlockSavedItem} disabled={isProcessing || status.balance < unlock.price}>
                      Unlock now
                    </button>
                  </div>
                  {status.balance < unlock.price && (
                    <p className="tws-error-text" style={{ marginTop: 8 }}>
                      Need {unlock.price - status.balance} more f-coins
                    </p>
                  )}
                </section>
              )}

              <section className="tws-paywall-option" style={{ margin: 0 }}>
                <div className="tws-option-header">
                  <h3>Timeboxed session (recommended)</h3>
                  <p className="tws-subtle">Commit to a fixed time and leave when it ends.</p>
                </div>

                <div className="tws-slider-container">
                  <div className="tws-slider-labels">
                    <span>{selectedMinutes} minutes</span>
                    <span className="tws-subtle-info">timebox</span>
                    <strong>{sliderPrice} f-coins</strong>
                  </div>
                  <input
                    type="range"
                    min={sliderBounds.min}
                    max={sliderBounds.max}
                    step={sliderBounds.step}
                    value={selectedMinutes}
                    onChange={(e) => setSelectedMinutes(snapMinutes(Number(e.target.value)))}
                  />
                  <div className="tws-slider-scale">
                    <small>{sliderBounds.min}m</small>
                    <small>{sliderBounds.max}m</small>
                  </div>
                </div>

                <div className="tws-option-action">
                  <button className="tws-primary" onClick={handleBuyPack} disabled={!sliderAffordable || isProcessing}>
                    Proceed for {sliderPrice} f-coins
                  </button>
                  {!sliderAffordable && (
                    <p className="tws-error-text">Need {sliderPrice - status.balance} more f-coins</p>
                  )}
                </div>
              </section>

              <section className="tws-paywall-option" style={{ margin: 0 }}>
                <div className="tws-option-header">
                  <h3>Metered</h3>
                  <p className="tws-subtle">Charges continuously while you stay. Use only if you trust yourself.</p>
                </div>
                <div className="tws-option-action">
                  <div className="tws-price-tag">
                    <strong>{formatCoins(ratePerMin)}</strong>
                    <small>f-coins / min</small>
                  </div>
                  <button className="tws-secondary" onClick={handleStartMetered} disabled={status.balance < 1 || isProcessing}>
                    Proceed metered
                  </button>
                </div>
              </section>

              <div className="tws-emergency-link">
                {emergencyPolicy === 'off' ? (
                  <button disabled title="Emergency access is disabled in Settings.">
                    Emergency disabled
                  </button>
                ) : (
                  <button onClick={() => { setReviewed(false); setShowEmergencyForm(true); }}>
                    I need it (Emergency)
                  </button>
                )}
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
