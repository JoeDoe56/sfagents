/**
 * How much context each model takes (its native window), for the agent
 * editor's context bar. Providers report it as they reply (Claude's result,
 * Codex's token usage); model lists give it for OpenRouter and other
 * OpenAI-compatible servers. What was reported is remembered on this computer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sfagentsHome, writeFileAtomic } from '../settings/home.js';

/** Where the context bar stops: decimal thousands, 32k to 1m. */
export const CONTEXT_STOPS: readonly number[] = [32_000, 64_000, 100_000, 128_000, 200_000, 256_000, 400_000, 500_000, 1_000_000];

let cache: Record<string, number> | undefined;

function file(): string {
  return path.join(sfagentsHome(), 'model-windows.json');
}

function load(): Record<string, number> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, unknown>;
    cache = Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0));
  } catch {
    cache = {};
  }
  return cache;
}

const key = (kind: string, model: string) => `${kind}\u0000${model}`;

/** A window a provider reported for a model (kept for the next time). */
export function rememberContextWindow(kind: string, model: string, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const all = load();
  if (all[key(kind, model)] === tokens) return;
  all[key(kind, model)] = Math.round(tokens);
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    writeFileAtomic(file(), JSON.stringify(all, null, 2));
  } catch {
    // only a convenience
  }
}

export function rememberedContextWindow(kind: string, model: string): number | undefined {
  return load()[key(kind, model)];
}

/** What is known without asking: a reported window, else the model's name. */
export function knownContextWindow(kind: string, model: string): number | undefined {
  const seen = rememberedContextWindow(kind, model);
  if (seen) return seen;
  if (/\[1m\]$/i.test(model)) return 1_000_000;
  if (kind === 'anthropic' || /^(anthropic\/)?claude/i.test(model)) return 200_000;
  return undefined;
}

/** The stops the bar offers for a model: up to its window, which is a stop itself. */
export function contextStops(native?: number | null): number[] {
  if (!native) return [...CONTEXT_STOPS];
  const stops = CONTEXT_STOPS.filter((s) => s < native);
  stops.push(native);
  return stops;
}

/** 256000 → "256k", 1000000 → "1m" (decimal, as the bar shows them). */
export function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(2)}m`;
  if (tokens >= 1000) return `${+(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}
