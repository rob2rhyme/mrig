import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseArgs } from '../src/cli/args.ts';
import { DEFAULT_CONFIG, type MrigConfig } from '../src/config.ts';
import { checkProfile } from '../src/doctor.ts';
import { PermissionManager } from '../src/permissions.ts';
import { Runtime, type RuntimeOptions } from '../src/runtime.ts';
import { Session, sessionsDir } from '../src/session.ts';
import { bashTool } from '../src/tools/bash.ts';
import { type AnyTool, DEFAULT_TOOLS } from '../src/tools/index.ts';
import { defineTool } from '../src/tools/types.ts';
import { writeTool } from '../src/tools/write.ts';
import {
  assertNoYolo,
  assertProfileAllowed,
  assertResumeAllowed,
  findZone,
  isLocalProfile,
  isLoopbackHost,
  isLoopbackUrl,
  OfflineError,
  offlineTools,
  resolveOffline,
  splitBashRules,
  ZONE_MARKER,
  zoneSessionsDir,
} from '../src/zone.ts';
import { tempDir } from './helpers.ts';

const OLLAMA = DEFAULT_CONFIG.providers.ollama;
const CLAUDE = DEFAULT_CONFIG.providers.claude;
if (!OLLAMA || !CLAUDE) throw new Error('built-in profiles missing');

