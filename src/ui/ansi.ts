/** Minimal ANSI styling; honors NO_COLOR and non-TTY output. */
const enabled =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === '1');

function wrap(open: number, close: number) {
  return (s: string): string => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);

export const colorEnabled = enabled;
