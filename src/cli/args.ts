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
  version: boolean;
  help: boolean;
}

export const HELP = `mrig — a personal, local, model-agnostic agent for the terminal

Usage:
  mrig [options] [initial prompt]        interactive session
  mrig -p "prompt" [options]             headless: run once, print, exit
  mrig doctor [-P <name>] [-m <id>]      check model ids against each provider's model list

Options:
  -p, --print <prompt>     Run a single prompt non-interactively and exit
  -P, --provider <name>    Provider profile (claude, opus, fable, haiku, openai, ollama, lmstudio, llamacpp, or custom)
  -m, --model <id>         Override the profile's model id
  -y, --yolo               Skip permission prompts (dangerous outside a sandbox)
  -c, --continue           Resume the most recent session in this directory
  -r, --resume <id>        Resume a specific session
      --max-steps <n>      Max model turns per message (default 40)
      --cwd <dir>          Working directory
      --list-sessions      List saved sessions
      --offline            Only local models; prompts always on (also: a .mrig-zone file)
      --tui                Terminal UI with a status line (experimental)
      --doctor             Same as "mrig doctor"
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
    version: false,
    help: false,
  };
  const positional: string[] = [];
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
        positional.push(a);
    }
  }
  if (positional.length) args.prompt = positional.join(' ');
  return args;
}
