import type { Experimental_VideoModelV4 as VideoModel } from '@ai-sdk/provider';
import { experimental_getVideoStatus, experimental_startVideo } from 'ai';
import { z } from 'zod';
import type { VideoConfig } from '../config.ts';
import { describeWarning, money, saveMedia } from './media.ts';
import { defineTool, type MrigTool, ToolError } from './types.ts';

const EXT: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

const inputSchema = z.object({
  prompt: z.string().describe('What the clip shows: subject, action, camera, style'),
  duration: z
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .describe('Seconds of video (default from the config)'),
  aspectRatio: z
    .string()
    .regex(/^\d+:\d+$/)
    .optional()
    .describe('W:H, e.g. 16:9 or 9:16 (default from the config)'),
  path: z
    .string()
    .optional()
    .describe('Where to save the clip (default: a new file in the videos folder)'),
});
type Input = z.infer<typeof inputSchema>;

/** Estimated USD for a clip: seconds × the configured price per second. */
export function videoCost(config: VideoConfig, seconds: number): number {
  return seconds * config.pricePerSecond;
}

/** The refusal when a job would cost more than the per-job cap, or undefined when it fits. */
export function overBudget(config: VideoConfig, seconds: number): string | undefined {
  const cost = videoCost(config, seconds);
  if (cost <= config.maxCostPerJob) return undefined;
  return `This ${seconds}-second clip would cost ${money(cost)}, over the per-job cap of $${config.maxCostPerJob.toFixed(2)} (video.maxCostPerJob). Nothing was started. Ask for a shorter clip, or raise the cap in the config.`;
}

const elapsed = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export interface VideoToolOptions {
  config: VideoConfig;
  model: VideoModel;
  /** Test seams: waiting, the clock, and downloading a finished clip from its URL. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  fetch?: typeof fetch;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

/**
 * Video generation (Track 3, T6), through the AI Gateway. It checks the per-job cost cap before
 * anything starts, starts the job, polls it, and saves the clip. Asks first, with the price.
 */
export function createVideoTool(opts: VideoToolOptions): MrigTool<Input> {
  const { config } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const download = opts.fetch ?? fetch;
  return defineTool<Input>({
    name: 'video',
    description: `Generate a short video clip from a text prompt with ${config.model} and save it. Takes minutes and costs money per second; a job over the cost cap is refused. Returns the saved path.`,
    inputSchema,
    readOnly: false,
    remote: true,
    summarize: (i) => {
      const seconds = i.duration ?? config.duration;
      const ratio = i.aspectRatio ?? config.aspectRatio;
      const p = i.prompt.length > 50 ? `${i.prompt.slice(0, 49)}…` : i.prompt;
      const cost = videoCost(config, seconds);
      return `video "${p}" (${seconds} s${ratio ? `, ${ratio}` : ''}, ${money(cost)}; cap $${config.maxCostPerJob.toFixed(2)}${cost > config.maxCostPerJob ? ', over the cap' : ''})`;
    },
    async execute(input, ctx) {
      if (!input.prompt.trim()) throw new ToolError('Empty prompt.');
      const seconds = input.duration ?? config.duration;
      const refusal = overBudget(config, seconds);
      if (refusal) throw new ToolError(refusal);
      const aspectRatio = (input.aspectRatio ?? config.aspectRatio) as VideoConfig['aspectRatio'];
      const started = now();
      let operation: Awaited<ReturnType<typeof experimental_startVideo>>['operation'];
      const warnings: string[] = [];
      try {
        const start = await experimental_startVideo({
          model: opts.model,
          prompt: input.prompt,
          n: 1,
          duration: seconds,
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(config.resolution ? { resolution: config.resolution } : {}),
          abortSignal: ctx.signal,
          maxRetries: 1,
        });
        operation = start.operation;
        warnings.push(...start.warnings.map(describeWarning));
      } catch (err) {
        throw new ToolError(`Could not start the video job: ${(err as Error).message}`);
      }

      const deadline = started + config.timeoutMinutes * 60_000;
      for (;;) {
        if (ctx.signal?.aborted)
          throw new ToolError('Stopped. The provider may still finish the job, and bill for it.');
        let status: Awaited<ReturnType<typeof experimental_getVideoStatus>>;
        try {
          status = await experimental_getVideoStatus(opts.model, {
            operation,
            abortSignal: ctx.signal,
          });
        } catch (err) {
          throw new ToolError(`Could not check the video job: ${(err as Error).message}`);
        }
        if (status.status === 'error') throw new ToolError(`The video job failed: ${status.error}`);
        if (status.status === 'completed') {
          const video = status.videos[0];
          if (!video) throw new ToolError('The video job finished without a video.');
          warnings.push(...status.warnings.map(describeWarning));
          let bytes: Uint8Array;
          if (video.type === 'binary') bytes = video.data;
          else if (video.type === 'base64')
            bytes = new Uint8Array(Buffer.from(video.data, 'base64'));
          else {
            const res = await download(video.url, ctx.signal ? { signal: ctx.signal } : {});
            if (!res.ok)
              throw new ToolError(
                `The clip finished, but downloading it failed: HTTP ${res.status}.`,
              );
            bytes = new Uint8Array(await res.arrayBuffer());
          }
          const cost = videoCost(config, seconds);
          ctx.recordMedia?.('video', 1, cost);
          const saved = saveMedia({
            cwd: ctx.cwd,
            dir: config.dir,
            ...(input.path ? { requested: input.path } : {}),
            text: input.prompt,
            ext: EXT[video.mediaType] ?? '.mp4',
            now: new Date(now()),
            bytes,
            onSaved: (p) => ctx.recordFile?.(p, 'video'),
          });
          return [
            `Saved ${saved} (${config.model}, ${seconds} s, ${money(cost)}, the job took ${elapsed(now() - started)})`,
            ...warnings.map((w) => `warning: ${w}`),
          ].join('\n');
        }
        if (now() + config.pollSeconds * 1000 > deadline) {
          throw new ToolError(
            `The video job is still running after ${config.timeoutMinutes} minutes, so mrig stopped waiting. The provider may still finish it, and bill for it.`,
          );
        }
        try {
          await sleep(config.pollSeconds * 1000, ctx.signal);
        } catch {
          throw new ToolError('Stopped. The provider may still finish the job, and bill for it.');
        }
      }
    },
  });
}
