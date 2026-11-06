import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockSpeechModelV4, MockTranscriptionModelV4 } from 'ai/test';
import { loadConfig } from '../src/config.ts';
import { Runtime } from '../src/runtime.ts';
import {
  createSpeakTool,
  createTranscribeTool,
  MAX_SPEECH_CHARS,
  speechPrice,
  transcriptionPrice,
} from '../src/tools/speech.ts';
import { runCommand } from '../src/ui/commands.ts';
import { ctx, mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A minimal WAV file whose data is the text itself, so a mock transcriber can read it back. */
function fakeWav(text: string): Uint8Array {
  const data = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}
const wavText = (audio: Uint8Array) => Buffer.from(audio.slice(44)).toString('utf8');

const response = { timestamp: new Date(0), modelId: 'mock', headers: undefined };

function mockSpeech(opts: { fail?: string } = {}) {
  const calls: Array<{ text: string; voice?: string; outputFormat?: string }> = [];
  const model = new MockSpeechModelV4({
    doGenerate: async (o) => {
      calls.push({ text: o.text, voice: o.voice, outputFormat: o.outputFormat });
      if (opts.fail) throw new Error(opts.fail);
      return { audio: fakeWav(o.text), warnings: [], response };
    },
  });
  return { model, calls };
}

function mockTranscriber(seconds: number | undefined = 30) {
  const calls: Array<{ mediaType: string; bytes: number }> = [];
  const model = new MockTranscriptionModelV4({
    doGenerate: async (o) => {
      const audio = typeof o.audio === 'string' ? Buffer.from(o.audio, 'base64') : o.audio;
      calls.push({ mediaType: o.mediaType, bytes: audio.length });
      return {
        text: wavText(audio),
        segments: [],
        language: 'en',
        durationInSeconds: seconds,
        warnings: [],
        response,
      };
    },
  });
  return { model, calls };
}

const SPEECH = {
  profile: 'openai',
  model: 'mock-tts',
  voice: 'alloy',
  format: 'wav',
  pricePerMillionChars: 15,
  dir: 'audio',
};
const STT = { profile: 'openai', model: 'mock-stt', pricePerMinute: 0.006 };
const NOW = () => new Date('2026-11-06T09:15:00Z');

describe('speech: price math', () => {
  test('per character for speech, per minute for transcription', () => {
    expect(speechPrice(SPEECH, 1_000_000)).toBe(15);
    expect(speechPrice(SPEECH, 2000)).toBeCloseTo(0.03, 10);
    expect(speechPrice({ ...SPEECH, pricePerMillionChars: undefined }, 2000)).toBeUndefined();
    expect(transcriptionPrice(STT, 90)).toBeCloseTo(0.009, 10);
    expect(transcriptionPrice(STT, undefined)).toBeUndefined(); // no duration, no price
    expect(transcriptionPrice({ ...STT, pricePerMinute: undefined }, 60)).toBeUndefined();
  });
});

describe('speech: the tools', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('mrig-speech-');
  });
  afterEach(() => t.cleanup());

  test('speak: saves the audio, returns the path and records the cost', async () => {
    const { model, calls } = mockSpeech();
    const tool = createSpeakTool({ config: SPEECH, model, remote: true, now: NOW });
    expect(tool.readOnly).toBe(false);
    expect(tool.summarize({ text: 'Hello there' })).toBe(
      'speak "Hello there" (11 characters, voice alloy, ~$0.0002)',
    );
    const media: Array<[string, number, number | undefined]> = [];
    const out = await tool.execute(
      { text: 'Hello there', voice: 'nova' },
      ctx(t.dir, { recordMedia: (k, n, usd) => media.push([k, n, usd]) }),
    );
    expect(calls).toEqual([{ text: 'Hello there', voice: 'nova', outputFormat: 'wav' }]);
    expect(out).toBe(
      'Saved audio/20261106-091500-hello-there.wav (mock-tts, voice nova, 11 characters, ~$0.0002)',
    );
    expect(wavText(readFileSync(join(t.dir, 'audio', '20261106-091500-hello-there.wav')))).toBe(
      'Hello there',
    );
    expect(media).toEqual([['speech', 1, expect.closeTo(0.000165, 10)]]);
  });

  test('speak: limits and failures are tool errors, and nothing is written', async () => {
    const tool = createSpeakTool({
      config: SPEECH,
      model: mockSpeech({ fail: 'bad voice' }).model,
      remote: true,
    });
    await expect(tool.execute({ text: 'hi' }, ctx(t.dir))).rejects.toThrow(
      'Speech failed: bad voice',
    );
    await expect(tool.execute({ text: ' ' }, ctx(t.dir))).rejects.toThrow('Empty text.');
    await expect(
      tool.execute({ text: 'x'.repeat(MAX_SPEECH_CHARS + 1) }, ctx(t.dir)),
    ).rejects.toThrow(/the limit is 4096\. Split it/);
    expect(existsSync(join(t.dir, 'audio'))).toBe(false);
  });

  test('transcribe: reads the file, returns the text, prices the duration', async () => {
    writeFileSync(join(t.dir, 'note.wav'), fakeWav('Buy milk.'));
    const { model, calls } = mockTranscriber(90);
    const tool = createTranscribeTool({ config: STT, model, remote: true });
    expect(tool.summarize({ path: 'note.wav' })).toBe(
      'transcribe note.wav (mock-stt, ~$0.006/min)',
    );
    const media: Array<[string, number, number | undefined]> = [];
    const out = await tool.execute(
      { path: 'note.wav' },
      ctx(t.dir, { recordMedia: (k, n, usd) => media.push([k, n, usd]) }),
    );
    expect(out).toBe(
      'Transcript of note.wav (mock-stt, 90.0 s, language en, ~$0.0090):\nBuy milk.',
    );
    expect(calls).toEqual([{ mediaType: 'audio/wav', bytes: 53 }]); // the SDK detects the type
    expect(media).toEqual([['transcription', 1, expect.closeTo(0.009, 10)]]);
  });

  test('transcribe: missing files, folders and files over 25 MB are refused before any call', async () => {
    const { model, calls } = mockTranscriber();
    const tool = createTranscribeTool({ config: STT, model, remote: true });
    await expect(tool.execute({ path: 'nope.wav' }, ctx(t.dir))).rejects.toThrow(
      'File not found: nope.wav',
    );
    mkdirSync(join(t.dir, 'dir.wav'));
    await expect(tool.execute({ path: 'dir.wav' }, ctx(t.dir))).rejects.toThrow(
      'File not found: dir.wav',
    );
    writeFileSync(join(t.dir, 'big.wav'), Buffer.alloc(25 * 1024 * 1024 + 1));
    await expect(tool.execute({ path: 'big.wav' }, ctx(t.dir))).rejects.toThrow(
      'big.wav is 25.0 MB; the limit is 25 MB.',
    );
    expect(calls).toEqual([]);
  });
});

