import { useEffect, useState } from 'react';

type DailyOnboardingState = {
  completedDay: string | null;
  lastPromptedDay: string | null;
  lastSkippedDay: string | null;
  lastForcedDay?: string | null;
  note: { day: string; message: string; deliveredAt?: string | null; acknowledged?: boolean } | null;
};

type StatusResponse = {
  settings?: {
    idleThreshold?: number;
    continuityWindowSeconds?: number;
    productivityGoalHours?: number;
    emergencyPolicy?: 'off' | 'gentle' | 'balanced' | 'strict';
  };
  dailyOnboarding?: DailyOnboardingState | null;
};

type Props = {
  domain: string;
  status: StatusResponse;
  forced?: boolean;
  onClose(): void;
};

const DAILY_START_HOUR = 4;

function dayKeyFor(date: Date) {
  const local = new Date(date);
  if (local.getHours() < DAILY_START_HOUR) {
    local.setDate(local.getDate() - 1);
  }
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, '0');
  const day = String(local.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default function DailyOnboardingOverlay({ domain, status, forced, onClose }: Props) {
  const dayKey = dayKeyFor(new Date());
  const [goalHours, setGoalHours] = useState(status.settings?.productivityGoalHours ?? 2);
  const [idleThreshold, setIdleThreshold] = useState(status.settings?.idleThreshold ?? 15);
  const [continuityWindow, setContinuityWindow] = useState(status.settings?.continuityWindowSeconds ?? 120);
  const [emergencyPolicy, setEmergencyPolicy] = useState<'off' | 'gentle' | 'balanced' | 'strict'>(status.settings?.emergencyPolicy ?? 'balanced');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const existing = status.dailyOnboarding?.note;
    if (existing && existing.day === dayKey) {
      setNote(existing.message);
    }
  }, [status.dailyOnboarding, dayKey]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'DAILY_ONBOARDING_SAVE',
        payload: {
          dayKey,
          goalHours,
          idleThreshold,
          continuityWindowSeconds: continuityWindow,
          emergencyPolicy,
          note,
          url: window.location.href
        }
      });
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Failed to save');
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'DAILY_ONBOARDING_SKIP',
        payload: {
          dayKey,
          note,
          url: window.location.href
        }
      });
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Failed to save');
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tws-daily-overlay">
      <div className="tws-daily-card">
        <div className="tws-daily-header">
          <div className="tws-daily-hero">
            <div className="tws-daily-orb" aria-hidden />
            <div>
              <span className="tws-eyebrow">Daily check-in</span>
              <h2>Quick daily setup</h2>
              <p className="tws-subtle">You are on {domain}. Set a light plan, then keep moving.</p>
            </div>
          </div>
          {forced && <div className="tws-daily-pill">One quick check before you continue.</div>}
        </div>

        <div className="tws-daily-panels">
          <div className="tws-daily-panel">
            <h3>Set your day</h3>
            <div className="tws-daily-grid">
              <label>
                Productivity goal (hours)
                <input
                  type="number"
                  min="0.5"
                  max="12"
                  step="0.1"
                  value={goalHours}
                  onChange={(e) => setGoalHours(Number(e.target.value))}
                />
              </label>
              <label>
                Idle threshold (seconds)
                <input
                  type="number"
                  min="5"
                  max="300"
                  value={idleThreshold}
                  onChange={(e) => setIdleThreshold(Number(e.target.value))}
                />
              </label>
              <label>
                Continuity window (seconds)
                <input
                  type="number"
                  min="0"
                  max="900"
                  value={continuityWindow}
                  onChange={(e) => setContinuityWindow(Number(e.target.value))}
                />
              </label>
              <label>
                Emergency policy
                <select value={emergencyPolicy} onChange={(e) => setEmergencyPolicy(e.target.value as any)}>
                  <option value="off">Off</option>
                  <option value="gentle">Gentle</option>
                  <option value="balanced">Balanced</option>
                  <option value="strict">Strict</option>
                </select>
              </label>
            </div>
          </div>

          <div className="tws-daily-panel">
            <h3>Note for end-of-day you</h3>
            <label className="tws-daily-note">
              <textarea
                rows={4}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Write something kind, firm, or honest. We'll bring it back later."
              />
            </label>
          </div>
        </div>

        {error && <p className="tws-error-text">{error}</p>}

        <div className="tws-daily-actions">
          <button type="button" className="tws-ghost" onClick={handleSkip} disabled={saving}>
            Skip today
          </button>
          <button type="button" className="tws-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Set my day'}
          </button>
        </div>
      </div>
    </div>
  );
}
