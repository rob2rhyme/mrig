import { z } from 'zod';
import { findCorpus, formatSearch, loadCorpus, searchCorpus } from '../lang/corpus.ts';
import { VARIETIES, type Variety } from '../lang/tables.ts';
import { truncateMiddle } from '../util/text.ts';
import { defineTool, ToolError } from './types.ts';

const inputSchema = z.object({
  query: z
    .string()
    .describe('A word or phrase in Devanagari, Akkha, romanization, or an English gloss'),
  variety: z
    .enum(Object.keys(VARIETIES) as [Variety, ...Variety[]])
    .optional()
    .describe('Only lexicon forms of this ISO 639-3 variety, e.g. mgp, kgj, kzq'),
  path: z.string().optional().describe('Corpus folder (default: config "corpus", else ./cldf)'),
  limit: z.number().int().min(1).max(200).optional().describe('Most matches to list (default 50)'),
});

/**
 * Corpus search (Track 2, A4): read-only and local. Searches every form of the query and returns
 * `file:line` hits labelled with their variety, so answers can cite the corpus.
 */
export const corpusTool = defineTool<z.infer<typeof inputSchema>>({
  name: 'corpus',
  description:
    'Search the language corpus (a CLDF wordlist and text files) for a word in Devanagari, Akkha, romanization or English. Returns file:line matches with variety and concept. Cite them; do not invent entries.',
  inputSchema,
  readOnly: true,
  summarize: (i) => `corpus "${i.query}"${i.variety ? ` (${i.variety})` : ''}`,
  async execute(input, ctx) {
    const dir = findCorpus(ctx.cwd, input.path ?? ctx.corpus);
    if (!dir) {
      throw new ToolError(
        input.path || ctx.corpus
          ? `Corpus folder not found: ${input.path ?? ctx.corpus}`
          : 'No corpus found. Pass path, set "corpus" in the config, or put a CLDF dataset in ./cldf.',
      );
    }
    if (!input.query.trim()) throw new ToolError('Empty query.');
    let corpus: ReturnType<typeof loadCorpus>;
    try {
      corpus = loadCorpus(dir);
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
    // In tutor mode (T8) searches default to the tutor's variety.
    const opts = { variety: input.variety ?? ctx.variety, limit: input.limit };
    const result = searchCorpus(corpus, input.query, opts);
    return truncateMiddle(
      formatSearch(corpus, input.query, result, opts).join('\n'),
      ctx.maxOutputChars,
    );
  },
});
