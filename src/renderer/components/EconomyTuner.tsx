import React, { useState, useEffect, useMemo } from 'react';
import type { RendererApi, MarketRate, CategorisationConfig } from '@shared/types';
import CurveEditor from './CurveEditor';

type EconomyTunerProps = {
    api: RendererApi;
};

type TunerItem = {
    id: string;
    type: 'productive' | 'frivolity' | 'neutral';
    rate: MarketRate;
};

export default function EconomyTuner({ api }: EconomyTunerProps) {
    const [items, setItems] = useState<TunerItem[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'productive' | 'frivolity'>('productive');
    const [saving, setSaving] = useState(false);

    const [isAdding, setIsAdding] = useState(false);
    const [newDomain, setNewDomain] = useState('');

    useEffect(() => {
        loadData();
    }, []);

    async function loadData() {
        const [rates, config] = await Promise.all([
            api.market.list(),
            api.settings.categorisation()
        ]);

        const merged: TunerItem[] = [];
        const rateMap = new Map(rates.map(r => [r.domain, r]));

        // Helper to create or get rate
        const getRate = (domain: string, defaultRate: number): MarketRate => {
            return rateMap.get(domain) || {
                domain,
                ratePerMin: defaultRate,
                packs: [],
                hourlyModifiers: Array(24).fill(1)
            };
        };

        config.productive.forEach(domain => {
            merged.push({ id: domain, type: 'productive', rate: getRate(domain, 5) });
        });
        config.frivolity.forEach(domain => {
            merged.push({ id: domain, type: 'frivolity', rate: getRate(domain, 3) });
        });
        // Add any market rates that aren't in config (custom ones)
        rates.forEach(rate => {
            if (!merged.find(m => m.id === rate.domain)) {
                // Default to frivolity if unknown, or maybe neutral? 
                // For now let's assume neutral items are frivolity for tuning purposes unless specified
                merged.push({ id: rate.domain, type: 'neutral', rate });
            }
        });

        setItems(merged);
    }

    const filteredItems = items.filter(item => {
        if (activeTab === 'productive') return item.type === 'productive';
        return item.type === 'frivolity' || item.type === 'neutral';
    });

    // Auto-select first item when tab changes or data loads
    useEffect(() => {
        if (!isAdding && filteredItems.length > 0 && (!selectedId || !filteredItems.find(i => i.id === selectedId))) {
            setSelectedId(filteredItems[0].id);
        } else if (filteredItems.length === 0 && !isAdding) {
            setSelectedId(null);
        }
    }, [activeTab, items, isAdding]);

    const selectedItem = items.find(i => i.id === selectedId);

    const handleRateChange = (newRate: number) => {
        if (!selectedItem) return;
        updateItemRate(selectedItem.id, { ...selectedItem.rate, ratePerMin: newRate });
    };

    const handleCurveChange = (newModifiers: number[]) => {
        if (!selectedItem) return;
        updateItemRate(selectedItem.id, { ...selectedItem.rate, hourlyModifiers: newModifiers });
    };

    const updateItemRate = (id: string, newRate: MarketRate) => {
        setItems(prev => prev.map(item => item.id === id ? { ...item, rate: newRate } : item));
    };

    const save = async () => {
        if (!selectedItem) return;
        setSaving(true);
        await api.market.upsert(selectedItem.rate);
        setSaving(false);
    };

    const handleAddProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newDomain.trim()) return;

        const domain = newDomain.trim();
        // Check if already exists
        if (items.find(i => i.id === domain)) {
            alert('Profile already exists');
            return;
        }

        const newRate: MarketRate = {
            domain,
            ratePerMin: 3,
            packs: [],
            hourlyModifiers: Array(24).fill(1)
        };

        await api.market.upsert(newRate);
        await loadData();
        setNewDomain('');
        setIsAdding(false);
        setSelectedId(domain);
        setActiveTab('frivolity'); // Switch to frivolity as that's where new items go
    };

    const title = useMemo(() => activeTab === 'productive' ? 'Earn profiles' : 'Spend profiles', [activeTab]);
    const subtitle = useMemo(() => activeTab === 'productive'
        ? 'Tune how productive apps reward you over the day.'
        : 'Shape how costly domains evolve over the day.', [activeTab]);

    const metrics = useMemo(() => {
        if (!selectedItem) return [];
        const modifiers = selectedItem.rate.hourlyModifiers;
        const maxMod = Math.max(...modifiers);
        const minMod = Math.min(...modifiers);
        return [
            { label: 'Base rate', value: `${selectedItem.rate.ratePerMin} c/m` },
            { label: 'Peak multiplier', value: `${maxMod.toFixed(1)}x` },
            { label: 'Off-peak', value: `${minMod.toFixed(1)}x` }
        ];
    }, [selectedItem]);

    return (
        <section className="panel tuner-panel">
            <header className="panel-header tuner-header-row">
                <div>
                    <p className="eyebrow">Economy</p>
                    <h1>{title}</h1>
                    <p className="subtle">{subtitle}</p>
                </div>
                <div className="toggle-wrap">
                    <span className="subtle">Productive</span>
                    <label className="ios-switch">
                        <input
                            type="checkbox"
                            checked={activeTab === 'frivolity'}
                            onChange={(e) => setActiveTab(e.target.checked ? 'frivolity' : 'productive')}
                        />
                        <span className="slider" />
                    </label>
                    <span className="subtle">Frivolous</span>
                </div>
            </header>

            <div className="tuner-layout">
                <aside className="tuner-list">
                    <div style={{ padding: '0 4px 8px 4px', borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: '8px' }}>
                        {!isAdding ? (
                            <button className="ghost" style={{ width: '100%', textAlign: 'center', fontSize: '13px' }} onClick={() => setIsAdding(true)}>
                                + Add Profile
                            </button>
                        ) : (
                            <form onSubmit={handleAddProfile} style={{ display: 'flex', gap: '6px' }}>
                                <input
                                    autoFocus
                                    placeholder="domain.com"
                                    value={newDomain}
                                    onChange={e => setNewDomain(e.target.value)}
                                    style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: '13px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: 'white' }}
                                />
                                <button type="submit" className="primary" style={{ padding: '6px 10px', fontSize: '13px' }}>Add</button>
                                <button type="button" className="ghost" style={{ padding: '6px', fontSize: '13px' }} onClick={() => setIsAdding(false)}>✕</button>
                            </form>
                        )}
                    </div>

                    {filteredItems.map(item => (
                        <button
                            key={item.id}
                            className={`tuner-list-item ${selectedId === item.id ? 'active' : ''}`}
                            onClick={() => setSelectedId(item.id)}
                        >
                            <div className="tuner-list-title">{item.id}</div>
                            <div className="tuner-list-sub">{item.rate.ratePerMin} coins/min • {item.type}</div>
                        </button>
                    ))}
                    {filteredItems.length === 0 && (
                        <div className="subtle" style={{ padding: '12px' }}>No items in this category.</div>
                    )}
                </aside>

                <main className="tuner-editor">
                    {selectedItem ? (
                        <div className={`tuner-grid ${selectedItem.type === 'productive' ? 'single' : ''}`}>
                            <div className="card tuner-primary">
                                <div className="tuner-header">
                                    <div>
                                        <h2>{selectedItem.id}</h2>
                                        <p className="subtle">{selectedItem.type === 'productive' ? 'Earn profile' : 'Spend profile'}</p>
                                    </div>
                                    <button className="primary" onClick={save} disabled={saving}>
                                        {saving ? 'Saving...' : 'Save changes'}
                                    </button>
                                </div>

                                {metrics.length > 0 && (
                                    <div className="tuner-metrics">
                                        {metrics.map((metric) => (
                                            <div key={metric.label} className="metric-card">
                                                <span className="metric-label">{metric.label}</span>
                                                <strong className="metric-value">{metric.value}</strong>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div className="form-group">
                                    <label>Base rate (per minute)</label>
                                    <input
                                        type="number"
                                        value={selectedItem.rate.ratePerMin}
                                        onChange={(e) => handleRateChange(Number(e.target.value))}
                                        step="0.1"
                                    />
                                    <p className="subtle">
                                        {selectedItem.type === 'productive' ? 'Income earned per minute.' : 'Cost per minute if metered.'}
                                    </p>
                                </div>

                                <div className="form-group">
                                    <label>Time multiplier curve</label>
                                    <p className="subtle">
                                        Adjust how the value changes throughout the day. 1x is standard.
                                    </p>
                                    <CurveEditor
                                        values={selectedItem.rate.hourlyModifiers}
                                        onChange={handleCurveChange}
                                        color={selectedItem.type === 'productive' ? 'var(--cat-productive)' : 'var(--cat-frivolity)'}
                                    />
                                </div>
                            </div>

                            {selectedItem.type !== 'productive' && (
                                <div className="card tuner-secondary">
                                    <div className="tuner-header">
                                        <div>
                                            <h3>Packs preview</h3>
                                            <p className="subtle">Show what users see when buying time.</p>
                                        </div>
                                    </div>
                                    <div className="packs-preview">
                                        {selectedItem.rate.packs.length === 0 && (
                                            <p className="subtle">No packs defined — consider adding 10/30/60 minute options.</p>
                                        )}
                                        {selectedItem.rate.packs.map((pack) => (
                                            <div key={pack.minutes} className="pack-card">
                                                <div>
                                                    <strong>{pack.minutes} minute burst</strong>
                                                    <p className="subtle">{pack.price} coins • {((pack.price / pack.minutes) * 60).toFixed(1)} c/hour</p>
                                                </div>
                                                <button className="ghost">Preview</button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="empty-state">Select an item to tune</div>
                    )}
                </main>
            </div>
        </section>
    );
}
