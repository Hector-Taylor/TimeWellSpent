import { useEffect, useMemo, useState } from 'react';
import type { MarketRate, RendererApi, WalletSnapshot } from '@shared/types';

interface PaywallOverlayProps {
  open: boolean;
  state: {
    domain: string;
    mode: 'metered' | 'pack';
    ratePerMin?: number;
    remainingSeconds?: number;
    reason?: string;
  } | null;
  wallet: WalletSnapshot;
  api: RendererApi;
  marketRates: MarketRate[];
  onWallet(snapshot: WalletSnapshot): void;
  onClose(): void;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export default function PaywallOverlay({ open, state, wallet, api, marketRates, onWallet, onClose }: PaywallOverlayProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMinutes, setSelectedMinutes] = useState(15);
  const rate = useMemo(() => {
    if (!state) return undefined;
    return marketRates.find((item) => item.domain === state.domain);
  }, [marketRates, state?.domain]);

  const sliderBounds = useMemo(() => {
    const minutes = rate?.packs.map((pack) => pack.minutes) ?? [];
    const min = minutes.length ? Math.min(...minutes) : 10;
    const maxFromPacks = minutes.length ? Math.max(...minutes) : 30;
    const max = Math.max(maxFromPacks, min + 15, 45);
    return { min: Math.max(5, min), max, step: 5 };
  }, [rate]);

  useEffect(() => {
    if (!open || !state) return;
    const defaultMinutes = rate?.packs?.[0]?.minutes ?? sliderBounds.min;
    setSelectedMinutes(clamp(defaultMinutes, sliderBounds.min, sliderBounds.max));
  }, [open, rate, sliderBounds.max, sliderBounds.min, state?.domain]);

  useEffect(() => {
    if (!open) return;
    setError(null);
  }, [open, state?.domain]);

  if (!open || !state) {
    return null;
  }

