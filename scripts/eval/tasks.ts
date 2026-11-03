/**
 * The eval task set (L3): ten small repo tasks covering read, edit, write, search, bash and a
 * multi-step fix. Each task is a fixture workspace, a prompt, and a verifier that inspects the
 * workspace (and the model's final answer) afterwards. Verifiers never call a model and never
 * need a shell, so they behave the same on every OS.
 *
 * Every task also carries a `reference` solution. The tests apply it to prove that the start
 * state fails the verifier and the known-good state passes, so a green run means something.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Bump when a task or verifier changes, so old results are not compared with new ones. */
export const TASK_SET_VERSION = 1;

export type Category = 'read' | 'edit' | 'write' | 'search' | 'bash' | 'fix';

export interface Verdict {
  pass: boolean;
  /** One short line: why it passed or what was wrong. */
  reason: string;
}

export interface VerifyContext {
  /** The workspace after the run. */
  dir: string;
  /** The model's final answer text. */
  answer: string;
  /** Tools that actually ran, by name. */
  toolsUsed: Record<string, number>;
}

export interface EvalTask {
  id: string;
  category: Category;
  prompt: string;
  /** Files written into the fresh workspace before the run (relative path → content). */
  files: Record<string, string>;
  /** Tools that must have run at least once (the bash task proves the model used a shell). */
  requireTools?: string[];
  verify(ctx: VerifyContext): Promise<Verdict>;
  /** A known-good solution: files to overwrite and/or the final answer text. */
  reference: { files?: Record<string, string>; answer?: string };
}

const pass = (reason: string): Verdict => ({ pass: true, reason });
const fail = (reason: string): Verdict => ({ pass: false, reason });

