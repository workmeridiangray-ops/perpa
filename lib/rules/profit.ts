import { divRound } from "./money";

export type Financials = {
  estimated_revenue_paise: number; estimated_cost_paise: number; committed_open_paise: number;
  actual_labour_paise: number; actual_expense_paise: number; actual_supplier_paise: number;
  invoiced_paise: number; collected_paise: number;
};

/** Actual cost = approved labour + approved expenses + supplier bills received. Committed-but-unbilled is reported separately, never folded into actual. */
export function summarize(f: Financials) {
  const actualCost = f.actual_labour_paise + f.actual_expense_paise + f.actual_supplier_paise;
  const forecastCost = actualCost + f.committed_open_paise;
  const margin = (rev: number, cost: number) => (rev === 0 ? null : divRound((rev - cost) * 10_000, rev));
  return {
    actualCost, forecastCost,
    estimatedMarginBps: margin(f.estimated_revenue_paise, f.estimated_cost_paise),
    // Margin on what has been invoiced (billed view), using actual cost to date.
    billedMarginBps: margin(f.invoiced_paise, actualCost),
    forecastMarginBps: margin(f.estimated_revenue_paise, forecastCost),
    unbilled: Math.max(0, f.estimated_revenue_paise - f.invoiced_paise),
    outstanding: f.invoiced_paise - f.collected_paise,
  };
}
