import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelMessage } from 'ai';
import { Runtime } from '../src/runtime.ts';
import { Session } from '../src/session.ts';
import { findImagePaths, MAX_IMAGE_BYTES, MAX_IMAGES, resolveImages } from '../src/vision.ts';
import { mockModel, tempDir, textTurn } from './helpers.ts';

/** The content parts of a message (none for a plain-text one). */
const partsOf = (m: ModelMessage | undefined) =>
  (m && typeof m.content !== 'string' ? m.content : []) as Array<{ type: string; data?: unknown }>;

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('vision: finding image paths in a prompt', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('mrig-vision-');
    writeFileSync(join(t.dir, 'shot.png'), PNG);
    writeFileSync(join(t.dir, 'My Photo.JPG'), PNG);
    writeFileSync(join(t.dir, 'notes.txt'), 'not an image');
    mkdirSync(join(t.dir, 'dir.png')); // a folder with an image name
  });
  afterEach(() => t.cleanup());

  test('relative, absolute, quoted and escaped paths; trailing punctuation; duplicates once', () => {
    const abs = join(t.dir, 'shot.png');
    const scan = findImagePaths(
      `what is in shot.png? Compare "${join(t.dir, 'My Photo.JPG')}" and My\\ Photo.JPG with ${abs}.`,
      t.dir,
    );
    expect(scan.images.map((i) => [i.shown, i.mediaType])).toEqual([
      ['shot.png', 'image/png'],
      [join(t.dir, 'My Photo.JPG'), 'image/jpeg'],
    ]);
    expect(scan.skipped).toEqual([]);
  });

  test('missing files, other extensions and folders are just text', () => {
    const scan = findImagePaths('make logo.png from notes.txt and dir.png', t.dir);
    expect(scan.images).toEqual([]);
    expect(scan.skipped).toEqual([]);
  });

  test('files over 5 MB and images past the limit are skipped with a reason', () => {
    writeFileSync(join(t.dir, 'huge.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect(findImagePaths('huge.png', t.dir).skipped).toEqual([
      { shown: 'huge.png', reason: '5.0 MB, over the 5 MB limit' },
    ]);
    const names = Array.from({ length: MAX_IMAGES + 1 }, (_, i) => `p${i}.png`);
    for (const n of names) writeFileSync(join(t.dir, n), PNG);
    const many = findImagePaths(names.join(' '), t.dir);
    expect(many.images).toHaveLength(MAX_IMAGES);
    expect(many.skipped).toEqual([
      { shown: `p${MAX_IMAGES}.png`, reason: `more than ${MAX_IMAGES} images in one message` },
    ]);
  });

  test('resolveImages: bytes with vision, a note without, a note when the file is gone', () => {
    const url = pathToFileURL(join(t.dir, 'shot.png'));
    const msgs = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'see' },
          { type: 'file' as const, data: url, mediaType: 'image/png' },
        ],
      },
      { role: 'assistant' as const, content: 'ok' },
    ];
    const withVision = resolveImages(msgs, true);
    const part = partsOf(withVision[0])[1];
    expect(part?.type).toBe('file');
    expect(Buffer.from(part?.data as Uint8Array).equals(PNG)).toBe(true);
    expect(withVision[1]).toBe(msgs[1]); // untouched messages are the same objects
    // After a session reload the URL is a string; it is still recognised.
    const reloaded = JSON.parse(JSON.stringify(msgs));
    expect(partsOf(resolveImages(reloaded, true)[0])[1]?.data).toBeInstanceOf(Uint8Array);
    const without = resolveImages(msgs, false)[0]?.content as Array<{
      type: string;
      text?: string;
    }>;
    expect(without[1]).toEqual({
      type: 'text',
      text: `[image ${join(t.dir, 'shot.png')}: not shown, this model has no vision]`,
    });
    rmSync(join(t.dir, 'shot.png'));
    const gone = resolveImages(msgs, true)[0]?.content as Array<{ type: string; text?: string }>;
    expect(gone[1]?.text).toMatch(/: the file is gone\]$/);
    // Base64 image data in a transcript is left alone.
    const b64 = [
      {
        role: 'user' as const,
        content: [{ type: 'file' as const, data: PNG.toString('base64'), mediaType: 'image/png' }],
      },
    ];
    expect(resolveImages(b64, true)[0]).toBe(b64[0]);
  });
});