  async function startMetered() {
    if (!state) return;
    setLoading(true);
    setError(null);
    try {
      await api.paywall.startMetered(state.domain);
      const snapshot = await api.wallet.get();
      onWallet(snapshot);
      onClose();
    } catch (error) {
      console.error(error);
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function buyPack(minutes: number) {
    if (!state) return;
    setLoading(true);
    setError(null);
    try {
      await api.paywall.buyPack(state.domain, minutes);
      const snapshot = await api.wallet.get();
      onWallet(snapshot);
      onClose();
    } catch (error) {
      console.error(error);
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const blocked = state.reason === 'blocked';
  const insufficient = state.reason === 'insufficient-funds';
  const baseRate = rate?.ratePerMin ?? state.ratePerMin ?? 0;
  const matchedPack = rate?.packs.find((pack) => pack.minutes === selectedMinutes);
  const sliderPrice = matchedPack ? matchedPack.price : Math.max(1, Math.round(selectedMinutes * baseRate));
  const walletPercent = wallet.balance > 0 ? Math.min(1, sliderPrice / wallet.balance) : 1;
  const coinsLeft = Math.max(0, wallet.balance - sliderPrice);
  const gaugeRadius = 72;
  const circumference = 2 * Math.PI * gaugeRadius;
  const dashOffset = circumference * (1 - walletPercent);
  const sliderAffordable = wallet.balance >= sliderPrice;
  const sliderMidLabel = Math.round((sliderBounds.min + sliderBounds.max) / 2);
  const meteredPreviewPercent = wallet.balance > 0 ? Math.min(1, (baseRate * 15) / wallet.balance) : 1;
  const dayShare = Math.min(1, selectedMinutes / (24 * 60));
  const walletSharePct = walletPercent * 100;
  const daySharePct = Math.round(dayShare * 100);
  const projections = [
    { label: 'Quick peek', minutes: Math.max(5, Math.round(selectedMinutes * 0.4)) },
    { label: 'This choice', minutes: selectedMinutes },
    { label: 'Deep dive', minutes: Math.min(120, Math.round(selectedMinutes * 1.6)) }
  ].map((p) => ({ ...p, cost: Math.max(1, Math.round(p.minutes * baseRate)) }));

  return (
    <div className="paywall-overlay">
      <div className="paywall-modal">
        <header className="paywall-modal-header">
          <div>
            <h2>{state.domain}</h2>
            <p className="subtle">
              {blocked
                ? 'TimeWellSpent closed this tab — unlock access by paying for screen time.'
                : 'Stay intentional: spend f-coins to access this site.'}
            </p>
          </div>
        </header>
        <div className="wallet-inline">
          <span>Balance</span>
          <strong>{wallet.balance} coins</strong>
        </div>
        {error && <p className="warning" style={{ color: 'var(--danger)' }}>{error}</p>}
        {blocked && !error && <p className="warning">Pay-as-you-go or grab a pack to re-open the site.</p>}
        {insufficient && !error && (
          <p className="warning">Session paused — add more coins or choose a smaller pack.</p>
        )}
        <section className="spend-lab">
          <div className="budget-visual">
            <div className="budget-circle" role="img" aria-label={`Spending ${sliderPrice} coins for ${selectedMinutes} minutes`}>
              <svg viewBox="0 0 200 200" width="200" height="200">
                <circle className="budget-track" cx="100" cy="100" r={gaugeRadius} strokeWidth="14" />
                <circle
                  className="budget-fill"
                  cx="100"
                  cy="100"
                  r={gaugeRadius}
                  strokeWidth="14"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                />
              </svg>
              <div className="budget-figures">
                <strong>{sliderPrice} coins</strong>
                <span>{selectedMinutes} minute unlock</span>
                <small className="subtle">{walletSharePct.toFixed(0)}% of spendable</small>
              </div>
            </div>
            <div className="impact-bars">
              <div>
                <div className="impact-label">Wallet impact</div>
                <div className="impact-meter">
                  <span style={{ width: `${walletSharePct}%` }} />
                </div>
                <small className="subtle">Leaves {coinsLeft} coins</small>
              </div>
              <div>
                <div className="impact-label">Day share</div>
                <div className="impact-meter day">
                  <span style={{ width: `${daySharePct}%` }} />
                </div>
                <small className="subtle">{daySharePct}% of your day if you stay that long</small>
              </div>
            </div>
          </div>
          <div className="budget-controls">
            <div className="eyebrow">Shape your session</div>
            <p className="subtle">Use the slider to choreograph how much time (and money) you want to burn on this domain.</p>
            <input
              id="focus-budget"
              type="range"
              min={sliderBounds.min}
              max={sliderBounds.max}
              step={sliderBounds.step}
              value={selectedMinutes}
              onChange={(event) => setSelectedMinutes(Number(event.target.value))}
            />
            <div className="budget-scale">
              <span>{sliderBounds.min} min</span>
              <span>{sliderMidLabel} min</span>
              <span>{sliderBounds.max}+ min</span>
            </div>
            <div className="projection-grid">
              {projections.map((proj) => (
                <div key={proj.label} className="projection-card">
                  <div className="projection-minutes">{proj.minutes}m</div>
                  <div className="projection-label">{proj.label}</div>
                  <div className="projection-cost">{proj.cost} coins</div>
                  <div className="projection-bar">
                    <span style={{ width: `${Math.min(100, (proj.cost / Math.max(wallet.balance, proj.cost)) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <button className="primary" disabled={loading || !sliderAffordable} onClick={() => buyPack(selectedMinutes)}>
              Unlock {selectedMinutes} min for {sliderPrice} coins
            </button>
            {!sliderAffordable && (
              <p className="warning subtle">You need {sliderPrice - wallet.balance} more coins for this burst.</p>
            )}
          </div>
        </section>
        <section className="paywall-section">
          <div className="eyebrow">Other unlocks</div>
          <div className="option-grid">
            <button className="option-card" disabled={loading} onClick={startMetered}>
              <div>
                <strong>Fluid meter</strong>
                <p className="subtle">Only pay while you scroll — perfect for quick peeks.</p>
              </div>
              <div className="option-meter">
                <span style={{ width: `${meteredPreviewPercent * 100}%` }} />
              </div>
              <small className="chip">{baseRate} coins / min</small>
            </button>
            {rate?.packs.map((pack) => {
              const percent = wallet.balance > 0 ? Math.min(1, pack.price / wallet.balance) : 1;
              return (
                <button
                  key={pack.minutes}
                  className="option-card"
                  disabled={loading || wallet.balance < pack.price}
                  onClick={() => buyPack(pack.minutes)}
                >
                  <div>
                    <strong>{pack.minutes} minute ritual</strong>
                    <p className="subtle">Set it and forget it — pause anytime.</p>
                  </div>
                  <div className="option-meter">
                    <span style={{ width: `${percent * 100}%` }} />
                  </div>
                  <small className="chip">{pack.price} coins</small>
                </button>
              );
            })}
          </div>
        </section>
        {typeof state.remainingSeconds === 'number' && state.remainingSeconds > 0 && (
          <p className="subtle">Remaining: {Math.round(state.remainingSeconds / 60)} min</p>
        )}
      </div>
    </div>
  );
}
