import type { Budget, Intention } from '@shared/types';

export type ScoreInputs = {
  focusMinutes: number;
  deepWorkTargetMinutes?: number;
  intentions: Intention[];
  budgets: Budget[];
  frivolousSecondsSpent: number;
};

export type ScoreBreakdown = {
  total: number;
  focusScore: number;
  intentionScore: number;
  budgetScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function calculateScore(inputs: ScoreInputs): ScoreBreakdown {
  const target = inputs.deepWorkTargetMinutes ?? 180;
  const focusRatio = clamp(inputs.focusMinutes / target, 0, 1.5);
  const focusScore = clamp(focusRatio * 60, 0, 60);

  const totalIntentions = inputs.intentions.length;
  const completedIntentions = inputs.intentions.filter((item) => item.completed).length;
  const intentionScore = totalIntentions === 0 ? 10 : clamp((completedIntentions / totalIntentions) * 25, 0, 25);

  const totalBudgetSeconds = inputs.budgets.reduce((sum, budget) => sum + budget.secondsBudgeted, 0);
  const budgetRatio = totalBudgetSeconds === 0 ? 1 : clamp(1 - inputs.frivolousSecondsSpent / totalBudgetSeconds, 0, 1.2);
  const budgetScore = clamp(budgetRatio * 15, 0, 15);

  const total = Math.round(focusScore + intentionScore + budgetScore);
  const grade = total >= 85 ? 'A' : total >= 70 ? 'B' : total >= 55 ? 'C' : total >= 40 ? 'D' : 'F';

  return { total, focusScore, intentionScore, budgetScore, grade };
}
