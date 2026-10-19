/**
 * How user attachments reach the model. Images become image parts (data
 * URLs, OpenAI-compatible `image_url`); readable text files are inlined
 * after the message text; anything else is named with a short note. The
 * stored message body is never changed, so this is rebuilt on every turn.
 */

import type { UserContentPart, UserMessage } from '../providers/types.js';
import type { AttachmentRef, MessageRecord } from './types.js';
import { isTextMime } from './artifacts.js';

export const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Largest image sent to the model inline. */
export const MAX_MODEL_IMAGE_BYTES = 20 * 1024 * 1024;
/** Largest text attachment inlined into the message. */
export const MAX_INLINE_TEXT_BYTES = 200 * 1024;
/** Token estimate charged for each image part (providers bill images differently). */
export const IMAGE_TOKEN_ESTIMATE = 1600;

/** Heuristic: no NUL bytes and valid UTF-8 in the first 8 KiB. */
export function looksLikeText(data: Buffer): boolean {
  const head = data.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.length < data.length ? trimPartialUtf8(head) : head);
    return true;
  } catch {
    return false;
  }
}

function trimPartialUtf8(buf: Buffer): Buffer {
  // Drop an incomplete multi-byte sequence at the cut.
  let end = buf.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = buf[end - i]!;
    if ((b & 0xc0) === 0x80) continue;
    if ((b & 0xc0) === 0xc0) end -= i;
    break;
  }
  return buf.subarray(0, end);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Builds the provider user message for a stored user message. */
export function userMessageFor(m: MessageRecord, resolve?: (ref: AttachmentRef) => Buffer | undefined): UserMessage {
  if (!m.attachments?.length) return { role: 'user', content: m.content };
  let text = m.content;
  const images: UserContentPart[] = [];
  for (const a of m.attachments) {
    const data = resolve?.(a);
    const label = `"${a.name}" (${a.mime || 'unknown type'}, ${formatSize(a.size)})`;
    if (!data) {
      text += `\n\n[Attached file ${label} is no longer available.]`;
    } else if (MODEL_IMAGE_TYPES.has(a.mime) && data.length <= MAX_MODEL_IMAGE_BYTES) {
      text += `\n\n[Attached image ${label} follows.]`;
      images.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${data.toString('base64')}` } });
    } else if ((isTextMime(a.mime) || looksLikeText(data)) && data.length <= MAX_INLINE_TEXT_BYTES) {
      text += `\n\n<attachment name="${escapeAttr(a.name)}" type="${escapeAttr(a.mime || 'text/plain')}">\n${data.toString('utf8')}\n</attachment>`;
    } else {
      text += `\n\n[Attached file ${label} is stored, but its content cannot be shown to you${data.length > MAX_INLINE_TEXT_BYTES ? ' (too large to include)' : ' (not text or a supported image)'}.]`;
    }
  }
  return images.length ? { role: 'user', content: [{ type: 'text', text }, ...images] } : { role: 'user', content: text };
}
