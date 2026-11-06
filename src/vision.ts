/**
 * Vision input (Track 3, T3): image paths in a prompt reach vision-capable models as image files
 * (AI SDK `file` parts with an image/* media type; the separate `image` part is deprecated).
 *
 * A path is attached when it names an existing .png, .jpg, .jpeg, .gif or .webp file, relative
 * to the working directory, absolute, or under ~/. Quoted paths and backslash-escaped spaces (as
 * a terminal pastes a dragged file) work. The path also stays in the text, so the model knows
 * the file's name. A path that doesn't exist is ordinary text ("make logo.png" attaches nothing).
 *
 * Sessions store paths, not bytes: the transcript keeps a file:// URL, and `resolveImages` reads
 * the file just before each request. A profile without `vision: true` never gets image bytes:
 * new images are not attached (with a notice), and earlier ones become a one-line text note.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FilePart, ModelMessage, TextPart } from 'ai';

export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Anthropic's per-image limit; larger files are skipped with a notice. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 20;

export interface FoundImage {
  /** Absolute path. */
  path: string;
  /** As written in the prompt. */
  shown: string;
  mediaType: string;
}

export interface ImageScan {
  images: FoundImage[];
  skipped: Array<{ shown: string; reason: string }>;
}

/** Words of the prompt: "quoted", 'quoted', or unquoted with \-escaped spaces. */
const TOKEN = /"([^"]+)"|'([^']+)'|((?:\\ |\S)+)/g;

export function findImagePaths(text: string, cwd: string): ImageScan {
  const images: FoundImage[] = [];
  const skipped: ImageScan['skipped'] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    const quoted = m[1] ?? m[2];
    // Unquoted: unescape "\ ", and drop punctuation after the name ("see shot.png.").
    const raw = quoted ?? (m[3] ?? '').replaceAll('\\ ', ' ').replace(/[.,;:!?)\]]+$/, '');
    const mediaType = IMAGE_TYPES[extname(raw).toLowerCase()];
    if (!mediaType) continue;
    const expanded = raw === '~' || /^~[\\/]/.test(raw) ? join(homedir(), raw.slice(1)) : raw;
    const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    if (seen.has(path) || !existsSync(path) || !statSync(path).isFile()) continue;
    seen.add(path);
    const size = statSync(path).size;
    if (size > MAX_IMAGE_BYTES) {
      skipped.push({
        shown: raw,
        reason: `${(size / 1024 / 1024).toFixed(1)} MB, over the 5 MB limit`,
      });
    } else if (images.length >= MAX_IMAGES) {
      skipped.push({ shown: raw, reason: `more than ${MAX_IMAGES} images in one message` });
    } else {
      images.push({ path, shown: raw, mediaType });
    }
  }
  return { images, skipped };
}

/** The part kept in the transcript: a file URL (a path), never the bytes. */
export function imagePart(img: FoundImage): FilePart {
  return {
    type: 'file',
    data: pathToFileURL(img.path),
    mediaType: img.mediaType,
    filename: basename(img.path),
  };
}

const isImageFile = (p: { type: string; mediaType?: string }) =>
  p.type === 'file' && (p.mediaType ?? '').startsWith('image/');

/** A file URL from the transcript: a URL object, or its string form after a session reload. */
function fileUrlOf(data: unknown): URL | undefined {
  if (data instanceof URL) return data.protocol === 'file:' ? data : undefined;
  // A base64 string can never contain "://", so this cannot misread image data.
  if (typeof data === 'string' && data.startsWith('file://')) return new URL(data);
  return undefined;
}

/**
 * The messages to send: file-URL images become bytes when the model has vision, and a text note
 * when it doesn't or the file is gone. Other messages pass through unchanged (same objects).
 */
export function resolveImages(messages: ModelMessage[], vision: boolean): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== 'user' || typeof m.content === 'string') return m;
    const local = (p: (typeof m.content)[number]) =>
      p.type === 'file' && isImageFile(p) ? fileUrlOf(p.data) : undefined;
    if (!m.content.some(local)) return m;
    const content = m.content.map((p): TextPart | FilePart | typeof p => {
      const url = local(p);
      if (!url || p.type !== 'file') return p;
      const path = fileURLToPath(url);
      if (!vision) {
        return { type: 'text', text: `[image ${path}: not shown, this model has no vision]` };
      }
      if (!existsSync(path)) return { type: 'text', text: `[image ${path}: the file is gone]` };
      return { ...p, data: readFileSync(path) };
    });
    return { ...m, content } as ModelMessage;
  });
}
