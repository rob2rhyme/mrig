import { z } from 'zod';
import { VARIETIES, type Variety } from '../lang/tables.ts';
import { LearnerError, loadLearner, recordResult, saveLearner, today } from '../learner.ts';
import { defineTool, type MrigTool, ToolError } from './types.ts';

const inputSchema = z.object({
  topic: z.string().describe('A short label for what was practised, e.g. "Magar numerals 1–10"'),
  result: z
    .enum(['right', 'missed', 'introduced'])
    .describe('right or missed for an answer; introduced when you taught it without asking'),
  variety: z
    .enum(Object.keys(VARIETIES) as [Variety, ...Variety[]])
    .optional()
    .describe('ISO 639-3 tag for a language topic (mgp, mrd, kgj, kip, kif, kjl, kzq)'),
  note: z.string().optional().describe('Optional, at most 200 characters: the one thing to watch'),
});
type Input = z.infer<typeof inputSchema>;

export interface LearnedToolOptions {
  /** The learner file (global, or the offline zone's own). */
  path: string;
  now?: () => Date;
}

/**
 * Learner memory (Track 3, T2): record one result. Offered only in learn and teach mode. It
 * writes mrig's own local file, never the user's project, so it counts as read-only for the
 * permission gate; every call still shows as a tool line.
 */
export function createLearnedTool(opts: LearnedToolOptions): MrigTool<Input> {
  return defineTool<Input>({
    name: 'learned',
    description:
      "Record one learning result in the user's local learner memory: right or missed after an answer, introduced after teaching something new. Pass the variety for language topics.",
    inputSchema,
    readOnly: true,
    summarize: (i) => `learned "${i.topic}"${i.variety ? ` (${i.variety})` : ''} ${i.result}`,
    async execute(input) {
      const date = today((opts.now ?? (() => new Date()))());
      try {
        // Load, change and save on each call, so two sessions don't overwrite each other.
        const file = loadLearner(opts.path);
        const t = recordResult(file, input, date);
        saveLearner(opts.path, file);
        const score = t.asked === 0 ? 'not yet asked' : `${t.right}/${t.asked} right`;
        return `Recorded: ${t.topic}${t.variety ? ` (${t.variety})` : ''} is ${t.status}, ${score}, next review ${t.due}.`;
      } catch (err) {
        if (err instanceof LearnerError) throw new ToolError(err.message);
        throw err;
      }
    },
  });
}
