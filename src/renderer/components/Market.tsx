import { useState, type FormEvent } from 'react';
import type { MarketRate, RendererApi, WalletSnapshot } from '@shared/types';

interface MarketProps {
  api: RendererApi;
  rates: MarketRate[];
  onChange(rates: MarketRate[]): void;
  wallet: WalletSnapshot;
}

export default function Market({ api, rates, onChange, wallet }: MarketProps) {
  const [domain, setDomain] = useState('');
  const [ratePerMin, setRatePerMin] = useState(3);
  const [packMinutes, setPackMinutes] = useState(10);
  const [packPrice, setPackPrice] = useState(30);

  async function addRate(event: FormEvent) {
    event.preventDefault();
    if (!domain.trim()) return;
    const existing = rates.find((rate) => rate.domain === domain.trim());
    const record: MarketRate = existing
      ? { ...existing, ratePerMin }
      : { domain: domain.trim(), ratePerMin, packs: [] };
    if (packMinutes > 0 && packPrice > 0) {
      record.packs = [...record.packs.filter((pack) => pack.minutes !== packMinutes), { minutes: packMinutes, price: packPrice }];
    }
    await api.market.upsert(record);
    const next = [...rates.filter((item) => item.domain !== record.domain), record].sort((a, b) =>
      a.domain.localeCompare(b.domain)
    );
    onChange(next);
    setDomain('');
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h1>Frivolity market</h1>
          <p className="subtle">Tune exchange rates and packs to shape habits.</p>
        </div>
        <div className="wallet-tile">
          <span>Wallet</span>
          <strong>{wallet.balance}</strong>
        </div>
      </header>

      <form className="market-form" onSubmit={addRate}>
        <input placeholder="domain" value={domain} onChange={(event) => setDomain(event.target.value)} />
        <label>
          Rate/min
          <input
            type="number"
            step={0.5}
            value={ratePerMin}
            onChange={(event) => setRatePerMin(Number(event.target.value))}
          />
        </label>
        <label>
          Pack minutes
          <input
            type="number"
            value={packMinutes}
            onChange={(event) => setPackMinutes(Number(event.target.value))}
          />
        </label>
        <label>
          Pack price
          <input
            type="number"
            value={packPrice}
            onChange={(event) => setPackPrice(Number(event.target.value))}
          />
        </label>
        <button className="primary" type="submit">
          Save rate
        </button>
      </form>

      <div className="market-grid">
        {rates
          .sort((a, b) => a.domain.localeCompare(b.domain))
          .map((rate) => (
            <article key={rate.domain} className="card">
              <header>
                <h2>{rate.domain}</h2>
                <span className="subtle">{rate.ratePerMin} coins/min</span>
              </header>
              <ul className="packs">
                {rate.packs.map((pack) => (
                  <li key={pack.minutes}>
                    <span>{pack.minutes} min</span>
                    <strong>{pack.price} coins</strong>
                    {rate.ratePerMin > 0 && (
                      <span className="subtle">
                        {Math.round(((pack.price / pack.minutes) / rate.ratePerMin - 1) * 100)}% vs metered
                      </span>
                    )}
                  </li>
                ))}
                {rate.packs.length === 0 && <li className="subtle">No packs configured.</li>}
              </ul>
            </article>
          ))}
      </div>
    </section>
  );
}