describe('offline rules: loopback', () => {
  test('only names that always mean this machine count as local', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.255.0.9', '[::1]', '0.0.0.0']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of [
      '127.example.com',
      'localhost.example.com',
      'foo.localhost',
      '10.0.0.5',
      '192.168.1.2',
      '127.0.0.256',
    ]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  test('URLs are parsed, not pattern-matched', () => {
    expect(isLoopbackUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackUrl('http://127.1:8080/v1')).toBe(true); // normalised to 127.0.0.1
    expect(isLoopbackUrl('http://[::1]:1234/v1')).toBe(true);
    expect(isLoopbackUrl('http://localhost@evil.example/v1')).toBe(false); // userinfo trick
    expect(isLoopbackUrl('http://127.0.0.1.nip.io/v1')).toBe(false);
    expect(isLoopbackUrl('https://openrouter.ai/api/v1')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });

  test('a profile is local by its base URL, whatever its kind', () => {
    expect(isLocalProfile(OLLAMA)).toBe(true);
    expect(isLocalProfile(CLAUDE)).toBe(false); // no base URL: the cloud API
    expect(
      isLocalProfile({ kind: 'anthropic', model: 'm', baseURL: 'http://localhost:11434' }),
    ).toBe(true);
    expect(
      isLocalProfile({ kind: 'openai-compatible', model: 'm', baseURL: 'http://10.0.0.5:8000/v1' }),
    ).toBe(false);
  });
});

describe('offline rules: zones and the other checks', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('mrig-zone-');
  });
  afterEach(() => t.cleanup());

  test('a zone is found by the same upward search as AGENTS.md, stopping at the git root', () => {
    const project = join(t.dir, 'project');
    const deep = join(project, 'src', 'deep');
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(project, '.git'));
    expect(findZone(deep)).toBeUndefined();
    writeFileSync(join(t.dir, ZONE_MARKER), ''); // above the git root: not this project's
    expect(findZone(deep)).toBeUndefined();
    writeFileSync(join(project, ZONE_MARKER), '');
    expect(findZone(deep)).toBe(project);
    expect(resolveOffline(deep)).toEqual({ source: 'zone', zone: project });
    expect(resolveOffline(deep, true)).toEqual({ source: 'zone', zone: project }); // zone wins
    expect(resolveOffline(t.dir, true)).toEqual({ source: 'zone', zone: t.dir });
    const elsewhere = join(t.dir, 'elsewhere');
    mkdirSync(join(elsewhere, '.git'), { recursive: true });
    expect(resolveOffline(elsewhere)).toBeUndefined();
    expect(resolveOffline(elsewhere, true)).toEqual({ source: 'flag' });
  });

  test('profiles, yolo and bash rules', () => {
    const zone = { source: 'zone' as const, zone: '/work/secret' };
    expect(() => assertProfileAllowed('ollama', OLLAMA, zone)).not.toThrow();
    expect(() => assertProfileAllowed('claude', CLAUDE, undefined)).not.toThrow();
    expect(() => assertProfileAllowed('claude', CLAUDE, zone)).toThrow(OfflineError);
    expect(() => assertProfileAllowed('claude', CLAUDE, zone)).toThrow(
      /Offline zone \/work\/secret only allows profiles on this machine, and "claude" uses the anthropic cloud API/,
    );
    expect(() =>
      assertProfileAllowed(
        'gpu',
        { kind: 'openai-compatible', model: 'm', baseURL: 'http://10.0.0.5:8000/v1' },
        { source: 'flag' },
      ),
    ).toThrow(/Offline mode \(--offline\).*"gpu" uses 10\.0\.0\.5:8000/);
    expect(() => assertNoYolo(true, zone)).toThrow(
      /--yolo, MRIG_YOLO and permissions\.yolo are refused/,
    );
    expect(() => assertNoYolo(false, zone)).not.toThrow();
    expect(() => assertNoYolo(true, undefined)).not.toThrow();
    expect(splitBashRules(['bash:git status', ' bash:ls', 'edit:src/**', 'write:*'])).toEqual({
      kept: ['edit:src/**', 'write:*'],
      dropped: ['bash:git status', ' bash:ls'],
    });
  });

  test('tools that reach other hosts are dropped offline', () => {
    const fetchTool = defineTool({
      name: 'webpage',
      description: 'Fetch a URL',
      inputSchema: z.object({ url: z.string() }),
      readOnly: true,
      remote: true,
      summarize: (i) => i.url,
      execute: async () => '',
    }) as AnyTool;
    const tools = [...DEFAULT_TOOLS, fetchTool];
    expect(offlineTools(tools, undefined).map((x) => x.name)).toContain('webpage');
    const offline = offlineTools(tools, { source: 'flag' }).map((x) => x.name);
    expect(offline).not.toContain('webpage');
    expect(offline).not.toContain('fetch'); // the built-in fetch tool is remote too
    expect(offline).toEqual(['read', 'edit', 'write', 'bash', 'glob', 'grep', 'translit']); // translit is local
  });

  test('resume never crosses a zone boundary', () => {
    const inA = { source: 'zone' as const, zone: '/a' };
    expect(() => assertResumeAllowed({ id: 's1' }, undefined)).not.toThrow();
    expect(() => assertResumeAllowed({ id: 's1', zone: '/a' }, inA)).not.toThrow();
    expect(() => assertResumeAllowed({ id: 's1' }, { source: 'flag' })).not.toThrow();
    expect(() => assertResumeAllowed({ id: 's1', zone: '/a' }, undefined)).toThrow(
      /belongs to the offline zone \/a/,
    );
    expect(() => assertResumeAllowed({ id: 's1', zone: '/a' }, { source: 'flag' })).toThrow(
      /Resume it from inside that zone/,
    );
    expect(() => assertResumeAllowed({ id: 's1' }, inA)).toThrow(
      /started outside the offline zone \/a/,
    );
    expect(() => assertResumeAllowed({ id: 's1', zone: '/b' }, inA)).toThrow(/cannot cross zones/);
  });

  test("the zone's sessions folder ignores itself in git", () => {
    const dir = zoneSessionsDir(t.dir);
    expect(dir).toBe(join(t.dir, '.mrig', 'sessions'));
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('*');
  });

  test('offline permissions: bash rules never apply and "always" means once', async () => {
    let asked = 0;
    const pm = new PermissionManager({
      yolo: false,
      allow: ['bash:ls', 'write:**'],
      cwd: t.dir,
      noBashRules: true,
      ask: async () => {
        asked++;
        return 'always';
      },
    });
    expect(pm.matches(bashTool, { command: 'ls -la' })).toBe(false); // the config rule is ignored
    expect(pm.matches(writeTool, { path: 'a.txt', content: '' })).toBe(true); // other rules stay
    expect(await pm.check(bashTool, { command: 'ls' })).toBe('allow');
    expect(await pm.check(bashTool, { command: 'ls' })).toBe('allow');
    expect(asked).toBe(2); // asked both times: nothing was learned
    expect(pm.learned).toEqual([]);
    expect(pm.alwaysRuleFor(bashTool, { command: 'ls' })).toMatch(/once/);
  });

  test('doctor offline does not contact remote profiles', async () => {
    let calls = 0;
    const fetchStub = (async () => {
      calls++;
      return Response.json({ data: [{ id: 'qwen3-coder:latest' }] });
    }) as unknown as typeof fetch;
    const remote = await checkProfile(
      'claude',
      { ...CLAUDE, apiKey: 'k' },
      { fetch: fetchStub, offline: true },
    );
    expect(remote.status).toBe('offline');
    expect(calls).toBe(0);
    const local = await checkProfile('ollama', OLLAMA, { fetch: fetchStub, offline: true });
    expect(local.status).toBe('ok');
    expect(calls).toBe(1);
  });

  test('--offline is a CLI flag', () => {
    expect(parseArgs(['--offline']).offline).toBe(true);
    expect(parseArgs([]).offline).toBe(false);
  });
});

