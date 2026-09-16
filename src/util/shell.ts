import { existsSync } from 'node:fs';
import { platform } from 'node:os';

export interface ShellSpec {
  /** Human name shown to the model and in prompts */
  name: 'bash' | 'sh' | 'powershell';
  /** argv prefix; the command string is appended as the final argument */
  argv: string[];
}

let cached: ShellSpec | undefined;

/** Pick the shell for the `bash` tool: bash → sh on POSIX, PowerShell on Windows. */
export function detectShell(): ShellSpec {
  if (cached) return cached;
  if (platform() === 'win32') {
    // Prefer PowerShell 7 (pwsh) when installed, else Windows PowerShell.
    const pwsh = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'].find((p) => existsSync(p));
    cached = {
      name: 'powershell',
      argv: [pwsh ?? 'powershell.exe', '-NoProfile', '-NonInteractive', '-Command'],
    };
    return cached;
  }
  const bash = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'].find(
    (p) => existsSync(p),
  );
  cached = bash ? { name: 'bash', argv: [bash, '-c'] } : { name: 'sh', argv: ['/bin/sh', '-c'] };
  return cached;
}

/** Test hook. */
export function _resetShellCache(): void {
  cached = undefined;
}
