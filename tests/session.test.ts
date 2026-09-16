import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Session } from '../src/session.ts';
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
