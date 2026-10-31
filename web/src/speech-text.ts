/**
 * Text as Qwen3-TTS should read it: a reply's Markdown, HTML, links, code,
 * tables, emoji and symbols turned into plain sentences, by rules (no model
 * rewrites it). A model that reads "**Note:**" or a URL character by
 * character, or stumbles over a table or an emoji, says nothing useful.
 *
 *   - code blocks are not read: "Code omitted." stands for each;
 *   - inline code, emphasis, strikethrough and headings keep their words;
 *     a heading, a list item, a table row and a paragraph each end a sentence;
 *   - links and images become their text; a bare address, its site name;
 *   - HTML tags go, entities become their characters;
 *   - emoji and stray Markdown characters go; symbols that have a word are
 *     said with it (≥ "at least", → "to", & "and", …).
 */

/** Symbols read as words. */
const WORDS: Array<[RegExp, string]> = [
  // A range ("3–4 s"), not a date or a version (2026-10-30, 1.2-3).
  [/(?<![\d.\-–])(\d+)\s*[-–—]\s*(\d+)(?![\d.\-–])/g, '$1 to $2'],
  [/(\d)\s*\*\s*(?=\d)/g, '$1 times '],
  [/(\d)x\b/g, '$1 times'],
  [/\s*(?:->|→|⟶|=>|⇒)\s*/g, ' to '],
  [/\s*(?:<-|←|⟵|<=(?!\d)|⇐)\s*/g, ' from '],
  [/\s*(?:<->|↔|⇔)\s*/g, ' and '],
  [/\s*≥\s*|\s*>=\s*/g, ' at least '],
  [/\s*≤\s*|\s*<=\s*/g, ' at most '],
  [/\s*≈\s*|\s*~(?=\d)/g, ' about '],
  [/\s*≠\s*|\s*!=\s*/g, ' is not '],
  [/(\d)\s*[×x]\s*(?=\d)/g, '$1 by '],
  [/\s*×\s*/g, ' times '],
  [/\s*±\s*/g, ' plus or minus '],
  [/\s+&\s+|&(?=\s)/g, ' and '],
  [/(\w)\s*={1,3}\s*(?=\w)/g, '$1 equals '],
  [/\s*[—–]\s*/g, ', '],
  [/(^|\s)#(\d+)/g, '$1number $2'],
  [/\s*\.\.\.\s*/g, '… '],
];

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', deg: '°' };

/** A sentence's end: the line gets a full stop unless it has its own. */
function end(line: string): string {
  const t = line.trim();
  if (!t) return '';
  return /[.!?…:;,]$/.test(t) ? t : `${t}.`;
}

/** A link's site, as a person says it: "github.com". */
function site(url: string): string {
  try {
    return new URL(url.startsWith('www.') ? `https://${url}` : url).hostname.replace(/^www\./, '');
  } catch {
    return 'a link';
  }
}

export function speechText(input: string): string {
  let s = input.replace(/\r\n?/g, '\n');
  // Code blocks (fenced, and HTML <pre>) are not read.
  s = s.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[ \t]*(?=\n|$)|(?![\s\S]))/gm, '\nCode omitted.\n');
  s = s.replace(/<pre[\s\S]*?<\/pre>/gi, '\nCode omitted.\n');
  // <address> links, before the HTML tags they look like.
  s = s.replace(/<((?:https?|ftp):\/\/[^>\s]+)>/g, (_m, u: string) => site(u));
  // HTML: line breaks and blocks end lines; other tags go; entities become characters.
  s = s.replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n');
  s = s.replace(/<\/?[a-z][^>]*>/gi, '');
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  // Images and links: their words. Bare and <angle> addresses: their site.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  s = s.replace(/^\s*\[(?!\^)[^\]]+\]:\s*\S+.*$/gm, ''); // link definitions (not footnotes)
  s = s.replace(/\b(?:(?:https?|ftp):\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]/g, (u) => site(u));
  s = s.replace(/<([^@\s>]+@[^>\s]+)>/g, '$1');
  // Footnote marks, task boxes.
  s = s.replace(/\[\^[^\]]+\]:?/g, '');
  s = s.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]\s+/gm, '$1');
  // Inline code: its text.
  s = s.replace(/`+([^`\n]+?)`+/g, '$1');

  // Line by line: headings, quotes, lists, tables and rules.
  const lines: string[] = [];
  for (let line of s.split('\n')) {
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) continue; // a rule
    if (/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue; // a table's header line
    if (/^\s*(?:=+|-+)\s*$/.test(line)) continue; // a heading's underline
    line = line.replace(/^\s*(?:>\s?)+/, ''); // quotes
    line = line.replace(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/, '$1'); // headings
    line = line.replace(/^\s*(?:[-*+•◦▪‣]|\d+[.)])\s+/, ''); // list items
    if (/\|/.test(line) && /\S\s*\|\s*\S/.test(line)) {
      // a table row: its cells, in a sentence
      line = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()).filter(Boolean).join(', ');
    }
    lines.push(end(line));
  }
  s = lines.filter(Boolean).join(' ');

  // Emphasis and strikethrough: their words (not snake_case or 2*3).
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2');
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');

  // Emoji and pictographs, with their joiners and variation selectors.
  s = s.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}‍︎️⃣]/gu, '');
  for (const [re, word] of WORDS) s = s.replace(re, word);
  // What is left of Markdown and other characters with no sound.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1');
  s = s.replace(/[*_`~^|<>{}[\]\\#=•◦▪‣]+/g, ' ');
  // Repeated punctuation, and punctuation alone.
  s = s.replace(/([!?])\1+/g, '$1').replace(/\.{2,}/g, '…').replace(/([,;:])\1+/g, '$1');
  s = s.replace(/\s+([.,;:!?…])/g, '$1');
  s = s.replace(/([.,;:!?])(?:\s*[.,;:])+/g, '$1');
  s = s.replace(/\(\s*\)/g, '');
  return s.replace(/\s+/g, ' ').replace(/^[\s.,;:!?]+/, '').trim();
}
