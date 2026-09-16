import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { platform } from 'node:os';
import { bashTool, runShell } from '../src/tools/bash.ts';
import { ctx, tempDir } from './helpers.ts';

const win = platform() === 'win32';

describe('bash tool', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
  });
  afterEach(() => t.cleanup());

  test('captures stdout and runs in cwd', async () => {
    const out = await bashTool.execute(
      { command: win ? 'Get-Location | Select -Expand Path' : 'pwd' },
      ctx(t.dir),
    );
    // macOS tmp dirs may be symlinked (/var → /private/var); compare suffix.
    expect(out.trim().endsWith(t.dir.split(/[\\/]/).pop() ?? '')).toBe(true);
  });

  test('reports non-zero exit codes and stderr', async () => {
    const out = await bashTool.execute(
      { command: win ? 'Write-Error boom; exit 3' : 'echo boom >&2; exit 3' },
      ctx(t.dir),
    );
    expect(out).toContain('boom');
    expect(out).toContain('[exit code 3]');
  });

  test('kills on timeout', async () => {
    const started = Date.now();
    const out = await bashTool.execute(
      { command: win ? 'Start-Sleep -Seconds 10' : 'sleep 10', timeout_ms: 1000 },
      ctx(t.dir),
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out).toContain('timed out');
  });

  test('truncates huge output in the middle', async () => {
    const cmd = win ? "'x' * 200000" : "head -c 200000 /dev/zero | tr '\\0' 'x'";
    const out = await bashTool.execute({ command: cmd }, ctx(t.dir, { maxOutputChars: 10_000 }));
    expect(out.length).toBeLessThan(11_000);
    expect(out).toContain('characters truncated');
  });

  test('aborts via signal', async () => {
    const ac = new AbortController();
    const p = runShell(win ? 'Start-Sleep -Seconds 10' : 'sleep 10', {
      cwd: t.dir,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 200);
    const res = await p;
    expect(res.aborted).toBe(true);
  });
});
