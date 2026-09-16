import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { globTool } from '../src/tools/glob.ts';
import { grepTool, grepWithJs, grepWithRipgrep, ripgrepPath } from '../src/tools/grep.ts';
import { ctx, tempDir } from './helpers.ts';

describe('glob and grep', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(async () => {
    t = tempDir();
    mkdirSync(join(t.dir, 'src'));
    mkdirSync(join(t.dir, 'node_modules', 'dep'), { recursive: true });
    await Bun.write(join(t.dir, 'src', 'a.ts'), 'export const alpha = 1;\nfunction beta() {}\n');
    await Bun.write(join(t.dir, 'src', 'b.md'), '# Alpha notes\nbeta gamma\n');
    await Bun.write(join(t.dir, 'node_modules', 'dep', 'index.ts'), 'export const alpha = 2;\n');
  });
  afterEach(() => t.cleanup());

  test('glob finds files and skips node_modules', async () => {
    const out = await globTool.execute({ pattern: '**/*.ts' }, ctx(t.dir));
    expect(out).toContain('src/a.ts');
    expect(out).not.toContain('node_modules');
    const none = await globTool.execute({ pattern: '**/*.rs' }, ctx(t.dir));
    expect(none).toBe('No files matched.');
    await expect(globTool.execute({ pattern: '*', path: 'missing' }, ctx(t.dir))).rejects.toThrow(
      /not found/,
    );
  });

  test('grep (default engine) finds matches with path:line', async () => {
    const out = await grepTool.execute({ pattern: 'alpha', ignore_case: true }, ctx(t.dir));
    expect(out).toContain('src/a.ts:1:');
    expect(out).toContain('src/b.md:1:');
    expect(out).not.toContain('node_modules');
  });

  test('JS fallback engine matches ripgrep semantics for basic cases', async () => {
    const js = await grepWithJs({ pattern: 'beta', glob: '*.ts' }, t.dir);
    expect(js).toContain('src/a.ts:2:');
    expect(js).not.toContain('b.md');
    expect(await grepWithJs({ pattern: 'zzz' }, t.dir)).toBe('No matches.');
    await expect(grepWithJs({ pattern: '(' }, t.dir)).rejects.toThrow(/Invalid regex/);
    const rg = ripgrepPath();
    if (rg) {
      const r = await grepWithRipgrep(rg, { pattern: 'beta', glob: '*.ts' }, t.dir);
      expect(r).toContain('src/a.ts:2:');
      expect(await grepWithRipgrep(rg, { pattern: 'zzz' }, t.dir)).toBe('No matches.');
    }
  });
});
