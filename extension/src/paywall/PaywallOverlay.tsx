import { useMemo, useState } from 'react';

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

export default function PaywallOverlay({ domain, status, reason, onClose }: Props) {
  const [selectedMinutes, setSelectedMinutes] = useState(15);
  const [isProcessing, setIsProcessing] = useState(false);

  // Fallback rate if none is provided (e.g. 1 coin/min)
  const ratePerMin = status.rate?.ratePerMin ?? status.session?.ratePerMin ?? 1;

  const sliderBounds = useMemo(() => {
    return { min: 5, max: 120, step: 5 };
  }, []);

  const sliderPrice = Math.max(1, Math.ceil(selectedMinutes * ratePerMin));
  const sliderAffordable = status.balance >= sliderPrice;

  // Handlers
  const handleBuyPack = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'BUY_PACK',
        payload: { domain, minutes: selectedMinutes }
      });
      if (result.success) {
        cleanup();
        onClose();
      } else {
        alert(`Failed to purchase: ${result.error}`);
      }
    } catch (e) {
      console.error(e);
      alert('Failed to communicate with extension');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStartMetered = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
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
    } catch (e) {
      console.error(e);
      alert('Failed to communicate with extension');
    } finally {
      setIsProcessing(false);
    }
  };

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
          <div className="tws-wallet-badge">
            <span>Balance</span>
            <strong>{status.balance} coins</strong>
          </div>
        </header>

        <div className="tws-paywall-body">
          {/* Option 1: Pay As You Go */}
          <section className="tws-paywall-option">
            <div className="tws-option-header">
              <h3>Pay As You Go</h3>
              <p className="tws-subtle">Pay only for the time you spend.</p>
            </div>
            <div className="tws-option-action">
              <div className="tws-price-tag">
                <strong>{ratePerMin}</strong>
                <small>coins / min</small>
              </div>
              <button
                className="tws-secondary"
                onClick={handleStartMetered}
                disabled={status.balance < 1 || isProcessing}
              >
                Start Metered
              </button>
            </div>
          </section>

          <div className="tws-divider">
            <span>OR</span>
          </div>

          {/* Option 2: Pre-pay (Slider) */}
          <section className="tws-paywall-option">
            <div className="tws-option-header">
              <h3>Pre-pay Session</h3>
              <p className="tws-subtle">Commit to a fixed time.</p>
            </div>

            <div className="tws-slider-container">
              <div className="tws-slider-labels">
                <span>{selectedMinutes} minutes</span>
                <strong>{sliderPrice} coins</strong>
              </div>
              <input
                type="range"
                min={sliderBounds.min}
                max={sliderBounds.max}
                step={sliderBounds.step}
                value={selectedMinutes}
                onChange={(e) => setSelectedMinutes(Number(e.target.value))}
              />
              <div className="tws-slider-scale">
                <small>{sliderBounds.min}m</small>
                <small>{sliderBounds.max}m</small>
              </div>
            </div>

            <div className="tws-option-action">
              <button
                className="tws-primary"
                onClick={handleBuyPack}
                disabled={!sliderAffordable || isProcessing}
              >
                Unlock for {sliderPrice} coins
              </button>
              {!sliderAffordable && (
                <p className="tws-error-text">Need {sliderPrice - status.balance} more coins</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function cleanup() {
  const overlay = document.getElementById('tws-block-overlay');
  if (overlay) overlay.remove();
  document.body.style.overflow = '';
}
