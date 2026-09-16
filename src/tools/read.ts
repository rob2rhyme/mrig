import { readdirSync, statSync } from 'node:fs';
import { z } from 'zod';
import { displayPath, resolvePath } from '../util/paths.ts';
import { humanBytes, looksBinary } from '../util/text.ts';
import { defineTool, ToolError } from './types.ts';

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

const schema = z.object({
  path: z
    .string()
    .describe('File or directory path (absolute, or relative to the working directory)'),
  offset: z.number().int().min(1).optional().describe('1-based line number to start from'),
  limit: z.number().int().min(1).optional().describe(`Max lines to return (default ${MAX_LINES})`),
});

export const readTool = defineTool<z.infer<typeof schema>>({
  name: 'read',
  description:
    'Read a text file with line numbers (like cat -n), or list a directory. Use offset/limit for large files. Always read a file before editing it.',
  inputSchema: schema,
  readOnly: true,
  summarize: (i) => `read ${i.path}${i.offset ? ` from line ${i.offset}` : ''}`,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      throw new ToolError(`File not found: ${displayPath(ctx.cwd, abs)}`);
    }
    if (st.isDirectory()) {
      const entries = readdirSync(abs, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return `Directory ${displayPath(ctx.cwd, abs)} (${entries.length} entries):\n${entries.join('\n')}`;
    }
    const file = Bun.file(abs);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (looksBinary(bytes)) {
      return `Binary file (${humanBytes(bytes.length)}); not shown.`;
    }
    const text = new TextDecoder().decode(bytes);
    const lines = text.split('\n');
    const start = Math.max(1, input.offset ?? 1);
    const limit = Math.min(input.limit ?? MAX_LINES, MAX_LINES);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const width = String(start + slice.length - 1).length;
    const numbered = slice
      .map((line, i) => {
        const n = String(start + i).padStart(width, ' ');
        const l =
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]`
            : line;
        return `${n}\t${l}`;
      })
      .join('\n');
    const remaining = lines.length - (start - 1 + slice.length);
    const footer =
      remaining > 0
        ? `\n\n[${remaining} more lines; call read with offset=${start + slice.length}]`
        : '';
    return numbered + footer;
  },
});
