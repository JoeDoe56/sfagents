/**
 * Terminal cell widths, for laying out the full-screen interface: wide
 * characters (CJK, most emoji) take two cells, combining marks none.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function isZero(cp: number): boolean {
  return (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x20e3 ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    (cp >= 0xe0020 && cp <= 0xe007f)
  );
}

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isZero(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Cells the text takes (ANSI styling takes none). */
export function textWidth(text: string): number {
  let w = 0;
  for (const ch of stripAnsi(text)) w += charWidth(ch);
  return w;
}

/** Cuts plain text to at most `width` cells, with an ellipsis when it was cut. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (textWidth(text) <= width) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** Cuts styled text to `width` cells, keeping its styling codes, and resets styling at the end. */
export function fit(text: string, width: number): string {
  let out = '';
  let w = 0;
  let i = 0;
  let cut = false;
  while (i < text.length) {
    if (text[i] === '\u001b') {
      const m = /^\u001b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const cw = charWidth(ch);
    if (w + cw > width) {
      cut = true;
      break;
    }
    out += ch;
    w += cw;
    i += ch.length;
  }
  return cut || out.includes('\u001b') ? `${out}\u001b[0m` : out;
}

/** Wraps plain text to `width` cells per line, at spaces where it can. Keeps the text's own line breaks. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  const max = Math.max(4, width);
  for (const para of text.split('\n')) {
    if (!para) {
      out.push('');
      continue;
    }
    let line = '';
    let lineW = 0;
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const ww = textWidth(word);
      if (lineW + ww <= max) {
        line += word;
        lineW += ww;
        continue;
      }
      if (/^\s+$/.test(word)) {
        out.push(line);
        line = '';
        lineW = 0;
        continue;
      }
      if (line.trim()) out.push(line.replace(/\s+$/, ''));
      line = '';
      lineW = 0;
      // A word longer than the line is broken where it must be.
      for (const ch of word) {
        const cw = charWidth(ch);
        if (lineW + cw > max) {
          out.push(line);
          line = '';
          lineW = 0;
        }
        line += ch;
        lineW += cw;
      }
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}