function readText(dir: string, rel: string): string | undefined {
  const path = join(dir, rel);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

/** Whole-file equality after line-ending normalisation: proves nothing else was touched. */
function expectFile(dir: string, rel: string, expected: string): string | undefined {
  const actual = readText(dir, rel);
  if (actual === undefined) return `${rel} is missing`;
  if (actual !== expected) return `${rel} does not match the expected result`;
  return undefined;
}

/** Run `bun test` in the workspace without a shell. */
async function bunTest(dir: string): Promise<{ ok: boolean; tail: string }> {
  const proc = Bun.spawn([process.execPath, 'test'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  });
  const timer = setTimeout(() => proc.kill(), 60_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const tail = `${out}\n${err}`.trim().split('\n').slice(-3).join(' | ');
  return { ok: code === 0, tail };
}

/** Shared verifier for the two fix tasks: tests pass, and the test file was not edited. */
async function verifyFix(dir: string, testFile: string, originalTest: string): Promise<Verdict> {
  if (readText(dir, testFile) !== originalTest) return fail(`${testFile} was modified`);
  const r = await bunTest(dir);
  return r.ok ? pass('tests pass, test file untouched') : fail(`tests still fail: ${r.tail}`);
}

// ---- read ---------------------------------------------------------------------------------

const PRICING = `export const TAX_RATE = 0.2;

export function applyBulkDiscount(subtotal: number, quantity: number): number {
  const rate = quantity >= 10 ? 0.15 : 0;
  return subtotal * (1 - rate);
}

export function addTax(amount: number): number {
  return amount * (1 + TAX_RATE);
}
`;

const readDiscount: EvalTask = {
  id: 'read-discount',
  category: 'read',
  prompt:
    'In this project, which function applies the bulk discount, and what discount rate does it apply? Answer in one short sentence.',
  files: {
    'src/pricing.ts': PRICING,
    'src/index.ts': "export * from './pricing.ts';\n",
  },
  async verify({ answer }) {
    if (!/applyBulkDiscount/.test(answer)) return fail('answer does not name applyBulkDiscount');
    if (!/15\s*%|0\.15/.test(answer)) return fail('answer does not give the 15% rate');
    return pass('named applyBulkDiscount and 15%');
  },
  reference: { answer: 'applyBulkDiscount applies a 15% discount (0.15) for 10 or more items.' },
};

const readConfig: EvalTask = {
  id: 'read-config',
  category: 'read',
  prompt:
    'What port is configured in config/server.json, and which file under src/ reads that config? Answer in one short sentence.',
  files: {
    'config/server.json': '{\n  "host": "0.0.0.0",\n  "port": 8421,\n  "logLevel": "info"\n}\n',
    'src/main.ts':
      "import config from '../config/server.json';\n\nBun.serve({ port: config.port, fetch: () => new Response('ok') });\n",
    'src/util.ts':
      'export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));\n',
    'src/legacy.ts':
      '// Old standalone server, not wired to the config file.\nexport const OLD_PORT = 3000;\n',
  },
  async verify({ answer }) {
    if (!/8421/.test(answer)) return fail('answer does not give port 8421');
    if (!/main\.ts/.test(answer)) return fail('answer does not name src/main.ts');
    if (/3000|legacy\.ts|util\.ts/.test(answer))
      return fail('answer mentions a decoy file or port');
    return pass('port 8421 read by main.ts');
  },
  reference: { answer: 'The port is 8421, and src/main.ts reads the config.' },
};

// ---- edit ---------------------------------------------------------------------------------

const CART = `export interface Item {
  price: number;
  qty: number;
}

export function calcTotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
`;
const CHECKOUT = `import { calcTotal, type Item } from './cart.ts';

export function checkout(items: Item[]): string {
  const total = calcTotal(items);
  return \`Total: \${total.toFixed(2)}\`;
}
`;
const REPORT = `import { calcTotal, type Item } from './cart.ts';

export function summary(orders: Item[][]): number[] {
  return orders.map((items) => calcTotal(items));
}
`;
const renamed = (s: string) => s.replaceAll('calcTotal', 'computeTotal');

const editRename: EvalTask = {
  id: 'edit-rename',
  category: 'edit',
  prompt:
    'Rename the function calcTotal to computeTotal everywhere in this project: the definition and every caller. Do not change anything else.',
  files: { 'src/cart.ts': CART, 'src/checkout.ts': CHECKOUT, 'src/report.ts': REPORT },
  async verify({ dir }) {
    for (const [rel, original] of [
      ['src/cart.ts', CART],
      ['src/checkout.ts', CHECKOUT],
      ['src/report.ts', REPORT],
    ] as const) {
      const problem = expectFile(dir, rel, renamed(original));
      if (problem) return fail(problem);
    }
    return pass('renamed in all three files, nothing else changed');
  },
  reference: {
    files: {
      'src/cart.ts': renamed(CART),
      'src/checkout.ts': renamed(CHECKOUT),
      'src/report.ts': renamed(REPORT),
    },
  },
};

const NET = `// Network settings.
export const TIMEOUT_MS = 5000;
export const MAX_RETRIES = 3;
export const BACKOFF_MS = 250;

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, BACKOFF_MS * 2 ** attempt));
    }
  }
  throw lastError;
}
`;
const NET_EXPECTED = NET.replace('MAX_RETRIES = 3', 'MAX_RETRIES = 5');

const editConstant: EvalTask = {
  id: 'edit-constant',
  category: 'edit',
  prompt: 'In src/net.ts change MAX_RETRIES from 3 to 5. Change nothing else.',
  files: { 'src/net.ts': NET },
  async verify({ dir }) {
    const problem = expectFile(dir, 'src/net.ts', NET_EXPECTED);
    return problem ? fail(problem) : pass('MAX_RETRIES is 5, file otherwise identical');
  },
  reference: { files: { 'src/net.ts': NET_EXPECTED } },
};

// ---- write --------------------------------------------------------------------------------

const writeSlugify: EvalTask = {
  id: 'write-slugify',
  category: 'write',
  prompt:
    "Create src/slug.ts exporting a function slugify(input: string): string. It lowercases the input, replaces every run of characters that are not a-z or 0-9 with a single '-', and strips leading and trailing '-'. Example: slugify('  Hello, World! ') returns 'hello-world'.",
  files: { 'README.md': '# demo\n' },
  async verify({ dir }) {
    const path = join(dir, 'src', 'slug.ts');
    if (!existsSync(path)) return fail('src/slug.ts was not created');
    let mod: { slugify?: unknown };
    try {
      mod = (await import(`${pathToFileURL(path).href}?t=${Date.now()}`)) as typeof mod;
    } catch (err) {
      return fail(`src/slug.ts does not load: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof mod.slugify !== 'function') return fail('src/slug.ts does not export slugify');
    const cases: Array<[string, string]> = [
      ['  Hello, World! ', 'hello-world'],
      ['a--b__c', 'a-b-c'],
      ['---', ''],
      ['Already-Slug', 'already-slug'],
      ['Route 66', 'route-66'],
    ];
    for (const [input, expected] of cases) {
      const got = (mod.slugify as (s: string) => unknown)(input);
      if (got !== expected)
        return fail(`slugify(${JSON.stringify(input)}) = ${JSON.stringify(got)}`);
    }
    return pass('slugify passes all cases');
  },
  reference: {
    files: {
      'src/slug.ts':
        "export function slugify(input: string): string {\n  return input\n    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, '-')\n    .replace(/^-+|-+$/g, '');\n}\n",
    },
  },
};

// ---- search -------------------------------------------------------------------------------

const searchCallers: EvalTask = {
  id: 'search-callers',
  category: 'search',
  prompt:
    'List every file under src/ that calls legacyFetch( (not the file that defines it). Output only the file paths, one per line.',
  files: {
    'src/http/client.ts':
      'export async function legacyFetch(url: string): Promise<string> {\n  return (await fetch(url)).text();\n}\n\nexport async function legacyFetchAll(urls: string[]): Promise<string[]> {\n  return Promise.all(urls.map((u) => legacyFetch(u)));\n}\n',
    'src/pages/home.ts':
      "import { legacyFetch } from '../http/client.ts';\n\nexport const home = () => legacyFetch('/home');\n",
    'src/pages/about.ts':
      "import { legacyFetch } from '../http/client.ts';\n\nexport const about = () => legacyFetch('/about');\n",
    'src/jobs/sync.ts':
      "import { legacyFetch } from '../http/client.ts';\n\nexport const sync = async () => (await legacyFetch('/sync')).length;\n",
    'src/pages/contact.ts':
      "import { legacyFetchAll } from '../http/client.ts';\n\nexport const contact = () => legacyFetchAll(['/a', '/b']);\n",
  },
  async verify({ answer }) {
    for (const f of ['home.ts', 'about.ts', 'sync.ts']) {
      if (!new RegExp(`\\b${f.replace('.', '\\.')}`).test(answer)) return fail(`missing ${f}`);
    }
    for (const f of ['client.ts', 'contact.ts']) {
      if (new RegExp(`\\b${f.replace('.', '\\.')}`).test(answer)) return fail(`wrongly lists ${f}`);
    }
    return pass('exactly the three call sites');
  },
  reference: { answer: 'src/pages/home.ts\nsrc/pages/about.ts\nsrc/jobs/sync.ts' },
};

const searchTests: EvalTask = {
  id: 'search-tests',
  category: 'search',
  prompt:
    'How many TypeScript test files (file names ending in .test.ts) are in this project, not counting node_modules? Answer with just the number.',
  files: {
    'src/a.test.ts': "import { test } from 'bun:test';\ntest('a', () => {});\n",
    'src/lib/b.test.ts': "import { test } from 'bun:test';\ntest('b', () => {});\n",
    'src/lib/deep/c.test.ts': "import { test } from 'bun:test';\ntest('c', () => {});\n",
    'tests/d.test.ts': "import { test } from 'bun:test';\ntest('d', () => {});\n",
    'tests/e.test.js': "test('e', () => {});\n",
    'src/lib/g.spec.ts': "test('g', () => {});\n",
    'node_modules/pkg/f.test.ts': "test('f', () => {});\n",
    'README.md': '# demo\n',
  },
  async verify({ answer }) {
    const numbers = answer.match(/\d+/g) ?? [];
    if (numbers.length === 0) return fail('answer has no number');
    if (numbers.some((n) => n !== '4'))
      return fail(`expected 4, answer says ${numbers.join(', ')}`);
    return pass('counted 4');
  },
  reference: { answer: '4' },
};

// ---- bash ---------------------------------------------------------------------------------

const DATA = '12\n7\n301\n44\n9\n58\n1023\n6\n';
const SUM_JS = `// Prints a checksum of data.txt.
const fs = require('node:fs');
const nums = fs.readFileSync('data.txt', 'utf8').split('\\n').filter(Boolean).map(Number);
let h = 7;
for (const n of nums) h = (h * 31 + n) % 1000003;
console.log(h);
`;
const SUM_EXPECTED = String(
  DATA.split('\n')
    .filter(Boolean)
    .map(Number)
    .reduce((h, n) => (h * 31 + n) % 1000003, 7),
);

const bashRun: EvalTask = {
  id: 'bash-run',
  category: 'bash',
  prompt: 'Run `bun sum.js` in this directory and save exactly what it prints to answer.txt.',
  files: { 'data.txt': DATA, 'sum.js': SUM_JS },
  requireTools: ['bash'],
  async verify({ dir }) {
    const got = readText(dir, 'answer.txt');
    if (got === undefined) return fail('answer.txt was not created');
    if (got.trim() !== SUM_EXPECTED) {
      return fail(
        `answer.txt has ${JSON.stringify(got.trim().slice(0, 40))}, expected ${SUM_EXPECTED}`,
      );
    }
    return pass('answer.txt holds the script output');
  },
  reference: { files: { 'answer.txt': `${SUM_EXPECTED}\n` } },
};

// ---- fix (multi-step) ---------------------------------------------------------------------

const STATS = `export function average(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((a, b) => a + b, 0);
  return total / (values.length + 1);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}
`;
const STATS_TEST = `import { expect, test } from 'bun:test';
import { average, median } from './stats.ts';

test('average of several values', () => {
  expect(average([2, 4, 6])).toBe(4);
});

test('average of an empty list is 0', () => {
  expect(average([])).toBe(0);
});

test('median of an odd count', () => {
  expect(median([3, 1, 2])).toBe(2);
});

test('median of an even count', () => {
  expect(median([4, 1, 3, 2])).toBe(2.5);
});
`;

const fixAverage: EvalTask = {
  id: 'fix-average',
  category: 'fix',
  prompt:
    'The tests in src/stats.test.ts are failing. Find the bug in the source, fix it, and run the tests to confirm they pass. Do not edit the test file.',
  files: { 'src/stats.ts': STATS, 'src/stats.test.ts': STATS_TEST },
  verify: ({ dir }) => verifyFix(dir, 'src/stats.test.ts', STATS_TEST),
  reference: { files: { 'src/stats.ts': STATS.replace('values.length + 1', 'values.length') } },
};

const COUPONS = `export const COUPONS: Record<string, number> = {
  SAVE10: 10,
  SAVE20: 20,
};

export function discountFor(code: string | undefined): number {
  if (!code) return 0;
  return COUPONS[code] ?? 0;
}
`;
const CART_TS = `import { discountFor } from './coupons.ts';

export interface Line {
  price: number;
  qty: number;
}

export function subtotal(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.price * l.qty, 0);
}

export function total(lines: Line[], code?: string): number {
  const base = subtotal(lines);
  return base - base * discountFor(code);
}
`;
const CART_TEST = `import { expect, test } from 'bun:test';
import { subtotal, total } from './cart.ts';

const lines = [{ price: 10, qty: 3 }];

test('subtotal adds up every line', () => {
  expect(subtotal([...lines, { price: 5, qty: 2 }])).toBe(40);
});

test('no coupon leaves the total alone', () => {
  expect(total(lines)).toBe(30);
});

test('SAVE20 takes 20 percent off', () => {
  expect(total(lines, 'SAVE20')).toBeCloseTo(24, 6);
});

test('SAVE10 takes 10 percent off', () => {
  expect(total(lines, 'SAVE10')).toBeCloseTo(27, 6);
});

test('an unknown coupon changes nothing', () => {
  expect(total(lines, 'NOPE')).toBe(30);
});
`;

const fixCoupon: EvalTask = {
  id: 'fix-coupon',
  category: 'fix',
  prompt:
    "total(lines, 'SAVE20') in src/cart.ts returns the wrong amount and the tests in src/cart.test.ts fail. Find the cause, fix it in the source, and run the tests to confirm. Do not edit the test file.",
  files: { 'src/coupons.ts': COUPONS, 'src/cart.ts': CART_TS, 'src/cart.test.ts': CART_TEST },
  verify: ({ dir }) => verifyFix(dir, 'src/cart.test.ts', CART_TEST),
  reference: {
    files: { 'src/cart.ts': CART_TS.replace('discountFor(code)', 'discountFor(code) / 100') },
  },
};

export const TASKS: EvalTask[] = [
  readDiscount,
  readConfig,
  editRename,
  editConstant,
  writeSlugify,
  searchCallers,
  searchTests,
  bashRun,
  fixAverage,
  fixCoupon,
];

export function selectTasks(ids?: string[]): EvalTask[] {
  if (!ids || ids.length === 0) return TASKS;
  const known = new Set(TASKS.map((t) => t.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown task id(s): ${unknown.join(', ')}. Known: ${[...known].join(', ')}`);
  }
  return TASKS.filter((t) => ids.includes(t.id));
}
