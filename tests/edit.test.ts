import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { editTool } from '../src/tools/edit.ts';
import { ctx, tempDir } from './helpers.ts';

describe('edit tool', () => {
  let t: ReturnType<typeof tempDir>;
  let file: string;
  beforeEach(async () => {
    t = tempDir();
    file = join(t.dir, 'a.ts');
    await Bun.write(file, 'const a = 1;\nconst b = 2;\nconst c = a + b;\n');
  });
  afterEach(() => t.cleanup());

  test('replaces a unique string', async () => {
    const out = await editTool.execute(
      { path: 'a.ts', old_string: 'const b = 2;', new_string: 'const b = 3;' },
      ctx(t.dir),
    );
    expect(out).toContain('Edited a.ts (1 replacement)');
    expect(await Bun.file(file).text()).toBe('const a = 1;\nconst b = 3;\nconst c = a + b;\n');
  });

  test('refuses when old_string is not found', async () => {
    await expect(
      editTool.execute({ path: 'a.ts', old_string: 'nope', new_string: 'x' }, ctx(t.dir)),
    ).rejects.toThrow(/not found/);
  });

  test('refuses ambiguous matches unless replace_all', async () => {
    await expect(
      editTool.execute({ path: 'a.ts', old_string: 'const', new_string: 'let' }, ctx(t.dir)),
    ).rejects.toThrow(/matches 3 times/);
    const out = await editTool.execute(
      { path: 'a.ts', old_string: 'const', new_string: 'let', replace_all: true },
      ctx(t.dir),
    );
    expect(out).toContain('3 replacements');
    expect(await Bun.file(file).text()).toBe('let a = 1;\nlet b = 2;\nlet c = a + b;\n');
  });

  test('rejects empty or identical strings and missing files', async () => {
    await expect(
      editTool.execute({ path: 'a.ts', old_string: '', new_string: 'x' }, ctx(t.dir)),
    ).rejects.toThrow(/empty/);
    await expect(
      editTool.execute({ path: 'a.ts', old_string: 'x', new_string: 'x' }, ctx(t.dir)),
    ).rejects.toThrow(/identical/);
    await expect(
      editTool.execute({ path: 'missing.ts', old_string: 'x', new_string: 'y' }, ctx(t.dir)),
    ).rejects.toThrow(/not found/);
  });

  test('replacement containing $ is inserted literally', async () => {
    await editTool.execute(
      { path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = "$1 $& $$";' },
      ctx(t.dir),
    );
    expect(await Bun.file(file).text()).toContain('const a = "$1 $& $$";');
  });
});
