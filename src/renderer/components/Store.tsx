import React, { useState, useEffect } from 'react';
import type { StoreItem, RendererApi } from '@shared/types';

type Props = {
    api: RendererApi;
};

export default function Store({ api }: Props) {
    const [items, setItems] = useState<StoreItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [isAdding, setIsAdding] = useState(false);
    const [newUrl, setNewUrl] = useState('');
    const [newPrice, setNewPrice] = useState(10);
    const [newTitle, setNewTitle] = useState('');
    const [error, setError] = useState<string | null>(null);

    const loadItems = async () => {
        try {
            const data = await api.store.list();
            setItems(data);
        } catch (err) {
            console.error('Failed to load store items:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadItems();
    }, []);

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        if (!newUrl.trim()) {
            setError('URL is required');
            return;
        }
        if (newPrice < 1) {
            setError('Price must be at least 1');
            return;
        }

        try {
            // Validate URL
            let url = newUrl.trim();
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'https://' + url;
            }
            new URL(url); // Validate

            await api.store.add(url, newPrice, newTitle.trim() || undefined);
            setNewUrl('');
            setNewPrice(10);
            setNewTitle('');
            setIsAdding(false);
            await loadItems();
        } catch (err) {
            setError((err as Error).message || 'Failed to add item');
        }
    };

    const handleRemove = async (id: number) => {
        if (!confirm('Remove this item from the store?')) return;
        try {
            await api.store.remove(id);
            await loadItems();
        } catch (err) {
            console.error('Failed to remove item:', err);
        }
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        return date.toLocaleDateString();
    };

    if (loading) {
        return <div className="panel">Loading store...</div>;
    }

    return (
        <section className="page store-page">
            <header className="page-header">
                <div>
                    <h1>Store</h1>
                    <p className="subtle">
                        Add specific content you want to access for a fixed price.
                        Pay once, access until you navigate away.
                    </p>
                </div>
                <button className="primary" onClick={() => setIsAdding(true)}>
                    + Add Item
                </button>
            </header>

            {isAdding && (
                <div className="card add-item-form">
                    <h3>Add to Store</h3>
                    <form onSubmit={handleAdd}>
                        {error && <p className="error-text">{error}</p>}
                        <div className="form-group">
                            <label>URL</label>
                            <input
                                type="text"
                                placeholder="https://youtube.com/watch?v=..."
                                value={newUrl}
                                onChange={(e) => setNewUrl(e.target.value)}
                                autoFocus
                            />
                            <p className="subtle">Paste the exact URL you want to access</p>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Price (f-coins)</label>
                                <input
                                    type="number"
                                    value={newPrice}
                                    onChange={(e) => setNewPrice(Number(e.target.value))}
                                    min={1}
                                    max={500}
                                />
                            </div>
                            <div className="form-group">
                                <label>Title (optional)</label>
                                <input
                                    type="text"
                                    placeholder="e.g., Funny cat video"
                                    value={newTitle}
                                    onChange={(e) => setNewTitle(e.target.value)}
                                />
                            </div>
                        </div>
                        <div className="form-actions">
                            <button type="button" className="ghost" onClick={() => setIsAdding(false)}>
                                Cancel
                            </button>
                            <button type="submit" className="primary">
                                Add to Store
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {items.length === 0 ? (
                <div className="empty-state">
                    <p>No items in your store yet.</p>
                    <p className="subtle">
                        Add specific URLs you want to access for a fixed cost.
                        Unlike metered sessions, you pay once and access until you leave.
                    </p>
                </div>
            ) : (
                <div className="store-grid">
                    {items.map((item) => (
                        <div key={item.id} className="card store-item">
                            <div className="store-item-header">
                                <span className="store-item-price">{item.price} f-coins</span>
                                <button className="ghost danger small" onClick={() => handleRemove(item.id)}>
                                    Remove
                                </button>
                            </div>
                            <div className="store-item-title">
                                {item.title || item.domain}
                            </div>
                            <a
                                className="store-item-url"
                                href={item.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={item.url}
                            >
                                {item.url.length > 50 ? item.url.slice(0, 50) + '...' : item.url}
                            </a>
                            <div className="store-item-meta">
                                <span>Added {formatDate(item.createdAt)}</span>
                                {item.lastUsedAt && (
                                    <span>Last used {formatDate(item.lastUsedAt)}</span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}
