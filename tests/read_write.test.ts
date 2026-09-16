import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readTool } from '../src/tools/read.ts';
import { writeTool } from '../src/tools/write.ts';
import { ctx, tempDir } from './helpers.ts';

describe('read tool', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(async () => {
    t = tempDir();
    await Bun.write(join(t.dir, 'f.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    mkdirSync(join(t.dir, 'sub'));
    await Bun.write(join(t.dir, 'sub', 'x.bin'), new Uint8Array([0, 1, 2, 3]));
  });
  afterEach(() => t.cleanup());

  test('numbers lines like cat -n', async () => {
    const out = await readTool.execute({ path: 'f.txt' }, ctx(t.dir));
    expect(out.split('\n')[0]).toBe('1\tone');
    expect(out).toContain('5\tfive');
  });

  test('offset and limit paginate with a footer', async () => {
    const out = await readTool.execute({ path: 'f.txt', offset: 2, limit: 2 }, ctx(t.dir));
    expect(out).toContain('2\ttwo');
    expect(out).toContain('3\tthree');
    expect(out).not.toContain('four');
    expect(out).toContain('call read with offset=4');
  });

  test('lists directories and flags binary files', async () => {
    const dir = await readTool.execute({ path: '.' }, ctx(t.dir));
    expect(dir).toContain('f.txt');
    expect(dir).toContain('sub/');
    const bin = await readTool.execute({ path: 'sub/x.bin' }, ctx(t.dir));
    expect(bin).toMatch(/Binary file/);
  });

  test('errors on missing path', async () => {
    await expect(readTool.execute({ path: 'nope' }, ctx(t.dir))).rejects.toThrow(/not found/);
  });
});

describe('write tool', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  test('creates parent directories and reports create vs overwrite', async () => {
    const a = await writeTool.execute({ path: 'deep/er/new.txt', content: 'hi\n' }, ctx(t.dir));
    expect(a).toMatch(/^Created deep\/er\/new.txt/);
    const b = await writeTool.execute({ path: 'deep/er/new.txt', content: 'hi2\n' }, ctx(t.dir));
    expect(b).toMatch(/^Overwrote/);
    expect(await Bun.file(join(t.dir, 'deep/er/new.txt')).text()).toBe('hi2\n');
  });
});
