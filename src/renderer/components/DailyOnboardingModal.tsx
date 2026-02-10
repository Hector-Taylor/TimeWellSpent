import { useMemo, useState, useEffect } from 'react';
import type { EmergencyPolicyId } from '@shared/types';

const GREETINGS = [
  'Hello beautiful.',
  'Good morning, bright mind.',
  'Hey superstar.',
  'Hello again, steady heart.',
  'Welcome back, focus machine.'
];

const TAGLINES = [
  'Set the tone. The day follows.',
  'Small levers, huge outcomes.',
  'One clear choice beats a thousand edits.',
  'Pick your rules before the feed does.',
  'Today is made in small agreements.'
];

function hashString(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function pickPhrase(list: string[], seed: string) {
  if (!list.length) return '';
  const idx = hashString(seed) % list.length;
  return list[idx];
}

type DailyOnboardingValues = {
  goalHours: number;
  idleThreshold: number;
  continuityWindowSeconds: number;
  emergencyPolicy: EmergencyPolicyId;
  note: string;
};

type DailyOnboardingModalProps = {
  open: boolean;
  dayKey: string;
  initial: DailyOnboardingValues;
  saving?: boolean;
  error?: string | null;
  onSave(values: DailyOnboardingValues): void;
  onSkip(values: Pick<DailyOnboardingValues, 'note'>): void;
};

export function DailyOnboardingModal({ open, dayKey, initial, saving, error, onSave, onSkip }: DailyOnboardingModalProps) {
  const [goalHours, setGoalHours] = useState(initial.goalHours);
  const [idleThreshold, setIdleThreshold] = useState(initial.idleThreshold);
  const [continuityWindowSeconds, setContinuityWindowSeconds] = useState(initial.continuityWindowSeconds);
  const [emergencyPolicy, setEmergencyPolicy] = useState<EmergencyPolicyId>(initial.emergencyPolicy);
  const [note, setNote] = useState(initial.note);

  useEffect(() => {
    if (!open) return;
    setGoalHours(initial.goalHours);
    setIdleThreshold(initial.idleThreshold);
    setContinuityWindowSeconds(initial.continuityWindowSeconds);
    setEmergencyPolicy(initial.emergencyPolicy);
    setNote(initial.note);
  }, [open, initial]);

  const greeting = useMemo(() => pickPhrase(GREETINGS, dayKey), [dayKey]);
  const tagline = useMemo(() => pickPhrase(TAGLINES, dayKey + 'tag'), [dayKey]);

  if (!open) return null;

  return (
    <div className="daily-onboarding-overlay" role="dialog" aria-modal="true">
      <div className="daily-onboarding-card">
        <div className="daily-onboarding-header">
          <div className="daily-onboarding-hero">
            <div className="daily-onboarding-orb" aria-hidden />
            <div>
              <p className="eyebrow">Daily landing</p>
              <h2>{greeting}</h2>
              <p className="subtle">{tagline}</p>
            </div>
          </div>
          <div className="daily-onboarding-meta">
            <span className="pill ghost">Morning tuning</span>
            <span className="pill ghost">One screen</span>
          </div>
        </div>

        <div className="daily-onboarding-panels">
          <div className="daily-onboarding-panel">
            <h3>Set your day</h3>
            <div className="daily-onboarding-grid">
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
                  value={continuityWindowSeconds}
                  onChange={(e) => setContinuityWindowSeconds(Number(e.target.value))}
                />
              </label>
              <label>
                Emergency policy
                <select value={emergencyPolicy} onChange={(e) => setEmergencyPolicy(e.target.value as EmergencyPolicyId)}>
                  <option value="off">Off</option>
                  <option value="gentle">Gentle</option>
                  <option value="balanced">Balanced</option>
                  <option value="strict">Strict</option>
                </select>
              </label>
            </div>
          </div>

          <div className="daily-onboarding-panel">
            <h3>Note for end-of-day you</h3>
            <label className="daily-onboarding-note">
              <textarea
                rows={4}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Write something kind, firm, or honest. We'll bring it back later."
              />
            </label>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="daily-onboarding-actions">
          <button type="button" className="ghost" onClick={() => onSkip({ note })} disabled={saving}>
            Not now
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onSave({ goalHours, idleThreshold, continuityWindowSeconds, emergencyPolicy, note })}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Set my day'}
          </button>
        </div>
      </div>
    </div>
  );
}

type DailyNoteModalProps = {
  open: boolean;
  note: string;
  onClose(): void;
};

export function DailyNoteModal({ open, note, onClose }: DailyNoteModalProps) {
  if (!open) return null;
  return (
    <div className="daily-onboarding-overlay" role="dialog" aria-modal="true">
      <div className="daily-onboarding-card daily-note-card">
        <div className="daily-onboarding-header">
          <p className="eyebrow">End-of-day note</p>
          <h2>For you, from you.</h2>
        </div>
        <div className="daily-note-body">
          <p>{note}</p>
        </div>
        <div className="daily-onboarding-actions">
          <button type="button" className="primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
