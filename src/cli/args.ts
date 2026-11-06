import { MODE_NAMES, type ModeName, parseMode } from '../modes.ts';

/** `mrig app …` (Track 4, U2). */
export type AppCommand =
  | { action: 'run'; open: boolean; pair: boolean }
  | { action: 'allow'; name: string }
  | { action: 'devices' }
  | { action: 'revoke'; name: string };

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
  /** `mrig serve`: the local app server for the app front ends (Track 4, U1). */
  serve: boolean;
  /** `--port <n>` (with serve or app): for serve, 0 or absent picks a free port. */
  port?: number;
  /** `mrig app …`: the web app and its device allowlist (Track 4, U2). */
  app?: AppCommand;
  /** `--with-app` (with serve): also serve the web app, for the VS Code panel (U4). */
  withApp?: boolean;
  /** `--mode <name>` (T1). */
  mode?: ModeName;
  /** `--variety <tag>` (T8): the tutor mode's variety. */
  variety?: string;
  version: boolean;
  help: boolean;
}

export const HELP = `mrig — a personal, local, model-agnostic agent for the terminal

Usage:
  mrig [options] [initial prompt]        interactive session
  mrig -p "prompt" [options]             headless: run once, print, exit
  mrig doctor [-P <name>] [-m <id>]      check model ids against each provider's model list
  mrig init                              write a starter ~/.mrig/config.json
  mrig serve [--port <n>] [--with-app]   local app server for the app front ends (127.0.0.1 only)
  mrig app [--port <n>] [--no-open]      the mrig web app on this Mac (installable; 127.0.0.1 only)
  mrig app allow add <name>              allow a device and show its one-time pairing code
  mrig app devices                       list allowed devices; mrig app revoke <name> removes one

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
      --variety <tag>      The tutor's variety: mgp, mrd, kgj, kip, kif, kjl, kzq (with --mode tutor)
      --tui                Terminal UI with a status line (experimental)
      --port <n>           With serve or app: the port (serve: a free one; app: 4747 or app.port)
      --no-open            With app: don't open the browser
      --pair               With app: pair this Mac's browser again
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
    serve: false,
    version: false,
    help: false,
  };
  const positional: string[] = [];
  let initWord = false;
  let appWord = false;
  let noOpen = false;
  let pairAgain = false;
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
      case '--with-app':
        args.withApp = true;
        break;
      case '--no-open':
        noOpen = true;
        break;
      case '--pair':
        pairAgain = true;
        break;
      case '--port': {
        const n = Number(take(a, i++));
        if (!Number.isInteger(n) || n < 0 || n > 65535)
          throw new Error('--port must be a whole number from 0 to 65535');
        args.port = n;
        break;
      }
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
      case '--variety':
        args.variety = take(a, i++);
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
        if (a === 'app' && positional.length === 0 && args.print === undefined && !appWord) {
          appWord = true;
          break;
        }
        if (a === 'serve' && positional.length === 0 && args.print === undefined) {
          args.serve = true;
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
  // `mrig app` and its subcommands; `mrig app ideas for my site` is a prompt.
  if (appWord) {
    const [w1, w2, w3, ...extra] = positional;
    if (positional.length === 0) args.app = { action: 'run', open: !noOpen, pair: pairAgain };
    else if (w1 === 'allow' && w2 === 'add' && w3 && extra.length === 0)
      args.app = { action: 'allow', name: w3 };
    else if (w1 === 'devices' && positional.length === 1) args.app = { action: 'devices' };
    else if (w1 === 'revoke' && w2 && positional.length === 2)
      args.app = { action: 'revoke', name: w2 };
    else positional.unshift('app');
    if (args.app) positional.length = 0;
  }
  if ((noOpen || pairAgain) && args.app?.action !== 'run') {
    throw new Error(`${noOpen ? '--no-open' : '--pair'} works with mrig app`);
  }
  if (positional.length) args.prompt = positional.join(' ');
  if ((args.json || args.outputLast) && args.print === undefined) {
    throw new Error(`${args.json ? '--json' : '--output-last'} works with -p "prompt"`);
  }
  if (args.json && args.outputLast) throw new Error('Use --json or --output-last, not both');
  if (args.port !== undefined && !args.serve && args.app?.action !== 'run') {
    throw new Error('--port works with mrig serve or mrig app');
  }
  if (args.serve && args.prompt) throw new Error('mrig serve takes no prompt');
  if (args.withApp && !args.serve) throw new Error('--with-app works with mrig serve');
  return args;
}
