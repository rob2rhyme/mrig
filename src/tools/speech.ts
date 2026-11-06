import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { generateSpeech, type SpeechModel, type TranscriptionModel, transcribe } from 'ai';
import { z } from 'zod';
import type { SpeechConfig, TranscriptionConfig } from '../config.ts';
import { displayPath } from '../util/paths.ts';
import { truncateMiddle } from '../util/text.ts';
import { describeWarning, money, saveMedia } from './media.ts';
import { defineTool, type MrigTool, ToolError } from './types.ts';

/** OpenAI's limits: 4,096 characters per speech request, 25 MB per transcription upload. */
export const MAX_SPEECH_CHARS = 4096;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** USD for speaking `chars` characters, or undefined without a price. */
export function speechPrice(config: SpeechConfig, chars: number): number | undefined {
  return config.pricePerMillionChars === undefined
    ? undefined
    : (config.pricePerMillionChars * chars) / 1_000_000;
}

/** USD for `seconds` of audio, or undefined without a price or a duration. */
export function transcriptionPrice(
  config: TranscriptionConfig,
  seconds: number | undefined,
): number | undefined {
  if (config.pricePerMinute === undefined || seconds === undefined) return undefined;
  return (config.pricePerMinute * seconds) / 60;
}

const speakInput = z.object({
  text: z.string().describe(`The text to read aloud (at most ${MAX_SPEECH_CHARS} characters)`),
  voice: z
    .string()
    .optional()
    .describe('A voice name the provider knows (default from the config)'),
  path: z
    .string()
    .optional()
    .describe('Where to save the audio (default: a new file in the audio folder)'),
});
type SpeakInput = z.infer<typeof speakInput>;

export interface SpeakToolOptions {
  config: SpeechConfig;
  model: SpeechModel;
  remote: boolean;
  now?: () => Date;
}

/**
 * Text to speech (Track 3, T5). Saves an audio file and returns its path. Asks first, with the
 * price, unless a `speak:*` rule allows it.
 */
export function createSpeakTool(opts: SpeakToolOptions): MrigTool<SpeakInput> {
  const { config } = opts;
  return defineTool<SpeakInput>({
    name: 'speak',
    description: `Read text aloud with ${config.model} and save it as an audio file. Returns the saved path.`,
    inputSchema: speakInput,
    readOnly: false,
    remote: opts.remote,
    summarize: (i) => {
      const t = i.text.length > 50 ? `${i.text.slice(0, 49)}…` : i.text;
      const voice = i.voice ?? config.voice;
      return `speak "${t}" (${i.text.length} characters${voice ? `, voice ${voice}` : ''}, ${money(speechPrice(config, i.text.length))})`;
    },
    async execute(input, ctx) {
      if (!input.text.trim()) throw new ToolError('Empty text.');
      if (input.text.length > MAX_SPEECH_CHARS) {
        throw new ToolError(
          `The text has ${input.text.length} characters; the limit is ${MAX_SPEECH_CHARS}. Split it and speak each part.`,
        );
      }
      const voice = input.voice ?? config.voice;
      let result: Awaited<ReturnType<typeof generateSpeech>>;
      try {
        result = await generateSpeech({
          model: opts.model,
          text: input.text,
          ...(voice ? { voice } : {}),
          outputFormat: config.format,
          abortSignal: ctx.signal,
          maxRetries: 1,
        });
      } catch (err) {
        throw new ToolError(`Speech failed: ${(err as Error).message}`);
      }
      const price = speechPrice(config, input.text.length);
      ctx.recordMedia?.('speech', 1, price);
      const format = result.audio.format || config.format;
      const saved = saveMedia({
        cwd: ctx.cwd,
        dir: config.dir,
        ...(input.path ? { requested: input.path } : {}),
        text: input.text,
        ext: `.${format}`,
        now: (opts.now ?? (() => new Date()))(),
        bytes: result.audio.uint8Array,
        onSaved: (p) => ctx.recordFile?.(p, 'audio'),
      });
      return [
        `Saved ${saved} (${config.model}${voice ? `, voice ${voice}` : ''}, ${input.text.length} characters, ${money(price)})`,
        ...result.warnings.map((w) => `warning: ${describeWarning(w)}`),
      ].join('\n');
    },
  });
}

const transcribeInput = z.object({
  path: z.string().describe('The audio file to transcribe (mp3, wav, m4a, webm, …)'),
});
type TranscribeInput = z.infer<typeof transcribeInput>;

export interface TranscribeToolOptions {
  config: TranscriptionConfig;
  model: TranscriptionModel;
  remote: boolean;
}

/**
 * Speech to text (Track 3, T5). Sends an audio file to the configured provider and returns the
 * text. Asks first, since the audio leaves this machine unless the provider is local.
 */
export function createTranscribeTool(opts: TranscribeToolOptions): MrigTool<TranscribeInput> {
  const { config } = opts;
  const rate =
    config.pricePerMinute === undefined ? 'price unknown' : `~$${config.pricePerMinute}/min`;
  return defineTool<TranscribeInput>({
    name: 'transcribe',
    description: `Transcribe an audio file to text with ${config.model}. Returns the text.`,
    inputSchema: transcribeInput,
    readOnly: false,
    remote: opts.remote,
    summarize: (i) => `transcribe ${i.path} (${config.model}, ${rate})`,
    async execute(input, ctx) {
      const path = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
      if (!existsSync(path) || !statSync(path).isFile())
        throw new ToolError(`File not found: ${input.path}`);
      const size = statSync(path).size;
      if (size > MAX_AUDIO_BYTES) {
        throw new ToolError(
          `${input.path} is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is 25 MB.`,
        );
      }
      let result: Awaited<ReturnType<typeof transcribe>>;
      try {
        result = await transcribe({
          model: opts.model,
          audio: readFileSync(path),
          abortSignal: ctx.signal,
          maxRetries: 1,
        });
      } catch (err) {
        throw new ToolError(`Transcription failed: ${(err as Error).message}`);
      }
      const seconds = result.durationInSeconds;
      const price = transcriptionPrice(config, seconds);
      ctx.recordMedia?.('transcription', 1, price);
      const facts = [
        config.model,
        ...(seconds !== undefined ? [`${seconds.toFixed(1)} s`] : []),
        ...(result.language ? [`language ${result.language}`] : []),
        money(price),
      ];
      const text = [
        `Transcript of ${displayPath(ctx.cwd, path)} (${facts.join(', ')}):`,
        result.text.trim() || '(no speech found)',
        ...result.warnings.map((w) => `warning: ${describeWarning(w)}`),
      ].join('\n');
      return truncateMiddle(text, ctx.maxOutputChars);
    },
  });
}
