/**
 * A small markdown parser for the web app (Track 4, U2). It produces plain data that the React
 * view turns into elements, so model output never becomes HTML: there is nothing to sanitize
 * and no way for a reply to inject markup. Remote images are never loaded (a prompt-injected
 * reply could leak data through an image URL); they show as a link instead. Links are kept
 * only for http, https and mailto.
 *
 * Covers what replies use: headings, paragraphs, fenced code, inline code, bold, italic,
 * strikethrough, links, lists (with nesting by indent), quotes, tables, rules.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'break' };

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | {
      type: 'list';
      ordered: boolean;
      start: number;
      items: Array<{ level: number; children: Inline[] }>;
    }
  | { type: 'quote'; children: Block[] }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' };

/** Only these link schemes survive; anything else (javascript:, data:, file:) becomes text. */
export function safeHref(href: string): string | undefined {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : undefined;
}

const INLINE = new RegExp(
  [
    '(`+)([\\s\\S]*?[^`])\\1(?!`)', // 1,2 code
    '!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)', // 3,4 image (never loaded)
    '\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)', // 5,6 link
    '\\*\\*([\\s\\S]+?)\\*\\*', // 7 strong
    '__([\\s\\S]+?)__', // 8 strong
    '~~([\\s\\S]+?)~~', // 9 del
    '\\*([^*\\s][^*]*?)\\*', // 10 em
    '(?<![\\w])_([^_\\s][^_]*?)_(?![\\w])', // 11 em
    '(https?://[^\\s<>()]+[^\\s<>().,;:!?\'"])', // 12 bare URL
    '( {2,}|\\\\)\\n', // 13 hard break
  ].join('|'),
  'g',
);

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const pushText = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev?.type === 'text') prev.text += t;
    else out.push({ type: 'text', text: t });
  };
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0;
    pushText(text.slice(last, index));
    last = index + m[0].length;
    if (m[2] !== undefined) out.push({ type: 'code', text: m[2].replace(/^ (.*) $/, '$1') });
    else if (m[4] !== undefined) {
      const href = safeHref(m[4]);
      const label = `image: ${m[3] || m[4]}`;
      out.push(
        href
          ? { type: 'link', href, children: [{ type: 'text', text: label }] }
          : { type: 'text', text: label },
      );
    } else if (m[6] !== undefined) {
      const href = safeHref(m[6]);
      const children = parseInline(m[5] ?? '');
      if (href) out.push({ type: 'link', href, children });
      else out.push(...children);
    } else if (m[7] !== undefined || m[8] !== undefined) {
      out.push({ type: 'strong', children: parseInline(m[7] ?? m[8] ?? '') });
    } else if (m[9] !== undefined) out.push({ type: 'del', children: parseInline(m[9]) });
    else if (m[10] !== undefined || m[11] !== undefined) {
      out.push({ type: 'em', children: parseInline(m[10] ?? m[11] ?? '') });
    } else if (m[12] !== undefined) {
      out.push({ type: 'link', href: m[12], children: [{ type: 'text', text: m[12] }] });
    } else out.push({ type: 'break' });
  }
  pushText(text.slice(last));
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (line: string, next?: string) =>
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    ITEM.test(line) ||
    QUOTE.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEP.test(next));

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker))
        body.push(lines[i++] ?? '');
      i++; // the closing fence (or the end)
      blocks.push({ type: 'code', lang: (fence[2] ?? '').toLowerCase(), text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]?.length ?? 1,
        children: parseInline(heading[2] ?? ''),
      });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const header = cells(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        rows.push(cells(lines[i] ?? '').map(parseInline));
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? ''))
        body.push(QUOTE.exec(lines[i++] ?? '')?.[1] ?? '');
      blocks.push({ type: 'quote', children: parseMarkdown(body.join('\n')) });
      continue;
    }
    const first = ITEM.exec(line);
    if (first) {
      const ordered = first[3] !== undefined;
      const base = first[1]?.length ?? 0;
      const items: Array<{ level: number; children: Inline[] }> = [];
      let current: { level: number; text: string } | undefined;
      const close = () => {
        if (current) items.push({ level: current.level, children: parseInline(current.text) });
      };
      while (i < lines.length) {
        const l = lines[i] ?? '';
        const m = ITEM.exec(l);
        // A top-level item of the other kind (bullets vs numbers) starts a new list.
        if (m && (m[1]?.length ?? 0) <= base && (m[3] !== undefined) !== ordered) break;
        if (m) {
          close();
          current = {
            level: Math.max(0, Math.floor(((m[1]?.length ?? 0) - base) / 2)),
            text: m[4] ?? '',
          };
          i++;
        } else if (l.trim() && /^\s+/.test(l) && current) {
          current.text += `\n${l.trim()}`;
          i++;
        } else break;
      }
      close();
      blocks.push({ type: 'list', ordered, start: ordered ? Number(first[3]) : 1, items });
      continue;
    }
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      !startsBlock(lines[i] ?? '', lines[i + 1])
    ) {
      para.push(lines[i++] ?? '');
    }
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
  }
  return blocks;
}
