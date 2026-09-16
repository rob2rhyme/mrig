import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Resolve a user-supplied path against cwd, expanding a leading "~". */
export function resolvePath(cwd: string, p: string): string {
  const expanded = p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** True when `target` is inside `root` (or equal to it). */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Display path relative to cwd when inside it, else absolute. */
export function displayPath(cwd: string, p: string): string {
  const abs = resolvePath(cwd, p);
  if (isWithin(cwd, abs)) {
    const rel = relative(cwd, abs);
    return rel === '' ? '.' : rel.split(sep).join('/');
  }
  return abs;
}

/** Simple glob → RegExp for allow rules ("src/**", "*.md"). */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c && /[.+^${}()|[\]\\]/.test(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
