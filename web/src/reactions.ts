/**
 * Reactions: one emoji per message, added from the chat (double-tap or
 * hold → Add Reaction). They are for the reader only, so they live beside
 * the conversation (web-reactions.json) rather than in it.
 */

import fs from 'node:fs';
import path from 'node:path';

/** At most a short emoji sequence (flags, skin tones and ZWJ families fit). */
const MAX_EMOJI_LENGTH = 32;

export function isEmoji(value: string): boolean {
  if (!value || value.length > MAX_EMOJI_LENGTH) return false;
  const keycapsOut = value.replace(/[#*0-9]️?⃣/gu, '⬛');
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(keycapsOut) && !/[\p{L}\p{N}\s]/u.test(keycapsOut);
}

export class ReactionStore {
  private readonly file: string;
  private value: Record<string, string> = {};

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'web-reactions.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && isEmoji(v)) this.value[k] = v;
    } catch {
      // none saved yet
    }
  }

  all(): Record<string, string> {
    return { ...this.value };
  }

  /** Sets (or with null, removes) the reaction on message `id`. */
  set(id: string, emoji: string | null): Record<string, string> {
    if (emoji) this.value[id] = emoji;
    else delete this.value[id];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    fs.renameSync(tmp, this.file);
    return this.all();
  }
}
