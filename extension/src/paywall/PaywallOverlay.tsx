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
    mode: 'metered' | 'pack' | 'emergency';
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
  const [showEmergencyForm, setShowEmergencyForm] = useState(false);
  const [justification, setJustification] = useState('');

  // Fallback rate if none is provided (e.g. 1 coin/min)
  const ratePerMin = status.rate?.ratePerMin ?? status.session?.ratePerMin ?? 1;
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
    if (sortedPacks.length) {
      setSelectedMinutes(sortedPacks[0].minutes);
    } else {
      setSelectedMinutes(15);
    }
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
  const sliderPrice = matchedPack
    ? matchedPack.price
    : Math.max(1, Math.round(selectedMinutes * ratePerMin));
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

  const handleStartEmergency = async () => {
    if (isProcessing || !justification.trim()) return;
    setIsProcessing(true);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'START_EMERGENCY',
        payload: { domain, justification }
      });
      if (result.success) {
        cleanup();
        onClose();
      } else {
        alert(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(e);
      alert('Failed to communicate with extension');
    } finally {
      setIsProcessing(false);
    }
  };

  const heading = status.session
    ? status.session.mode === 'pack' ? 'Session paused' : status.session.mode === 'emergency' ? 'Emergency session paused' : 'Metered session paused'
    : 'Unlock this site';

  const infoLine = status.session
    ? status.session.mode === 'pack'
      ? `${Math.round(status.session.remainingSeconds / 60)} minutes remaining`
      : status.session.mode === 'emergency'
        ? 'Emergency access active'
        : 'Metered: paying as you scroll'
    : reason === 'insufficient-funds'
      ? 'Top up to keep browsing'
      : 'Pay with f-coins to continue';

  if (showEmergencyForm) {
    return (
      <div className="tws-paywall-overlay">
        <div className="tws-paywall-modal">
          <header className="tws-paywall-header">
            <div>
              <p className="tws-eyebrow">TimeWellSpent</p>
              <h2>I need it</h2>
              <p className="tws-subtle">Why do you need to access this site right now?</p>
            </div>
          </header>

          <div className="tws-paywall-body">
            <div className="tws-emergency-form">
              <textarea
                placeholder="I need to check..."
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                autoFocus
              />
              <div className="tws-emergency-actions">
                <button
                  className="tws-secondary"
                  onClick={() => setShowEmergencyForm(false)}
                  disabled={isProcessing}
                >
                  Cancel
                </button>
                <button
                  className="tws-primary"
                  onClick={handleStartEmergency}
                  disabled={!justification.trim() || isProcessing}
                >
                  Access for free
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
                <strong>{formatCoins(ratePerMin)}</strong>
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
                <span className="tws-subtle-info">
                  {Math.round((selectedMinutes / (16 * 60)) * 100)}% of your day
                </span>
                <strong>{sliderPrice} coins</strong>
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

          <div className="tws-emergency-link">
            <button onClick={() => setShowEmergencyForm(true)}>
              I need it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatCoins(value: number) {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2).replace(/\.?0+$/, '');
}

function cleanup() {
  const overlay = document.getElementById('tws-block-overlay');
  if (overlay) overlay.remove();
  document.body.style.overflow = '';
}
