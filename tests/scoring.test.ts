import { describe, expect, it } from 'vitest';
import { calculateScore } from '../src/backend/scoring';
import type { Budget } from '@shared/types';

const sampleIntentions = [
  { id: 1, date: '2024-05-01', text: 'Ship feature', completed: true },
  { id: 2, date: '2024-05-01', text: 'Inbox zero', completed: false }
];

const sampleBudgets: Budget[] = [
  { id: 1, period: 'day', category: 'Social', secondsBudgeted: 3600 }
];

describe('calculateScore', () => {
  it('rewards deep work and completed intentions', () => {
    const result = calculateScore({
      focusMinutes: 190,
      deepWorkTargetMinutes: 180,
      intentions: sampleIntentions,
      budgets: sampleBudgets,
      frivolousSecondsSpent: 1800
    });

    expect(result.total).toBeGreaterThan(70);
    expect(result.focusScore).toBeGreaterThan(result.intentionScore);
    expect(result.grade === 'A' || result.grade === 'B').toBe(true);
  });

  it('penalises over-budget frivolity', () => {
    const result = calculateScore({
      focusMinutes: 60,
      intentions: [],
      budgets: sampleBudgets,
      frivolousSecondsSpent: 7200
    });

    expect(result.budgetScore).toBeLessThan(10);
    expect(result.total).toBeLessThan(60);
    expect(['C', 'D', 'F']).toContain(result.grade);
  });
});
