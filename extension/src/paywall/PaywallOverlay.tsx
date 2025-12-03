import { useEffect, useMemo, useState } from 'react';

type StatusResponse = {
  balance: number;
  rate: {
    domain: string;
    ratePerMin: number;
    packs: Array<{ minutes: number; price: number }>;
  } | null;
  session: {
    domain: string;
    mode: 'metered' | 'pack';
    ratePerMin: number;
    remainingSeconds: number;
    paused?: boolean;
  } | null;
  lastSync: number | null;
  desktopConnected: boolean;
};

type Props = {
  domain: string;
  status: StatusResponse;
  reason?: string;
  onClose(): void;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export default function PaywallOverlay({ domain, status, reason, onClose }: Props) {
  const [selectedMinutes, setSelectedMinutes] = useState(15);
  const rate = status.rate;

  const sliderBounds = useMemo(() => {
    const minutes = rate?.packs.map((pack) => pack.minutes) ?? [];
    const min = minutes.length ? Math.min(...minutes) : 10;
    const maxFromPacks = minutes.length ? Math.max(...minutes) : 30;
    const max = Math.max(maxFromPacks, min + 15, 45);
    return { min: Math.max(5, min), max, step: 5 };
  }, [rate]);

  useEffect(() => {
    const defaultMinutes = rate?.packs?.[0]?.minutes ?? sliderBounds.min;
    setSelectedMinutes(clamp(defaultMinutes, sliderBounds.min, sliderBounds.max));
  }, [rate, sliderBounds.max, sliderBounds.min]);

  const baseRate = rate?.ratePerMin ?? status.session?.ratePerMin ?? 0;
  const matchedPack = rate?.packs.find((pack) => pack.minutes === selectedMinutes);
  const sliderPrice = matchedPack ? matchedPack.price : Math.max(1, Math.round(selectedMinutes * baseRate));
  const walletPercent = status.balance > 0 ? Math.min(1, sliderPrice / status.balance) : 1;
  const coinsLeft = Math.max(0, status.balance - sliderPrice);
  const sliderAffordable = status.balance >= sliderPrice;
  const sliderMidLabel = Math.round((sliderBounds.min + sliderBounds.max) / 2);
  const gaugeRadius = 72;
  const circumference = 2 * Math.PI * gaugeRadius;
  const dashOffset = circumference * (1 - walletPercent);
  const dayShare = Math.min(1, selectedMinutes / (24 * 60));
  const walletSharePct = walletPercent * 100;
  const daySharePct = Math.round(dayShare * 100);
  const meteredPreviewPercent = status.balance > 0 ? Math.min(1, (baseRate * 15) / status.balance) : 1;

  const projections = [
    { label: 'Quick peek', minutes: Math.max(5, Math.round(selectedMinutes * 0.4)) },
    { label: 'This choice', minutes: selectedMinutes },
    { label: 'Deep dive', minutes: Math.min(120, Math.round(selectedMinutes * 1.6)) }
  ].map((p) => ({ ...p, cost: Math.max(1, Math.round(p.minutes * baseRate)) }));

  const heading = status.session
    ? status.session.mode === 'pack' ? 'Session paused' : 'Metered session paused'
    : 'Unlock this site';

  const infoLine = status.session
    ? status.session.mode === 'pack'
      ? `${Math.round(status.session.remainingSeconds / 60)} minutes remaining`
      : 'Metered: paying as you scroll'
    : reason === 'insufficient-funds'
      ? 'Top up to keep browsing'
      : 'Pay with f-coins to continue';

  return (
    <div className="tws-paywall-overlay">
      <div className="tws-paywall-modal">
        <header className="tws-paywall-header">
          <div>
            <p className="tws-eyebrow">TimeWellSpent</p>
            <h2>{heading}</h2>
            <p className="tws-subtle">{infoLine}</p>
          </div>
        </header>

        <div className="tws-wallet-inline">
          <span>Balance</span>
          <strong>{status.balance} coins</strong>
        </div>

        <section className="tws-spend-lab">
          <div className="tws-budget-visual">
            <div className="tws-budget-circle" role="img" aria-label={`Spending ${sliderPrice} coins for ${selectedMinutes} minutes`}>
              <svg viewBox="0 0 200 200" width="200" height="200">
                <circle className="tws-budget-track" cx="100" cy="100" r={gaugeRadius} strokeWidth="14" />
                <circle
                  className="tws-budget-fill"
                  cx="100"
                  cy="100"
                  r={gaugeRadius}
                  strokeWidth="14"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                />
              </svg>
              <div className="tws-budget-figures">
                <strong>{sliderPrice} coins</strong>
                <span>{selectedMinutes} minute unlock</span>
                <small className="tws-subtle">{walletSharePct.toFixed(0)}% of spendable</small>
              </div>
            </div>
            <div className="tws-impact-bars">
              <div>
                <div className="tws-impact-label">Wallet impact</div>
                <div className="tws-impact-meter">
                  <span style={{ width: `${walletSharePct}%` }} />
                </div>
                <small className="tws-subtle">Leaves {coinsLeft} coins</small>
              </div>
              <div>
                <div className="tws-impact-label">Day share</div>
                <div className="tws-impact-meter day">
                  <span style={{ width: `${daySharePct}%` }} />
                </div>
                <small className="tws-subtle">{daySharePct}% of your day if you stay that long</small>
              </div>
            </div>
          </div>
          <div className="tws-budget-controls">
            <div className="tws-eyebrow">Shape your session</div>
            <p className="tws-subtle">Use the slider to choreograph how much time (and money) you want to burn on this domain.</p>
            <input
              id="tws-focus-budget"
              type="range"
              min={sliderBounds.min}
              max={sliderBounds.max}
              step={sliderBounds.step}
              value={selectedMinutes}
              onChange={(event) => setSelectedMinutes(Number(event.target.value))}
            />
            <div className="tws-budget-scale">
              <span>{sliderBounds.min} min</span>
              <span>{sliderMidLabel} min</span>
              <span>{sliderBounds.max}+ min</span>
            </div>
            <div className="tws-projection-grid">
              {projections.map((proj) => (
                <div key={proj.label} className="tws-projection-card">
                  <div className="tws-projection-minutes">{proj.minutes}m</div>
                  <div className="tws-projection-label">{proj.label}</div>
                  <div className="tws-projection-cost">{proj.cost} coins</div>
                  <div className="tws-projection-bar">
                    <span style={{ width: `${Math.min(100, (proj.cost / Math.max(status.balance, proj.cost)) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <button
              className="tws-primary"
              disabled={!sliderAffordable}
              onClick={() => buyPack(domain, selectedMinutes, onClose)}
            >
              Unlock {selectedMinutes} min for {sliderPrice} coins
            </button>
            {!sliderAffordable && (
              <p className="tws-warning tws-subtle">You need {sliderPrice - status.balance} more coins for this burst.</p>
            )}
          </div>
        </section>

        <section className="tws-paywall-section">
          <div className="tws-eyebrow">Other unlocks</div>
          <div className="tws-option-grid">
            <button className="tws-option-card" onClick={() => startMetered(domain, onClose)}>
              <div>
                <strong>Fluid meter</strong>
                <p className="tws-subtle">Only pay while you scroll — perfect for quick peeks.</p>
              </div>
              <div className="tws-option-meter">
                <span style={{ width: `${meteredPreviewPercent * 100}%` }} />
              </div>
              <small className="tws-chip">{baseRate} coins / min</small>
            </button>
            {rate?.packs.map((pack) => {
              const percent = status.balance > 0 ? Math.min(1, pack.price / status.balance) : 1;
              return (
                <button
                  key={pack.minutes}
                  className="tws-option-card"
                  disabled={status.balance < pack.price}
                  onClick={() => buyPack(domain, pack.minutes, onClose)}
                >
                  <div>
                    <strong>{pack.minutes} minute ritual</strong>
                    <p className="tws-subtle">Set it and forget it — pause anytime.</p>
                  </div>
                  <div className="tws-option-meter">
                    <span style={{ width: `${percent * 100}%` }} />
                  </div>
                  <small className="tws-chip">{pack.price} coins</small>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

async function buyPack(domain: string, minutes: number, onClose: () => void) {
  const result = await chrome.runtime.sendMessage({
    type: 'BUY_PACK',
    payload: { domain, minutes }
  });

  if (result.success) {
    cleanup();
    onClose();
  } else {
    alert(`Failed to purchase: ${result.error}`);
  }
}

async function startMetered(domain: string, onClose: () => void) {
  const result = await chrome.runtime.sendMessage({
    type: 'START_METERED',
    payload: { domain }
  });

  if (result.success) {
    cleanup();
    onClose();
  } else {
    alert(`Failed to start metered session: ${result.error}`);
  }
}

function cleanup() {
  const overlay = document.getElementById('tws-block-overlay');
  if (overlay) overlay.remove();
  document.body.style.overflow = '';
}
