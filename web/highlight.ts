/**
 * A small code highlighter for the web app (Track 4, U2): comments, strings, numbers and
 * keywords, for the languages replies mostly use. It returns tokens, never HTML, so the view
 * renders them as text in spans. Unknown languages come back as one plain token.
 */

export type TokenType = 'plain' | 'keyword' | 'string' | 'comment' | 'number';
export interface Token {
  type: TokenType;
  text: string;
}

interface Lang {
  line?: string[];
  block?: Array<[string, string]>;
  strings: string[];
  keywords: Set<string>;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const JS = words(`
  async await break case catch class const continue debugger default delete do else enum export
  extends false finally for from function if implements import in instanceof interface let new
  null of private protected public readonly return static super switch this throw true try type
  typeof undefined var void while with yield as satisfies keyof declare namespace abstract`);
const PY = words(`
  and as assert async await break class continue def del elif else except False finally for from
  global if import in is lambda None nonlocal not or pass raise return True try while with yield
  match case self`);
const SH = words(`
  if then else elif fi for while until do done case esac in function return local export echo
  exit set unset shift source cd`);
const RUST = words(`
  as async await break const continue crate else enum extern false fn for if impl in let loop
  match mod move mut pub ref return self Self static struct super trait true type unsafe use where
  while dyn`);
const GO = words(`
  break case chan const continue default defer else fallthrough for func go goto if import
  interface map package range return select struct switch type var true false nil`);
const SQL = words(`
  select from where and or not insert into values update set delete create table index drop alter
  join left right inner outer on group by order having limit as distinct null is in like`);
const CSS = words('important inherit initial unset none auto');

const C_COMMENTS = { line: ['//'], block: [['/*', '*/']] as Array<[string, string]> };

const LANGS: Record<string, Lang> = {
  js: { ...C_COMMENTS, strings: ['"', "'", '`'], keywords: JS },
  py: { line: ['#'], strings: ['"', "'"], keywords: PY },
  sh: { line: ['#'], strings: ['"', "'"], keywords: SH },
  rust: { ...C_COMMENTS, strings: ['"'], keywords: RUST },
  go: { ...C_COMMENTS, strings: ['"', '`'], keywords: GO },
  sql: { line: ['--'], strings: ["'"], keywords: SQL },
  css: { block: [['/*', '*/']], strings: ['"', "'"], keywords: CSS },
  json: { strings: ['"'], keywords: words('true false null') },
  yaml: { line: ['#'], strings: ['"', "'"], keywords: words('true false null yes no') },
  html: { block: [['<!--', '-->']], strings: ['"', "'"], keywords: new Set() },
};

const ALIASES: Record<string, string> = {
  javascript: 'js',
  jsx: 'js',
  ts: 'js',
  tsx: 'js',
  typescript: 'js',
  mjs: 'js',
  java: 'js',
  c: 'js',
  cpp: 'js',
  'c++': 'js',
  cs: 'js',
  csharp: 'js',
  swift: 'js',
  kotlin: 'js',
  python: 'py',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  console: 'sh',
  rs: 'rust',
  golang: 'go',
  scss: 'css',
  jsonc: 'json',
  yml: 'yaml',
  toml: 'yaml',
  xml: 'html',
  svg: 'html',
  markdown: 'html',
};

export function langOf(name: string): Lang | undefined {
  const key = name.toLowerCase();
  return LANGS[key] ?? LANGS[ALIASES[key] ?? ''];
}

export function highlight(code: string, langName: string): Token[] {
  const lang = langOf(langName);
  if (!lang) return [{ type: 'plain', text: code }];
  const out: Token[] = [];
  const add = (type: TokenType, text: string) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && prev.type === type) prev.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let plain = '';
  const flushPlain = () => {
    // Split plain text into words so keywords and numbers stand out.
    for (const part of plain.split(/(\b[A-Za-z_$][\w$]*\b|\b\d[\d_.xXa-fA-F]*\b)/)) {
      if (!part) continue;
      if (lang.keywords.has(part)) add('keyword', part);
      else if (/^\d/.test(part)) add('number', part);
      else add('plain', part);
    }
    plain = '';
  };
  while (i < code.length) {
    const rest = code.slice(i);
    const line = lang.line?.find((l) => rest.startsWith(l));
    if (line) {
      flushPlain();
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      add('comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    const block = lang.block?.find(([open]) => rest.startsWith(open));
    if (block) {
      flushPlain();
      const end = code.indexOf(block[1], i + block[0].length);
      const stop = end === -1 ? code.length : end + block[1].length;
      add('comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    const quote = lang.strings.find((q) => rest.startsWith(q));
    if (quote) {
      flushPlain();
      let j = i + 1;
      while (j < code.length && code[j] !== quote) {
        if (code[j] === '\\') j++;
        if (code[j] === '\n' && quote !== '`') break;
        j++;
      }
      add('string', code.slice(i, Math.min(j + 1, code.length)));
      i = j + 1;
      continue;
    }
    plain += code[i];
    i++;
  }
  flushPlain();
  return out;
}
