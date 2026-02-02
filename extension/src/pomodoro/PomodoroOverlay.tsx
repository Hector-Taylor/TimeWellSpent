import { useMemo, useState } from 'react';

type Props = {
    domain: string;
    remainingMs?: number;
    mode: 'strict' | 'soft';
    softUnlockMs?: number;
    reason?: string;
    onRequestOverride?: () => Promise<void>;
};

function formatRemaining(ms?: number) {
    if (!ms || ms < 0) return '—';
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export default function PomodoroOverlay({ domain, remainingMs, mode, softUnlockMs, reason, onRequestOverride }: Props) {
    const [status, setStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
    const [error, setError] = useState<string | null>(null);
    const formatted = useMemo(() => formatRemaining(remainingMs), [remainingMs]);
    const unlockLabel = softUnlockMs ? `Request ${Math.round(softUnlockMs / 60000)}m` : 'Request access';

    async function handleRequest() {
        if (!onRequestOverride) return;
        try {
            setStatus('pending');
            await onRequestOverride();
            setStatus('done');
        } catch (e) {
            setStatus('error');
            setError((e as Error).message ?? 'Failed to request access');
        }
    }

    return (
        <div style={styles.backdrop}>
            <div style={styles.card}>
                <div style={styles.header}>
                    <span style={styles.badge}>Pomodoro focus</span>
                    <span style={styles.clock}>{formatted}</span>
                </div>
                <h1 style={styles.title}>Not on the allowlist</h1>
                <p style={styles.subtitle}>
                    {mode === 'strict'
                        ? `Stay on your chosen tools until the timer ends.`
                        : `You can request a short unlock if you really need ${domain}.`}
                </p>
                {reason && <p style={styles.reason}>Reason: {reason}</p>}
                <div style={styles.actions}>
                    {mode === 'soft' && (
                        <button style={{ ...styles.button, ...styles.primary }} disabled={status === 'pending'} onClick={handleRequest}>
                            {status === 'pending' ? 'Requesting…' : status === 'done' ? 'Requested' : unlockLabel}
                        </button>
                    )}
                    <div style={styles.meta}>
                        <span>Allowed list is enforced for this session.</span>
                    </div>
                </div>
                {error && <div style={styles.error}>{error}</div>}
            </div>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    backdrop: {
        position: 'fixed',
        inset: 0,
        background: 'radial-gradient(circle at 20% 20%, rgba(120,139,255,0.18), transparent), radial-gradient(circle at 80% 0%, rgba(0,194,255,0.15), transparent), rgba(10,10,14,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#f8f9fb',
        fontFamily: '"Inter", system-ui, sans-serif',
        padding: '24px'
    },
    card: {
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16,
        padding: '24px 28px',
        maxWidth: 520,
        width: '100%',
        boxShadow: '0 15px 45px rgba(0,0,0,0.35)',
        backdropFilter: 'blur(14px)'
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12
    },
    badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 999,
        background: 'rgba(255,255,255,0.08)',
        fontSize: 12,
        letterSpacing: 0.3,
        textTransform: 'uppercase'
    },
    clock: {
        fontVariantNumeric: 'tabular-nums',
        fontSize: 24,
        fontWeight: 600
    },
    title: {
        margin: '0 0 8px',
        fontSize: 28,
        lineHeight: 1.2
    },
    subtitle: {
        margin: '0 0 12px',
        color: 'rgba(255,255,255,0.75)',
        lineHeight: 1.5
    },
    reason: {
        margin: '0 0 16px',
        color: 'rgba(255,255,255,0.6)',
        fontSize: 13
    },
    actions: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        marginTop: 12
    },
    button: {
        border: 'none',
        borderRadius: 12,
        padding: '12px 14px',
        fontSize: 15,
        cursor: 'pointer'
    },
    primary: {
        background: 'linear-gradient(135deg, #6c7bff, #19c7ff)',
        color: '#0b0c0f',
        fontWeight: 700
    },
    meta: {
        fontSize: 13,
        color: 'rgba(255,255,255,0.7)'
    },
    error: {
        marginTop: 8,
        fontSize: 13,
        color: '#ff9f9f'
    }
};
