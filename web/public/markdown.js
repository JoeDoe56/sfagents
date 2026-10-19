/**
 * A small, safe Markdown renderer for chat bubbles and the artifact viewer.
 * Input is escaped first; only the constructs below produce markup:
 * fenced code, headings, block quotes, lists, tables, rules, paragraphs,
 * inline code, bold, italic, strikethrough and http(s)/mailto links.
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ESC[c]);
}

function safeUrl(url) {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

function inline(text) {
  // Split out inline code first so its content stays literal.
  const parts = text.split(/(`+)([\s\S]*?[^`])\1(?!`)/);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) out += spans(escapeHtml(parts[i]));
    else if (i % 3 === 2) out += `<code>${escapeHtml(parts[i].trim() ? parts[i].replace(/^ (.*) $/, '$1') : parts[i])}</code>`;
  }
  return out;
}

function spans(html) {
  return html
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const url = safeUrl(href.replace(/&amp;/g, '&'));
      return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
    })
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+[^\s<.,:;!?)\]'"])/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** Renders Markdown to HTML. */
export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(4, heading[1].length);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i]);
        if (m && /\d/.test(m[2]) === ordered && m[1].length <= item[1].length + 1) {
          items.push([m[3]]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1].push(lines[i].trim());
          i++;
        } else break;
      }
      const start = ordered ? parseInt(item[2], 10) : 1;
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.map((it) => `<li>${inline(it.join('\n')).replace(/\n/g, '<br>')}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out.join('');
}

/** True when the text uses Markdown that renders differently from plain text. */
export function looksLikeMarkdown(text) {
  return /(^|\n)\s*(```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|.*\|)|\*\*|`[^`]+`|\[[^\]]+\]\(/.test(text);
}
