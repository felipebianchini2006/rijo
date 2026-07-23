import { totalSize } from './fsx.js';

export interface BudgetReport {
  bytes: number;
  budget: number;
  withinBudget: boolean;
  files: string[];
}

/**
 * The automatically loaded context set for a normal execution must stay under
 * the configured budget (24 KB by default). Exceeding it requires a recorded
 * justification in DECISIONS.md — the caller enforces that; this only measures.
 */
export function checkContextBudget(files: string[], budgetBytes: number): BudgetReport {
  const bytes = totalSize(files);
  return { bytes, budget: budgetBytes, withinBudget: bytes <= budgetBytes, files };
}
