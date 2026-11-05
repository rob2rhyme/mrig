import { z } from 'zod';
import { VARIETIES, type Variety } from '../lang/tables.ts';
import { reportLines, SCRIPTS, type Script, transliterate } from '../lang/translit.ts';
import { truncateMiddle } from '../util/text.ts';
import { defineTool, ToolError } from './types.ts';

const scriptEnum = z.enum(SCRIPTS as [Script, ...Script[]]);

const inputSchema = z.object({
  text: z.string().describe('Text to convert'),
  to: scriptEnum.describe('Target: deva (Devanagari), akkha (Akkha-Brahmi) or roman (ISO 15919)'),
  from: scriptEnum.optional().describe('Source script (default deva)'),
  variety: z
    .enum(Object.keys(VARIETIES) as [Variety, ...Variety[]])
    .optional()
    .describe('ISO 639-3 variety tag, e.g. mgp, mrd, kgj, kzq'),
});

/**
 * Akkha transliteration (Track 2, A2): read-only, local, deterministic. The model should use it
 * instead of writing Brahmi or romanization itself.
 */
export const translitTool = defineTool<z.infer<typeof inputSchema>>({
  name: 'translit',
  description:
    'Convert text between Devanagari, Akkha (Unicode Brahmi) and ISO 15919 romanization with fixed tables. Use it instead of transliterating by hand. Reports lossy and unmapped characters.',
  inputSchema,
  readOnly: true,
  summarize: (i) => {
    const sample = i.text.length > 40 ? `${i.text.slice(0, 39)}…` : i.text;
    return `translit ${i.from ?? 'deva'} → ${i.to} "${sample}"`;
  },
  async execute(input, ctx) {
    const from = input.from ?? 'deva';
    if (from === input.to) throw new ToolError(`from and to are both "${from}"; nothing to do.`);
    const result = transliterate(input.text, from, input.to, { variety: input.variety });
    const report = reportLines(result);
    const text = report.length > 0 ? `${result.text}\n\n${report.join('\n')}` : result.text;
    return truncateMiddle(text, ctx.maxOutputChars);
  },
});
