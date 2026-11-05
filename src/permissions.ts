/**
 * Permission gate. Read-only tools always run. Everything else is checked against
 * allow rules, then the user is asked (unless yolo).
 *
 * Rule forms (config `permissions.allow` or learned during a session):
 *   "bash:<prefix>"   allow bash commands whose trimmed text starts with <prefix>
 *   "write:<glob>"    allow writes to paths matching <glob> (relative to cwd, or absolute)
 *   "edit:<glob>"     allow edits to matching paths
 *   "<tool>:*"        allow every call of that tool
 */
import type { AnyTool } from './tools/index.ts';
import { displayPath, globToRegExp } from './util/paths.ts';

export type Answer = 'yes' | 'no' | 'always';
export type Decision = 'allow' | 'deny';

export interface AskRequest {
  tool: AnyTool;
  input: unknown;
  /** One-line summary from the tool */
  summary: string;
  /** Optional multi-line preview (diff, file content) */
  preview?: string;
  /** The rule that "always" would add */
  alwaysRule: string;
}

export type AskFn = (req: AskRequest) => Promise<Answer>;

export interface PermissionOptions {
  yolo: boolean;
  allow: string[];
  ask: AskFn;
  cwd: string;
  /** Offline mode: bash never gets an allow rule, so "always" means this once. */
  noBashRules?: boolean;
}

interface Rule {
  tool: string;
  pattern: string;
  re?: RegExp;
}

function parseRule(raw: string): Rule | undefined {
  const idx = raw.indexOf(':');
  if (idx <= 0) return undefined;
  const tool = raw.slice(0, idx).trim();
  const pattern = raw.slice(idx + 1).trim();
  if (!tool || !pattern) return undefined;
  return tool === 'bash' || pattern === '*'
    ? { tool, pattern }
    : { tool, pattern, re: globToRegExp(pattern) };
}

function inputPath(input: unknown): string | undefined {
  if (input && typeof input === 'object' && 'path' in input && typeof input.path === 'string') {
    return input.path;
  }
  return undefined;
}

function inputCommand(input: unknown): string | undefined {
  if (
    input &&
    typeof input === 'object' &&
    'command' in input &&
    typeof input.command === 'string'
  ) {
    return input.command;
  }
  return undefined;
}

export class PermissionManager {
  yolo: boolean;
  private rules: Rule[];
  private readonly ask: AskFn;
  private readonly cwd: string;
  private readonly noBashRules: boolean;
  /** Rules added via "always" this session (so they can be persisted or shown). */
  readonly learned: string[] = [];

  constructor(opts: PermissionOptions) {
    this.yolo = opts.yolo;
    this.ask = opts.ask;
    this.cwd = opts.cwd;
    this.noBashRules = opts.noBashRules ?? false;
    this.rules = opts.allow
      .map(parseRule)
      .filter((r): r is Rule => r !== undefined && !(this.noBashRules && r.tool === 'bash'));
  }

  addRule(raw: string): void {
    const rule = parseRule(raw);
    if (!rule || (this.noBashRules && rule.tool === 'bash')) return;
    this.rules.push(rule);
    this.learned.push(raw);
  }

  /** Does an existing rule cover this call? */
  matches(tool: AnyTool, input: unknown): boolean {
    for (const rule of this.rules) {
      if (rule.tool !== tool.name) continue;
      if (rule.pattern === '*') return true;
      if (tool.name === 'bash') {
        const cmd = inputCommand(input)?.trim() ?? '';
        if (cmd.startsWith(rule.pattern)) return true;
        continue;
      }
      const p = inputPath(input);
      if (p === undefined || !rule.re) continue;
      const rel = displayPath(this.cwd, p);
      if (rule.re.test(rel) || rule.re.test(p)) return true;
    }
    return false;
  }

  /** The rule an "always" answer would add for this call. */
  alwaysRuleFor(tool: AnyTool, input: unknown): string {
    if (tool.name === 'bash') {
      if (this.noBashRules) return 'bash: once (offline mode asks every time)';
      const cmd = inputCommand(input)?.trim() ?? '';
      // First two words is a sensible prefix: "git status", "npm test", "bun run".
      const prefix = cmd.split(/\s+/).slice(0, 2).join(' ');
      return `bash:${prefix}`;
    }
    const p = inputPath(input);
    if (p) {
      const rel = displayPath(this.cwd, p);
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      return `${tool.name}:${dir ? `${dir}/**` : '**'}`;
    }
    return `${tool.name}:*`;
  }

  async check(tool: AnyTool, input: unknown, preview?: string): Promise<Decision> {
    if (tool.readOnly) return 'allow';
    if (this.yolo) return 'allow';
    if (this.matches(tool, input)) return 'allow';
    const alwaysRule = this.alwaysRuleFor(tool, input);
    const answer = await this.ask({
      tool,
      input,
      summary: tool.summarize(input),
      preview,
      alwaysRule,
    });
    if (answer === 'always') {
      this.addRule(alwaysRule);
      return 'allow';
    }
    return answer === 'yes' ? 'allow' : 'deny';
  }
}
