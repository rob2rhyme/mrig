import { describe, expect, test } from 'bun:test';
import { type Answer, type AskRequest, PermissionManager } from '../src/permissions.ts';
import { bashTool } from '../src/tools/bash.ts';
import { editTool } from '../src/tools/edit.ts';
import { readTool } from '../src/tools/read.ts';
import { writeTool } from '../src/tools/write.ts';

function pm(opts: { yolo?: boolean; allow?: string[]; answer?: Answer; log?: AskRequest[] }) {
  return new PermissionManager({
    yolo: opts.yolo ?? false,
    allow: opts.allow ?? [],
    cwd: '/work',
    ask: async (req) => {
      opts.log?.push(req);
      return opts.answer ?? 'no';
    },
  });
}

describe('PermissionManager', () => {
  test('read-only tools never ask', async () => {
    const log: AskRequest[] = [];
    const p = pm({ log });
    expect(await p.check(readTool, { path: 'x' })).toBe('allow');
    expect(log.length).toBe(0);
  });

  test('yolo allows everything without asking', async () => {
    const log: AskRequest[] = [];
    const p = pm({ yolo: true, log });
    expect(await p.check(bashTool, { command: 'rm -rf /' })).toBe('allow');
    expect(log.length).toBe(0);
  });

  test('asks for writes and honors the answer', async () => {
    const log: AskRequest[] = [];
    expect(await pm({ answer: 'no', log }).check(writeTool, { path: 'a.txt', content: '' })).toBe(
      'deny',
    );
    expect(await pm({ answer: 'yes' }).check(writeTool, { path: 'a.txt', content: '' })).toBe(
      'allow',
    );
    expect(log[0]?.summary).toContain('write a.txt');
    expect(log[0]?.alwaysRule).toBe('write:**');
  });

  test('bash prefix rules and "always" learning', async () => {
    const p = pm({ allow: ['bash:git status'], answer: 'always' });
    expect(p.matches(bashTool, { command: 'git status --short' })).toBe(true);
    expect(p.matches(bashTool, { command: 'git push' })).toBe(false);
    expect(await p.check(bashTool, { command: 'npm test -- --watch=false' })).toBe('allow');
    expect(p.learned).toEqual(['bash:npm test']);
    expect(p.matches(bashTool, { command: 'npm test' })).toBe(true);
  });

  test('path glob rules for write/edit', async () => {
    const p = pm({ allow: ['edit:src/**', 'write:docs/*.md'] });
    expect(
      p.matches(editTool, { path: 'src/deep/file.ts', old_string: 'a', new_string: 'b' }),
    ).toBe(true);
    expect(p.matches(editTool, { path: 'lib/file.ts', old_string: 'a', new_string: 'b' })).toBe(
      false,
    );
    expect(p.matches(writeTool, { path: 'docs/readme.md', content: '' })).toBe(true);
    expect(p.matches(writeTool, { path: 'docs/sub/readme.md', content: '' })).toBe(false);
    expect(p.matches(writeTool, { path: '/work/docs/x.md', content: '' })).toBe(true);
  });

  test('wildcard rule allows a whole tool', async () => {
    const p = pm({ allow: ['bash:*'] });
    expect(await p.check(bashTool, { command: 'anything' })).toBe('allow');
  });
});
