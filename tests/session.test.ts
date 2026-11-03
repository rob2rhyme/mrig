import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { META_WIDTH, Session, sessionsDir } from '../src/session.ts';
import { tempDir } from './helpers.ts';

describe('Session', () => {
  let home: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  beforeEach(() => {
    home = tempDir('mrig-home-');
    process.env.MRIG_HOME = home.dir;
  });
  afterEach(() => {
    home.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  test('create → sync (append) → load round-trips messages and title', () => {
    const s = Session.create({ cwd: '/proj', provider: 'claude', model: 'claude-sonnet-5' });
    s.sync([{ role: 'user', content: 'Fix the failing test in auth.ts please' }]);
    s.sync([
      { role: 'user', content: 'Fix the failing test in auth.ts please' },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ]);
    const loaded = Session.load(s.meta.id);
    expect(loaded.messages.length).toBe(2);
    expect(loaded.meta.title).toBe('Fix the failing test in auth.ts please');
    expect(loaded.meta.cwd).toBe('/proj');
  });

  test('shrinking transcript (compaction/clear) rewrites the file', () => {
    const s = Session.create({ cwd: '/proj', provider: 'claude', model: 'm' });
    s.sync([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
    ]);
    s.sync([{ role: 'user', content: '[mrig] summary' }]);
    expect(Session.load(s.meta.id).messages.length).toBe(1);
    s.sync([]);
    expect(Session.load(s.meta.id).messages.length).toBe(0);
  });

  test('meta stays fresh on long transcripts: in-place rewrite, messages appended', async () => {
    const s = Session.create({ cwd: '/proj', provider: 'claude', model: 'm' });
    const createdAt = s.meta.createdAt;
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: i % 2 ? 'assistant' : 'user', content: `म्यासेज ${i}` }); // non-ASCII title
      if (i === 29) await Bun.sleep(5);
      s.sync([...messages]);
    }
    const raw = readFileSync(s.filePath, 'utf8');
    expect(Buffer.byteLength(raw.slice(0, raw.indexOf('\n')))).toBe(META_WIDTH); // padded head
    expect(raw.split('\n').filter(Boolean).length).toBe(31); // meta + 30 messages
    const loaded = Session.load(s.meta.id);
    expect(loaded.messages.length).toBe(30);
    expect(loaded.messages[29]?.content).toBe('म्यासेज 29');
    expect(loaded.meta.title).toBe('म्यासेज 0');
    expect(loaded.meta.updatedAt).toBe(s.meta.updatedAt);
    expect(loaded.meta.updatedAt > createdAt).toBe(true);
    expect(Session.list()[0]?.updatedAt).toBe(s.meta.updatedAt);
  });

  test('a legacy file with an unpadded meta line is upgraded on the next sync', () => {
    const meta = {
      type: 'meta',
      id: 'legacy-1',
      cwd: '/old',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      provider: 'p',
      model: 'm',
      title: '',
    };
    const msgs: ModelMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `old ${i}`,
    }));
    writeFileSync(
      join(sessionsDir(), 'legacy-1.jsonl'),
      `${[meta, ...msgs.map((m) => ({ type: 'message', message: m }))].map((l) => JSON.stringify(l)).join('\n')}\n`,
    );
    const s = Session.load('legacy-1');
    expect(s.messages.length).toBe(6);
    s.sync([...msgs, { role: 'user', content: 'new 6' }]); // title grows → head no longer fits
    const loaded = Session.load('legacy-1');
    expect(loaded.messages.length).toBe(7);
    expect(loaded.meta.title).toBe('old 0');
    expect(loaded.meta.updatedAt > meta.updatedAt).toBe(true);
    s.sync([...loaded.messages, { role: 'assistant', content: 'new 7' }]); // now in place again
    expect(Session.load('legacy-1').messages.length).toBe(8);
  });

  test('an ephemeral session never touches the disk', () => {
    const s = Session.create({ cwd: '/proj', provider: 'p', model: 'm', ephemeral: true });
    s.sync([{ role: 'user', content: 'hello' }]);
    s.sync([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    s.setModel('q', 'n');
    expect(s.messages.length).toBe(2);
    expect(s.meta.title).toBe('hello');
    expect(s.meta.model).toBe('n');
    expect(existsSync(join(home.dir, 'sessions'))).toBe(false); // checked first: list() creates it
    expect(Session.list()).toEqual([]);
  });

  test('list is newest first and latest() filters by cwd', async () => {
    const a = Session.create({ cwd: '/one', provider: 'p', model: 'm' });
    await Bun.sleep(5);
    const b = Session.create({ cwd: '/two', provider: 'p', model: 'm' });
    expect(Session.list()[0]?.id).toBe(b.meta.id);
    expect(Session.latest('/one')?.id).toBe(a.meta.id);
    expect(Session.latest('/nope')).toBeUndefined();
    expect(() => Session.load('missing')).toThrow(/No session/);
  });
});
