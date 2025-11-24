import React, { useState, useEffect } from 'react';
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
    const [saving, setSaving] = useState(false);

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
                merged.push({ id: rate.domain, type: 'neutral', rate });
            }
        });

        setItems(merged);
        if (!selectedId && merged.length > 0) {
            setSelectedId(merged[0].id);
        }
    }

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

    return (
        <section className="panel">
            <header className="panel-header">
                <div>
                    <h1>Economy Tuner</h1>
                    <p className="subtle">Fine-tune value and costs over time.</p>
                </div>
            </header>

            <div className="tuner-layout" style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: '24px', height: 'calc(100vh - 140px)' }}>
                <aside className="sidebar-list" style={{ borderRight: '1px solid rgba(0,0,0,0.1)', overflowY: 'auto' }}>
                    {items.map(item => (
                        <div
                            key={item.id}
                            onClick={() => setSelectedId(item.id)}
                            style={{
                                padding: '12px',
                                cursor: 'pointer',
                                background: selectedId === item.id ? 'rgba(0,0,0,0.05)' : 'transparent',
                                borderRadius: '8px',
                                marginBottom: '4px'
                            }}
                        >
                            <div style={{ fontWeight: 500 }}>{item.id}</div>
                            <div style={{ fontSize: '12px', color: 'var(--text-subtle)', textTransform: 'capitalize' }}>
                                {item.type} • {item.rate.ratePerMin}/min
                            </div>
                        </div>
                    ))}
                </aside>

                <main className="tuner-editor">
                    {selectedItem ? (
                        <div className="card">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                                <h2>{selectedItem.id}</h2>
                                <button className="primary" onClick={save} disabled={saving}>
                                    {saving ? 'Saving...' : 'Save Changes'}
                                </button>
                            </div>

                            <div className="form-group" style={{ marginBottom: '24px' }}>
                                <label>Base Rate (per minute)</label>
                                <input
                                    type="number"
                                    value={selectedItem.rate.ratePerMin}
                                    onChange={(e) => handleRateChange(Number(e.target.value))}
                                    step="0.1"
                                />
                                <p className="subtle">
                                    {selectedItem.type === 'productive' ? 'Income earned' : 'Cost to access'} per minute.
                                </p>
                            </div>

                            <div className="form-group">
                                <label>Time Multiplier Curve</label>
                                <p className="subtle" style={{ marginBottom: '16px' }}>
                                    Adjust how the value changes throughout the day. 1x is standard.
                                </p>
                                <CurveEditor
                                    values={selectedItem.rate.hourlyModifiers}
                                    onChange={handleCurveChange}
                                    color={selectedItem.type === 'productive' ? '#4caf50' : '#f44336'}
                                />
                            </div>
                        </div>
                    ) : (
                        <div className="empty-state">Select an item to tune</div>
                    )}
                </main>
            </div>
        </section>
    );
}
