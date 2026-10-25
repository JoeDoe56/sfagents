/**
 * Plan usage: how much of a subscription's 5-hour and weekly windows the
 * signed-in account has used, for the agent sheet's usage bar. Codex reports
 * it on request and after each response; Claude reports it in the SDK's
 * rate-limit events during a request. Kept in memory, by provider id.
 */

export interface UsageWindow {
  /** 0–100. */
  usedPercent: number;
  /** When the window resets (ms since the epoch), if known. */
  resetsAt?: number;
  windowMinutes?: number;
}

export interface PlanUsage {
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  /** The plan's name as the provider reports it ("plus", "pro", "max"…). */
  plan?: string;
  /** The provider said the account is at a limit now. */
  limitReached?: boolean;
  /** When this was reported (ms since the epoch). */
  updated: number;
}

/** A percentage from a 0–1 fraction or a 0–100 value. */
export function toPercent(value: number, fraction: boolean): number {
  const p = fraction ? value * 100 : value;
  return Math.max(0, Math.min(100, p));
}

/** Seconds or milliseconds since the epoch to milliseconds. */
export function toEpochMs(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

export class PlanUsageStore {
  private readonly values = new Map<string, PlanUsage>();
  private readonly listeners = new Set<(provider: string, usage: PlanUsage) => void>();

  /** By provider id. A window past its reset time shows as unused. */
  get(provider: string): PlanUsage | undefined {
    const v = this.values.get(provider);
    if (!v) return undefined;
    const now = Date.now();
    const fresh = (w?: UsageWindow) => (w?.resetsAt && w.resetsAt <= now ? { ...w, usedPercent: 0, resetsAt: undefined } : w);
    return { ...v, fiveHour: fresh(v.fiveHour), weekly: fresh(v.weekly) };
  }

  /** Merges a report: windows it leaves out keep their last values. */
  update(provider: string, report: Partial<PlanUsage>): PlanUsage {
    const key = provider;
    const prev = this.values.get(key);
    const next: PlanUsage = {
      ...prev,
      ...Object.fromEntries(Object.entries(report).filter(([, v]) => v !== undefined)),
      updated: report.updated ?? Date.now(),
    };
    this.values.set(key, next);
    for (const l of this.listeners) l(provider, this.get(provider)!);
    return next;
  }

  onChange(listener: (provider: string, usage: PlanUsage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
