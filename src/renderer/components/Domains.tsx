import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CategorisationConfig, RendererApi } from '@shared/types';

type Props = {
  api: RendererApi;
};

type DomainCategory = 'productive' | 'neutral' | 'frivolous';

function normaliseDomain(raw: string) {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      return new URL(trimmed).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }
  return trimmed.split('/')[0].replace(/^www\./, '');
}

function uniq(list: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of list) {
    const d = normaliseDomain(raw);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    result.push(d);
  }
  return result;
}

export default function Domains({ api }: Props) {
  const [config, setConfig] = useState<CategorisationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newDomain, setNewDomain] = useState('');
  const [newCategory, setNewCategory] = useState<DomainCategory>('frivolous');

  const load = useCallback(async () => {
    try {
      const next = await api.settings.categorisation();
      setConfig(next);
    } catch (err) {
      console.error('Failed to load categorisation', err);
      setError('Could not load domain lists.');
    } finally {
      setLoading(false);
    }
  }, [api.settings]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = useMemo(() => {
    if (!config) return { productive: 0, neutral: 0, frivolity: 0 };
    return {
      productive: config.productive.length,
      neutral: config.neutral.length,
      frivolity: config.frivolity.length
    };
  }, [config]);

  const saveConfig = async (next: CategorisationConfig) => {
    setSaving(true);
    setError(null);
    try {
      await api.settings.updateCategorisation(next);
      setConfig(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError((err as Error).message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const setDomainCategory = async (domain: string, category: DomainCategory) => {
    if (!config) return;

    const d = normaliseDomain(domain);
    if (!d) {
      setError('Please enter a valid domain.');
      return;
    }

    const productive = uniq(config.productive.filter((x) => normaliseDomain(x) !== d));
    const neutral = uniq(config.neutral.filter((x) => normaliseDomain(x) !== d));
    const frivolity = uniq(config.frivolity.filter((x) => normaliseDomain(x) !== d));

    if (category === 'productive') productive.unshift(d);
    if (category === 'neutral') neutral.unshift(d);
    if (category === 'frivolous') frivolity.unshift(d);

    await saveConfig({ productive, neutral, frivolity });
  };

  const removeDomain = async (domain: string) => {
    if (!config) return;
    const d = normaliseDomain(domain);
    if (!d) return;
    await saveConfig({
      productive: config.productive.filter((x) => normaliseDomain(x) !== d),
      neutral: config.neutral.filter((x) => normaliseDomain(x) !== d),
      frivolity: config.frivolity.filter((x) => normaliseDomain(x) !== d)
    });
  };

  const handleQuickAdd = async () => {
    setError(null);
    const domain = normaliseDomain(newDomain);
    if (!domain) {
      setError('Enter a domain like twitter.com');
      return;
    }
    setNewDomain('');
    await setDomainCategory(domain, newCategory);
  };

  if (loading) return <div className="panel">Loading domains…</div>;
  if (!config) return <div className="panel">Could not load domains.</div>;

  return (
    <section className="page store-page">
      <header className="page-header">
        <div>
          <h1>Domains</h1>
          <p className="subtle">
            Keep this simple: <strong>productive</strong>, <strong>neutral</strong>, or <strong>frivolous</strong>.
            Idle is inferred automatically.
          </p>
        </div>
        <div className="pill-row">
          <span className="pill ghost">{totals.productive} productive</span>
          <span className="pill ghost">{totals.neutral} neutral</span>
          <span className="pill ghost">{totals.frivolity} frivolous</span>
        </div>
      </header>

      {error && <p className="error-text">{error}</p>}
      {saved && <p className="subtle">Saved.</p>}

      <div className="card">
        <h3>Quick classify</h3>
        <div className="settings-grid" style={{ gridTemplateColumns: '1.2fr 1fr auto', alignItems: 'end' }}>
          <label>
            Domain
            <input
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              placeholder="twitter.com"
              disabled={saving}
            />
          </label>
          <label>
            Category
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as DomainCategory)}
              disabled={saving}
            >
              <option value="productive">productive</option>
              <option value="neutral">neutral</option>
              <option value="frivolous">frivolous</option>
            </select>
          </label>
          <button className="primary" type="button" disabled={saving} onClick={handleQuickAdd}>
            Add
          </button>
        </div>
        <p className="subtle" style={{ marginTop: 10 }}>
          Tip: you can also label domains from the browser extension popup.
        </p>
      </div>

      <div className="store-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <DomainList
          title="Productive"
          subtitle="Earns f-coins."
          items={config.productive}
          onRemove={removeDomain}
          onMove={(domain) => setDomainCategory(domain, 'productive')}
          disabled={saving}
        />
        <DomainList
          title="Neutral"
          subtitle="Safe by default (earning depends on your clock-in settings)."
          items={config.neutral}
          onRemove={removeDomain}
          onMove={(domain) => setDomainCategory(domain, 'neutral')}
          disabled={saving}
        />
        <DomainList
          title="Frivolous"
          subtitle="Paywall applies here."
          items={config.frivolity}
          onRemove={removeDomain}
          onMove={(domain) => setDomainCategory(domain, 'frivolous')}
          disabled={saving}
        />
      </div>
    </section>
  );
}

function DomainList(props: {
  title: string;
  subtitle: string;
  items: string[];
  disabled: boolean;
  onRemove(domain: string): void;
  onMove(domain: string): void;
}) {
  const { title, subtitle, items, disabled, onRemove } = props;
  return (
    <div className="card store-item">
      <div className="store-item-headline">
        <div>
          <p className="store-item-domain">{title}</p>
          <h3 className="store-item-title">{items.length} domains</h3>
        </div>
        <div className="store-item-price-pill">
          <strong>{items.length}</strong>
          <span>items</span>
        </div>
      </div>
      <p className="subtle" style={{ marginTop: 6 }}>{subtitle}</p>
      {items.length === 0 ? (
        <div className="empty-state" style={{ padding: 0 }}>
          <p className="subtle">None yet.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {items.slice(0, 12).map((domain) => (
            <div key={domain} style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center' }}>
              <code style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{domain}</code>
              <button className="ghost danger" disabled={disabled} onClick={() => onRemove(domain)}>
                Remove
              </button>
            </div>
          ))}
          {items.length > 12 && (
            <p className="subtle" style={{ margin: 0 }}>
              Showing 12 of {items.length}. Use search/edit tools in a future iteration.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