describe('speech: config, permissions and the local round trip', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  const local = {
    kind: 'openai-compatible',
    baseURL: 'http://localhost:8000/v1',
    model: 'chat',
    pricing: { input: 0, output: 0 },
  };
  const writeConfig = (extra: Record<string, unknown>) =>
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({ providers: { local }, ...extra }),
    );
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    mkdirSync(join(project.dir, '.git'));
    process.env.MRIG_HOME = home.dir;
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  const make = (
    turns: Parameters<typeof mockModel>[0],
    answer: 'yes' | 'no',
    extra: { offline?: boolean } = {},
  ) => {
    const asked: string[] = [];
    const notices: string[] = [];
    const speech = mockSpeech();
    const stt = mockTranscriber(4);
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'local',
      languageModel: mockModel(turns),
      speechModel: speech.model,
      transcriptionModel: stt.model,
      ...extra,
      ask: async (r) => {
        asked.push(r.summary);
        return answer;
      },
      events: { onText: () => {}, onNotice: (n) => notices.push(n) },
    });
    return { rt, asked, notices, speech, stt };
  };

  test('config validation; a project config cannot set either block', () => {
    writeConfig({
      speech: { model: 'tts-1' },
      transcription: { model: 'whisper-1', pricePerMinute: 0.006 },
    });
    const cfg = loadConfig({ cwd: project.dir, env: {} });
    expect(cfg.speech).toEqual({ profile: 'openai', model: 'tts-1', format: 'mp3', dir: 'audio' });
    expect(cfg.transcription).toEqual({
      profile: 'openai',
      model: 'whisper-1',
      pricePerMinute: 0.006,
    });
    for (const [bad, message] of [
      [{ speech: 'tts-1' }, /"speech" must be an object/],
      [{ speech: {} }, /"speech.model" must be a model id/],
      [{ speech: { model: 'm', voice: 3 } }, /"speech.voice" must be a string/],
      [
        { transcription: { model: 'm', pricePerMinute: 'cheap' } },
        /"transcription.pricePerMinute" must be a number/,
      ],
    ] as const) {
      writeConfig(bad);
      expect(() => loadConfig({ cwd: project.dir, env: {} })).toThrow(message);
    }
    writeConfig({});
    mkdirSync(join(project.dir, '.mrig'));
    writeFileSync(
      join(project.dir, '.mrig', 'config.json'),
      JSON.stringify({ speech: { model: 'm' }, transcription: { model: 'm' } }),
    );
    const project_ = loadConfig({ cwd: project.dir, env: {} });
    expect(project_.speech).toBeUndefined();
    expect(project_.transcription).toBeUndefined();
    expect(project_.projectIgnored).toEqual(['speech.model', 'transcription.model']);
  });

  test('both ask first; a denial calls nothing; speak:* and transcribe:* skip the prompt', async () => {
    writeConfig({
      speech: { ...SPEECH, profile: 'local' },
      transcription: { ...STT, profile: 'local' },
    });
    writeFileSync(join(project.dir, 'note.wav'), fakeWav('hi'));
    const denied = make(
      [
        toolTurn('speak', '{"text":"Hello"}', 'c1'),
        toolTurn('transcribe', '{"path":"note.wav"}', 'c2'),
        textTurn('ok'),
      ],
      'no',
    );
    await denied.rt.agent.run('say hello, then read note.wav');
    expect(denied.asked).toEqual([
      'speak "Hello" (5 characters, voice alloy, ~$0.0001)',
      'transcribe note.wav (mock-stt, ~$0.006/min)',
    ]);
    expect(denied.speech.calls).toEqual([]);
    expect(denied.stt.calls).toEqual([]);
    await denied.rt.close();

    writeConfig({
      speech: { ...SPEECH, profile: 'local' },
      transcription: { ...STT, profile: 'local' },
      permissions: { allow: ['speak:*', 'transcribe:*'] },
    });
    const allowed = make(
      [
        toolTurn('speak', '{"text":"Hello"}', 'c1'),
        toolTurn('transcribe', '{"path":"note.wav"}', 'c2'),
        textTurn('ok'),
      ],
      'no',
    );
    await allowed.rt.agent.run('go');
    expect(allowed.asked).toEqual([]);
    expect(allowed.speech.calls).toHaveLength(1);
    expect(allowed.stt.calls).toHaveLength(1);
    const out: string[] = [];
    await runCommand(allowed.rt, '/cost', {
      write: (s) => out.push(plain(s)),
      busy: (run) => run(new AbortController().signal),
    });
    expect(out.join('')).toContain('speech: 1 · ~$0.0001');
    expect(out.join('')).toContain('transcriptions: 1 · ~$0.0004');
    await allowed.rt.close();
  });

  test('local round trip, offline: speak, then transcribe the saved file back to the text', async () => {
    writeConfig({
      speech: { ...SPEECH, profile: 'local' },
      transcription: { ...STT, profile: 'local' },
      permissions: { allow: ['speak:*', 'transcribe:*'] },
    });
    const { rt, speech, stt } = make(
      [
        toolTurn('speak', '{"text":"The river is high today.","path":"audio/river.wav"}', 'c1'),
        toolTurn('transcribe', '{"path":"audio/river.wav"}', 'c2'),
        textTurn('Round trip done.'),
      ],
      'no',
      { offline: true },
    );
    expect(rt.offline).toBeDefined();
    const names = rt.agent.opts.tools.map((t) => t.name);
    expect(names).toContain('speak'); // local generators stay in offline mode
    expect(names).toContain('transcribe');
    await rt.agent.run('read it aloud, then transcribe it');
    expect(speech.calls[0]?.text).toBe('The river is high today.');
    expect(stt.calls).toEqual([
      { mediaType: 'audio/wav', bytes: 44 + 'The river is high today.'.length },
    ]);
    const results = rt.agent.messages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
      .map((p) => (p.type === 'tool-result' && p.output.type === 'text' ? p.output.value : ''));
    expect(results[0]).toMatch(/^Saved audio\/river\.wav /);
    expect(results[1]).toBe(
      'Transcript of audio/river.wav (mock-stt, 4.0 s, language en, ~$0.0004):\nThe river is high today.',
    );
    await rt.close();
  });

  test('offline: cloud speech and transcription are dropped', async () => {
    writeConfig({ speech: { model: 'tts-1' }, transcription: { model: 'whisper-1' } });
    const { rt } = make([], 'no', { offline: true });
    const names = rt.agent.opts.tools.map((t) => t.name);
    expect(names).not.toContain('speak');
    expect(names).not.toContain('transcribe');
    await rt.close();
  });

  test('an Anthropic profile for speech is a notice, and the other tool still works', async () => {
    writeConfig({
      speech: { profile: 'claude', model: 'x' },
      transcription: { ...STT, profile: 'local' },
    });
    const notices: string[] = [];
    const rt = new Runtime({
      cwd: project.dir,
      provider: 'local',
      languageModel: mockModel([]),
      transcriptionModel: mockTranscriber().model,
      ask: async () => 'no',
      events: { onText: () => {}, onNotice: (n) => notices.push(n) },
    });
    const names = rt.agent.opts.tools.map((t) => t.name);
    expect(names).not.toContain('speak');
    expect(names).toContain('transcribe');
    expect(notices).toEqual([
      'The speak tool is off: Anthropic has no speech models. Point the speech profile at an openai or openai-compatible profile.',
    ]);
    await rt.close();
  });
});
