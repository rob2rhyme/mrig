import { MODE_NAMES, type ModeName, parseMode } from '../modes.ts';

export interface CliArgs {
  prompt?: string;
  print?: string;
  provider?: string;
  model?: string;
  yolo: boolean;
  resume?: string;
  continue: boolean;
  maxSteps?: number;
  cwd?: string;
  listSessions: boolean;
  /** `--offline`: only local profiles, prompts always on (L5). */
  offline: boolean;
  /** `--tui`: the full-screen terminal UI instead of the readline REPL (L6, experimental). */
  tui: boolean;
  /** `mrig doctor`: check configured model ids against each provider's /v1/models. */
  doctor: boolean;
  /** `--json` (with -p): print one JSON result object instead of streaming text (L7). */
  json: boolean;
  /** `--output-last` (with -p): print only the final assistant message (L7). */
  outputLast: boolean;
  /** `mrig init` / `--init`: write a starter ~/.mrig/config.json (L7). */
  init: boolean;
  /** `--mode <name>` (T1). */
  mode?: ModeName;
  version: boolean;
  help: boolean;
}

export const HELP = `mrig — a personal, local, model-agnostic agent for the terminal

Usage:
  mrig [options] [initial prompt]        interactive session
  mrig -p "prompt" [options]             headless: run once, print, exit
  mrig doctor [-P <name>] [-m <id>]      check model ids against each provider's model list
  mrig init                              write a starter ~/.mrig/config.json

Options:
  -p, --print <prompt>     Run a single prompt non-interactively and exit
      --json               With -p: print one JSON object (text, usage, cost, session id)
      --output-last        With -p: print only the final answer, not the text streamed on the way
  -P, --provider <name>    Provider profile (claude, opus, fable, haiku, openai, ollama, lmstudio, llamacpp, or custom)
  -m, --model <id>         Override the profile's model id
  -y, --yolo               Skip permission prompts (dangerous outside a sandbox)
  -c, --continue           Resume the most recent session in this directory
  -r, --resume <id>        Resume a specific session
      --max-steps <n>      Max model turns per message (default 40)
      --cwd <dir>          Working directory
      --list-sessions      List saved sessions
      --offline            Only local models; prompts always on (also: a .mrig-zone file)
      --mode <name>        Start in a mode: ${MODE_NAMES.join(', ')} (or /mode in a session)
      --tui                Terminal UI with a status line (experimental)
      --doctor             Same as "mrig doctor"
      --init               Same as "mrig init"
  -v, --version            Print version
  -h, --help               Show this help

Config: ~/.mrig/config.json and ./.mrig/config.json  (see README)
Env:    ANTHROPIC_API_KEY, OPENAI_API_KEY, MRIG_PROVIDER, MRIG_YOLO=1, MRIG_HOME
`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    yolo: false,
    continue: false,
    listSessions: false,
    offline: false,
    tui: false,
    doctor: false,
    json: false,
    outputLast: false,
    init: false,
    version: false,
    help: false,
  };
  const positional: string[] = [];
  let initWord = false;
  const take = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) throw new Error(`Missing value for ${flag}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    switch (a) {
      case '-p':
      case '--print':
        args.print = take(a, i++);
        break;
      case '-P':
      case '--provider':
        args.provider = take(a, i++);
        break;
      case '-m':
      case '--model':
        args.model = take(a, i++);
        break;
      case '-y':
      case '--yolo':
        args.yolo = true;
        break;
      case '-c':
      case '--continue':
        args.continue = true;
        break;
      case '-r':
      case '--resume':
        args.resume = take(a, i++);
        break;
      case '--max-steps': {
        const n = Number(take(a, i++));
        if (!Number.isInteger(n) || n < 1)
          throw new Error('--max-steps must be a positive integer');
        args.maxSteps = n;
        break;
      }
      case '--cwd':
        args.cwd = take(a, i++);
        break;
      case '--list-sessions':
        args.listSessions = true;
        break;
      case '--offline':
        args.offline = true;
        break;
      case '--tui':
        args.tui = true;
        break;
      case '--doctor':
        args.doctor = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--output-last':
        args.outputLast = true;
        break;
      case '--init':
        args.init = true;
        break;
      case '--mode':
        args.mode = parseMode(take(a, i++));
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (a.startsWith('-') && a.length > 1) throw new Error(`Unknown option: ${a}`);
        if (a === 'doctor' && positional.length === 0 && args.print === undefined) {
          args.doctor = true;
          break;
        }
        if (a === 'init' && positional.length === 0 && args.print === undefined) {
          initWord = true;
          break;
        }
        positional.push(a);
    }
  }
  // `mrig init` alone is the subcommand; `mrig init a git repo here` is a prompt.
  if (initWord) {
    if (positional.length) positional.unshift('init');
    else args.init = true;
  }
  if (positional.length) args.prompt = positional.join(' ');
  if ((args.json || args.outputLast) && args.print === undefined) {
    throw new Error(`${args.json ? '--json' : '--output-last'} works with -p "prompt"`);
  }
  if (args.json && args.outputLast) throw new Error('Use --json or --output-last, not both');
  return args;
}