describe('offline mode in the runtime', () => {
  let t: ReturnType<typeof tempDir>;
  let home: ReturnType<typeof tempDir>;
  let project: string;
  const prevHome = process.env.MRIG_HOME;
  const prevYolo = process.env.MRIG_YOLO;
  beforeEach(() => {
    t = tempDir('mrig-zone-');
    home = tempDir('mrig-home-');
    process.env.MRIG_HOME = home.dir;
    delete process.env.MRIG_YOLO;
    project = join(t.dir, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(join(project, ZONE_MARKER), '');
  });
  afterEach(() => {
    t.cleanup();
    home.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
    if (prevYolo === undefined) delete process.env.MRIG_YOLO;
    else process.env.MRIG_YOLO = prevYolo;
  });

  const writeConfig = (obj: unknown) =>
    writeFileSync(join(home.dir, 'config.json'), JSON.stringify(obj));
  const start = (over: Partial<RuntimeOptions> = {}) => {
    const notices: string[] = [];
    const rt = new Runtime({
      cwd: project,
      provider: 'ollama',
      ask: async () => 'no',
      events: { onText: () => {}, onNotice: (m) => notices.push(m) },
      ...over,
    });
    return { rt, notices };
  };

  test('inside a zone: cloud profiles are refused, local ones work', () => {
    expect(() => start({ provider: 'claude' })).toThrow(OfflineError);
    expect(() => start({ provider: undefined })).toThrow(/"claude" uses the anthropic cloud API/); // the default
    const { rt } = start();
    expect(rt.offline).toEqual({ source: 'zone', zone: project });
    expect(rt.agent.opts.tools.map((x) => x.name)).not.toContain('fetch'); // remote: dropped offline
    expect(rt.agent.opts.tools.length).toBe(DEFAULT_TOOLS.length - 1);
  });

  test('inside a zone: transcripts stay in the zone and are git-ignored', () => {
    const { rt } = start();
    rt.save();
    const dir = join(project, '.mrig', 'sessions');
    expect(rt.sessionsDir).toBe(dir);
    expect(existsSync(join(dir, `${rt.session.meta.id}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);
    expect(rt.session.meta.zone).toBe(project);
    expect(Session.list()).toEqual([]); // nothing in ~/.mrig/sessions
    expect(rt.listSessions().map((s) => s.id)).toEqual([rt.session.meta.id]);
    const again = start({ resume: 'latest' });
    expect(again.rt.session.meta.id).toBe(rt.session.meta.id);
  });

  test('prompts cannot be turned off: --yolo, MRIG_YOLO, permissions.yolo or /yolo', () => {
    expect(() => start({ yolo: true })).toThrow(/permission prompts on/);
    process.env.MRIG_YOLO = '1';
    expect(() => start()).toThrow(/permission prompts on/);
    delete process.env.MRIG_YOLO;
    writeConfig({ permissions: { yolo: true } });
    expect(() => start()).toThrow(/permission prompts on/);
    writeConfig({});
    const { rt } = start();
    expect(() => rt.setYolo(true)).toThrow(OfflineError);
    expect(rt.permissions.yolo).toBe(false);
    rt.setYolo(false);
  });

  test('bash allow-rules from config are ignored, with one notice; others still apply', () => {
    writeConfig({ permissions: { allow: ['bash:git status', 'bash:ls', 'write:notes/**'] } });
    const { rt, notices } = start();
    expect(notices).toEqual([
      `Offline zone ${project}: ignoring 2 bash allow-rules; every command asks.`,
    ]);
    expect(rt.permissions.matches(bashTool, { command: 'git status' })).toBe(false);
    expect(rt.permissions.matches(writeTool, { path: 'notes/a.md', content: '' })).toBe(true);
  });

  test('switching to a cloud model, or summarizing with one, is refused', () => {
    const { rt } = start();
    expect(() => rt.switchModel('claude')).toThrow(OfflineError);
    expect(rt.providerName).toBe('ollama'); // unchanged
    rt.switchModel('lmstudio'); // local: fine
    expect(rt.providerName).toBe('lmstudio');
    writeConfig({ compaction: { compactModel: 'claude' } });
    expect(() => start()).toThrow(/"claude" uses the anthropic cloud API/);
  });

  test('resume never crosses the zone boundary, in either direction', () => {
    const outsideDir = join(t.dir, 'outside');
    mkdirSync(join(outsideDir, '.git'), { recursive: true });
    const outside = new Runtime({
      cwd: outsideDir,
      provider: 'ollama',
      ask: async () => 'no',
      events: { onText: () => {} },
    });
    outside.save();
    expect(outside.offline).toBeUndefined();
    const { rt } = start();
    rt.save();
    expect(() => rt.resume(outside.session.meta.id)).toThrow(
      /only its own sessions can be resumed/,
    );
    expect(() => start({ resume: outside.session.meta.id })).toThrow(OfflineError);
    // A zone transcript copied out of the zone still refuses to open outside it.
    copyFileSync(
      join(project, '.mrig', 'sessions', `${rt.session.meta.id}.jsonl`),
      join(sessionsDir(), `${rt.session.meta.id}.jsonl`),
    );
    expect(() => outside.resume(rt.session.meta.id)).toThrow(/belongs to the offline zone/);
    expect(outside.resume(outside.session.meta.id).meta.id).toBe(outside.session.meta.id);
  });

  test('--offline outside any zone: local profiles only, but transcripts stay where they were', () => {
    const plain = join(t.dir, 'plain');
    mkdirSync(join(plain, '.git'), { recursive: true });
    expect(() => start({ cwd: plain, provider: 'claude', offline: true })).toThrow(
      /Offline mode \(--offline\)/,
    );
    const { rt } = start({ cwd: plain, offline: true });
    expect(rt.offline).toEqual({ source: 'flag' });
    expect(rt.sessionsDir).toBeUndefined();
    rt.save();
    expect(Session.list().map((s) => s.id)).toEqual([rt.session.meta.id]);
    expect(rt.session.meta.zone).toBeUndefined();
    // Without --offline the same folder behaves as before.
    const normal = start({
      cwd: plain,
      provider: 'claude',
      config: {
        ...DEFAULT_CONFIG,
        providers: { claude: { ...CLAUDE, apiKey: 'k' } },
      } as MrigConfig,
    });
    expect(normal.rt.offline).toBeUndefined();
  });
});
