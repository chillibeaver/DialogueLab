import { DurableObject } from "cloudflare:workers";

import { grant, refund, spentMicros, type BudgetLedger, type BudgetLimits, type Cost, type Usage } from "../server/budget";

/**
 * The site's monthly spending ledger (see server/budget.ts). There is one
 * instance, and a Durable Object handles one call at a time: storage reads
 * and writes hold back the next call until they finish, so two requests can
 * never both see room for the last dollar.
 *
 * The limits come with every call rather than being stored here, so a new
 * MONTHLY_BUDGET_USD applies from the next request after it is deployed.
 */
export class MonthlyBudget extends DurableObject implements BudgetLedger {
  async reserve(month: string, costs: Cost[], limits: BudgetLimits): Promise<{ granted: number; spentMicros: number }> {
    const key = `usage:${month}`;
    const usage = (await this.ctx.storage.get<Usage>(key)) ?? { chirpChars: 0, geminiMicros: 0 };
    const result = grant(usage, costs, limits);
    if (result.granted) await this.ctx.storage.put(key, result.usage);
    return { granted: result.granted, spentMicros: spentMicros(result.usage, limits) };
  }

  async refund(month: string, costs: Cost[]): Promise<void> {
    const key = `usage:${month}`;
    const usage = await this.ctx.storage.get<Usage>(key);
    if (usage) await this.ctx.storage.put(key, refund(usage, costs));
  }
}
