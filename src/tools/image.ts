import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { generateImage, type ImageModel } from 'ai';
import { z } from 'zod';
import type { ImageConfig } from '../config.ts';
import { displayPath } from '../util/paths.ts';
import { defineTool, type MrigTool, ToolError } from './types.ts';

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const inputSchema = z.object({
  prompt: z.string().describe('What to draw: subject, style, composition'),
  n: z.number().int().min(1).max(4).optional().describe('How many images (default 1, at most 4)'),
  size: z
    .string()
    .regex(/^\d+x\d+$/)
    .optional()
    .describe('WIDTHxHEIGHT, e.g. 1024x1024 (default from the config)'),
  path: z
    .string()
    .optional()
    .describe('Where to save the first image (default: a new file in the images folder)'),
});
type Input = z.infer<typeof inputSchema>;

/** One line for a provider warning (an unsupported size, for example). */
function describeWarning(w: object): string {
  const r = w as { type?: string; message?: string; feature?: string; details?: string };
  if (r.message) return r.message;
  if (r.feature) return `${r.type ?? 'note'}: ${r.feature}${r.details ? ` (${r.details})` : ''}`;
  return JSON.stringify(w);
}

/** USD for `n` images, or undefined when the config sets no price. */
export function imagePrice(config: ImageConfig, n: number): number | undefined {
  return config.pricePerImage === undefined ? undefined : config.pricePerImage * n;
}

const money = (usd: number | undefined) =>
  usd === undefined ? 'price unknown' : `~$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;

/** A file name from the prompt: 20261106-091500-a-red-fox.png. */
export function defaultImageName(prompt: string, now: Date, ext: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const slug = prompt
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${stamp}${slug ? `-${slug}` : ''}${ext}`;
}

/** `base.png`, or `base-2.png`, `base-3.png`… so an existing file is never overwritten. */
function freePath(path: string): string {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let i = 2; ; i++) {
    const p = `${stem}-${i}${ext}`;
    if (!existsSync(p)) return p;
  }
}

export interface ImageToolOptions {
  config: ImageConfig;
  model: ImageModel;
  /** The provider is on another machine; offline mode drops the tool. */
  remote: boolean;
  now?: () => Date;
}

/**
 * Image generation (Track 3, T4). Built per runtime from the config's `image` block; absent when
 * none is set. It is not read-only, so it asks before each call (with the price) unless an
 * `image:*` rule allows it. Files go on disk; the result, and so the session, holds the path.
 */
export function createImageTool(opts: ImageToolOptions): MrigTool<Input> {
  const { config } = opts;
  return defineTool<Input>({
    name: 'image',
    description: `Generate images from a text prompt with ${config.model} and save them as files. Returns the saved paths. Costs money per image.`,
    inputSchema,
    readOnly: false,
    remote: opts.remote,
    summarize: (i) => {
      const n = i.n ?? 1;
      const size = i.size ?? config.size ?? 'default size';
      const p = i.prompt.length > 60 ? `${i.prompt.slice(0, 59)}…` : i.prompt;
      return `image "${p}" (${n} × ${size}, ${money(imagePrice(config, n))})`;
    },
    async execute(input, ctx) {
      if (!input.prompt.trim()) throw new ToolError('Empty prompt.');
      const n = input.n ?? 1;
      const size = (input.size ?? config.size) as `${number}x${number}` | undefined;
      let result: Awaited<ReturnType<typeof generateImage>>;
      try {
        result = await generateImage({
          model: opts.model,
          prompt: input.prompt,
          n,
          ...(size ? { size } : {}),
          abortSignal: ctx.signal,
          maxRetries: 1,
        });
      } catch (err) {
        throw new ToolError(`Image generation failed: ${(err as Error).message}`);
      }
      const images = result.images;
      if (images.length === 0) throw new ToolError('The provider returned no image.');
      const price = imagePrice(config, images.length);
      ctx.recordMedia?.('image', images.length, price);
      const now = (opts.now ?? (() => new Date()))();
      const saved: string[] = [];
      images.forEach((img, i) => {
        const ext = EXT[img.mediaType] ?? '.png';
        const requested = input.path && i === 0 ? input.path : undefined;
        const base = requested
          ? isAbsolute(requested)
            ? requested
            : resolve(ctx.cwd, requested)
          : join(resolve(ctx.cwd, config.dir), defaultImageName(input.prompt, now, ext));
        const path = freePath(base);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, img.uint8Array);
        saved.push(displayPath(ctx.cwd, path));
      });
      const warnings = result.warnings.map((w) => `warning: ${describeWarning(w)}`);
      return [
        `Saved ${saved.length} image${saved.length === 1 ? '' : 's'} (${config.model}${size ? `, ${size}` : ''}, ${money(price)}):`,
        ...saved.map((p) => `- ${p}`),
        ...warnings,
      ].join('\n');
    },
  });
}
