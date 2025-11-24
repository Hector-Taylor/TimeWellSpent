import { useMemo, useState } from 'react';
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

export default function PaywallOverlay({ open, state, wallet, api, marketRates, onWallet, onClose }: PaywallOverlayProps) {
  const [loading, setLoading] = useState(false);
  const rate = useMemo(() => {
    if (!state) return undefined;
    return marketRates.find((item) => item.domain === state.domain);
  }, [marketRates, state]);

  if (!open || !state) {
    return null;
  }

  const [error, setError] = useState<string | null>(null);

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

  async function buyPack(minutes: number, price: number) {
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

  return (
    <div className="paywall-overlay">
      <div className="paywall-modal">
        <header>
          <h2>{state.domain}</h2>
          <p className="subtle">
            {blocked
              ? 'TimeWellSpent closed this tab — unlock access by paying for screen time.'
              : 'Stay intentional: spend f-coins to access this site.'}
          </p>
        </header>
        <div className="wallet-inline">
          <span>Balance</span>
          <strong>{wallet.balance}</strong>
        </div>
        {error && <p className="warning" style={{ color: 'var(--color-danger)' }}>{error}</p>}
        {blocked && !error && <p className="warning">Pay-as-you-go or grab a pack to re-open the site.</p>}
        {insufficient && !error && (
          <p className="warning">Session paused — add more coins or choose a smaller pack.</p>
        )}
        <div className="options">
          <button className="primary" disabled={loading} onClick={startMetered}>
            Pay-as-you-go {rate ? `(${rate.ratePerMin} coins/min)` : ''}
          </button>
          {rate?.packs.map((pack) => (
            <button key={pack.minutes} disabled={loading || wallet.balance < pack.price} onClick={() => buyPack(pack.minutes, pack.price)}>
              {pack.minutes} minutes — {pack.price} coins
            </button>
          ))}
        </div>
        {typeof state.remainingSeconds === 'number' && state.remainingSeconds > 0 && (
          <p className="subtle">Remaining: {Math.round(state.remainingSeconds / 60)} min</p>
        )}
        <footer>
          <button
            className="ghost"
            onClick={async () => {
              if (state) {
                await api.paywall.decline(state.domain);
              }
              onClose();
            }}
          >
            Decline
          </button>
        </footer>
      </div>
    </div>
  );
}
