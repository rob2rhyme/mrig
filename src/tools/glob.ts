import { statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { displayPath, resolvePath } from '../util/paths.ts';
import { defineTool, ToolError } from './types.ts';

const MAX_RESULTS = 500;
const IGNORED = /(^|\/)(node_modules|\.git|dist|build|\.next|target|__pycache__|\.venv|venv)(\/|$)/;

const schema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "**/*.ts" or "src/**/*.test.*"'),
  path: z.string().optional().describe('Directory to search (default: working directory)'),
});

/** Find files matching a glob; newest first. */
export async function globFiles(pattern: string, base: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const results: Array<{ path: string; mtime: number }> = [];
  for await (const rel of glob.scan({ cwd: base, dot: false, onlyFiles: true })) {
    const norm = rel.split('\\').join('/');
    if (IGNORED.test(norm)) continue;
    let mtime = 0;
    try {
      mtime = statSync(join(base, rel)).mtimeMs;
    } catch {
      // file vanished between scan and stat
    }
    results.push({ path: norm, mtime });
    if (results.length >= MAX_RESULTS * 4) break;
  }
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, MAX_RESULTS).map((r) => r.path);
}

export const globTool = defineTool<z.infer<typeof schema>>({
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "**/*.ts", "src/**/README*"). Returns paths relative to the search directory, newest first. node_modules, .git and build folders are skipped.',
  inputSchema: schema,
  readOnly: true,
  summarize: (i) => `glob ${i.pattern}${i.path ? ` in ${i.path}` : ''}`,
  async execute(input, ctx) {
    const base = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd;
    try {
      if (!statSync(base).isDirectory())
        throw new ToolError(`Not a directory: ${displayPath(ctx.cwd, base)}`);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`Directory not found: ${displayPath(ctx.cwd, base)}`);
    }
    const files = await globFiles(input.pattern, base);
    if (files.length === 0) return 'No files matched.';
    const header =
      files.length >= MAX_RESULTS ? `First ${MAX_RESULTS} matches (newest first):\n` : '';
    return header + files.join('\n');
  },
});
