import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { displayPath, resolvePath } from '../util/paths.ts';
import { humanBytes } from '../util/text.ts';
import { defineTool } from './types.ts';

const schema = z.object({
  path: z.string().describe('File path to create or overwrite'),
  content: z.string().describe('Full file contents'),
});

export const writeTool = defineTool<z.infer<typeof schema>>({
  name: 'write',
  description:
    'Create a new file or overwrite an existing one with the given content. Parent directories are created. Prefer `edit` for changing parts of an existing file.',
  inputSchema: schema,
  readOnly: false,
  summarize: (i) => `write ${i.path} (${i.content.split('\n').length} lines)`,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    const existed = existsSync(abs);
    mkdirSync(dirname(abs), { recursive: true });
    await Bun.write(abs, input.content);
    const size = humanBytes(Buffer.byteLength(input.content));
    return `${existed ? 'Overwrote' : 'Created'} ${displayPath(ctx.cwd, abs)} (${size}).`;
  },
});