describe('vision: through the runtime', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    mkdirSync(join(project.dir, '.git'));
    writeFileSync(join(project.dir, 'shot.png'), PNG);
    process.env.MRIG_HOME = home.dir;
    const fake = { kind: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'fake' };
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({ providers: { seeing: { ...fake, vision: true }, blind: fake } }),
    );
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  const make = (provider: string, turns: Parameters<typeof mockModel>[0], resume?: string) => {
    const notices: string[] = [];
    const model = mockModel(turns);
    const rt = new Runtime({
      cwd: project.dir,
      provider,
      languageModel: model,
      ...(resume ? { resume } : {}),
      ask: async () => 'no',
      events: { onText: () => {}, onNotice: (n) => notices.push(n) },
    });
    return { rt, model, notices };
  };
  /** The parts of the last user message in a model call. */
  const userParts = (model: ReturnType<typeof mockModel>, call: number) => {
    const prompt = model.doStreamCalls[call]?.prompt ?? [];
    const user = [...prompt].reverse().find((m) => m.role === 'user');
    return (user?.content ?? []) as Array<{
      type: string;
      text?: string;
      mediaType?: string;
      data?: unknown;
    }>;
  };

  test('a vision profile: the image part reaches the model; the session stores the path', async () => {
    const { rt, model, notices } = make('seeing', [
      textTurn('A white pixel.'),
      textTurn('Still a pixel.'),
    ]);
    await rt.agent.run('what is in shot.png?');
    const parts = userParts(model, 0);
    expect(parts[0]).toMatchObject({ type: 'text', text: 'what is in shot.png?' });
    expect(parts[1]).toMatchObject({ type: 'file', mediaType: 'image/png' });
    const data = parts[1]?.data as { type?: string; data?: Uint8Array } | Uint8Array;
    const bytes = data instanceof Uint8Array ? data : data?.data;
    expect(Buffer.from(bytes as Uint8Array).equals(PNG)).toBe(true);
    expect(notices).toEqual([]);
    rt.save();
    const file = readFileSync(join(home.dir, 'sessions', `${rt.session.meta.id}.jsonl`), 'utf8');
    expect(file).toContain(pathToFileURL(join(project.dir, 'shot.png')).href);
    expect(file).not.toContain(PNG.toString('base64')); // paths, not bytes
    const id = rt.session.meta.id;
    await rt.close();

    // Resumed: the image is read from disk again for the next request.
    const again = make('seeing', [textTurn('Yes.')], id);
    await again.rt.agent.run('and now?');
    const prompt = again.model.doStreamCalls[0]?.prompt ?? [];
    const first = prompt.find((m) => m.role === 'user')?.content as Array<{ type: string }>;
    expect(first.map((p) => p.type)).toEqual(['text', 'file']);
    again.rt.save();
    expect(Session.load(id).messages).toHaveLength(4);
    await again.rt.close();
  });

  test('a profile without vision: a clear notice, a text-only prompt, no crash', async () => {
    const { rt, model, notices } = make('blind', [textTurn('I cannot see images.')]);
    const result = await rt.agent.run('what is in shot.png?');
    expect(result.stop).toBe('done');
    expect(userParts(model, 0).map((p) => p.type)).toEqual(['text']);
    expect(notices).toEqual([
      'Image not attached: shot.png. blind/fake has no vision; set "vision": true on a profile whose model reads images, or switch with /provider.',
    ]);
    await rt.close();
  });

  test('switching to a model without vision turns earlier images into a note', async () => {
    const { rt, model } = make('seeing', [textTurn('A pixel.'), textTurn('Noted.')]);
    await rt.agent.run('look at shot.png');
    rt.switchModel('blind');
    rt.agent.opts.model = model; // keep the mock for the next request
    await rt.agent.run('what was it?');
    const first = model.doStreamCalls[1]?.prompt.find((m) => m.role === 'user')?.content as Array<{
      type: string;
      text?: string;
    }>;
    expect(first.map((p) => p.type)).toEqual(['text', 'text']);
    expect(first[1]?.text).toMatch(/shot\.png: not shown, this model has no vision\]$/);
    await rt.close();
  });

  test('the built-in Claude and OpenAI profiles have vision; local ones do not', async () => {
    const { rt } = make('seeing', []);
    expect(rt.config.providers.claude?.vision).toBe(true);
    expect(rt.config.providers.opus?.vision).toBe(true);
    expect(rt.config.providers.openai?.vision).toBe(true);
    expect(rt.config.providers.ollama?.vision).toBeUndefined();
    await rt.close();
  });
});
