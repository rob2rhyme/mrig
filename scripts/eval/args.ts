export interface EvalArgs {
  profiles?: string[];
  tasks?: string[];
  maxSteps: number;
  timeoutSec: number;
  out: string;
  matrix?: string;
  report: boolean;
  noCheck: boolean;
  list: boolean;
  help: boolean;
}

export const EVAL_HELP = `mrig eval: run a fixed task suite against provider profiles

Usage:
  bun run eval [options]

Options:
  -P, --profiles <a,b>   Profiles to run (default: every profile in your config)
  -t, --tasks <id,id>    Only these tasks (see --list)
      --max-steps <n>    Max model turns per task (default 20)
      --timeout <sec>    Per-task time limit in seconds (default 300)
      --out <dir>        Where raw results are saved (default evals/results)
      --matrix <path>    Also write the compatibility matrix (markdown) from all saved results
      --report           Do not run anything; only render the matrix from saved results
      --no-check         Skip the reachability / model-id pre-check
      --list             List the tasks and exit
  -h, --help             Show this help

WARNING: tasks run with permissions off (like --yolo) in a temp directory, and the model can run
any shell command. Run untrusted models in a container or VM.
`;

export function parseEvalArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = {
    maxSteps: 20,
    timeoutSec: 300,
    out: 'evals/results',
    report: false,
    noCheck: false,
    list: false,
    help: false,
  };
  const take = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) throw new Error(`Missing value for ${flag}`);
    return v;
  };
  const list = (v: string) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const positive = (flag: string, v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    switch (a) {
      case '-P':
      case '--profiles':
        args.profiles = list(take(a, i++));
        break;
      case '-t':
      case '--tasks':
        args.tasks = list(take(a, i++));
        break;
      case '--max-steps':
        args.maxSteps = positive(a, take(a, i++));
        break;
      case '--timeout':
        args.timeoutSec = positive(a, take(a, i++));
        break;
      case '--out':
        args.out = take(a, i++);
        break;
      case '--matrix':
        args.matrix = take(a, i++);
        break;
      case '--report':
        args.report = true;
        break;
      case '--no-check':
        args.noCheck = true;
        break;
      case '--list':
        args.list = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }
  return args;
}
