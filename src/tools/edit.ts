import { existsSync } from 'node:fs';
import { z } from 'zod';
import { displayPath, resolvePath } from '../util/paths.ts';
import { defineTool, ToolError } from './types.ts';

const schema = z.object({
  path: z.string().describe('File to edit'),
  old_string: z
    .string()
    .describe('Exact text to replace. Must match exactly once unless replace_all is true.'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
});

function countOccurrences(hay: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = hay.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Produce a short before/after context snippet around the first replacement. */
export function editSnippet(after: string, newString: string, context = 3): string {
  const idx = after.indexOf(newString);
  if (idx === -1) return '';
  const lines = after.split('\n');
  const lineNo = after.slice(0, idx).split('\n').length; // 1-based
  const newLines = newString.split('\n').length;
  const from = Math.max(1, lineNo - context);
  const to = Math.min(lines.length, lineNo + newLines - 1 + context);
  const width = String(to).length;
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(width, ' ')}\t${l}`)
    .join('\n');
}

export const editTool = defineTool<z.infer<typeof schema>>({
  name: 'edit',
  description:
    'Replace an exact string in a file. old_string must appear exactly once (include enough surrounding lines to make it unique), or set replace_all to change every occurrence. Read the file first so old_string matches exactly, including indentation.',
  inputSchema: schema,
  readOnly: false,
  summarize: (i) =>
    `edit ${i.path} (${i.replace_all ? 'replace all' : 'replace'} ${i.old_string.split('\n').length} → ${i.new_string.split('\n').length} lines)`,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    if (!existsSync(abs)) throw new ToolError(`File not found: ${displayPath(ctx.cwd, abs)}`);
    if (input.old_string === '') throw new ToolError('old_string must not be empty.');
    if (input.old_string === input.new_string)
      throw new ToolError('old_string and new_string are identical.');
    const before = await Bun.file(abs).text();
    const n = countOccurrences(before, input.old_string);
    if (n === 0) {
      throw new ToolError(
        `old_string not found in ${displayPath(ctx.cwd, abs)}. Read the file and copy the exact text (whitespace matters).`,
      );
    }
    if (n > 1 && !input.replace_all) {
      throw new ToolError(
        `old_string matches ${n} times in ${displayPath(ctx.cwd, abs)}. Include more surrounding context to make it unique, or set replace_all: true.`,
      );
    }
    const after = input.replace_all
      ? before.split(input.old_string).join(input.new_string)
      : before.replace(input.old_string, () => input.new_string);
    await Bun.write(abs, after);
    const snippet = editSnippet(after, input.new_string);
    return `Edited ${displayPath(ctx.cwd, abs)} (${n} replacement${n === 1 ? '' : 's'}).${snippet ? `\n\n${snippet}` : ''}`;
  },
});
