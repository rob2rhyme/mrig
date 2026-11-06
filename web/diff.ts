/**
 * A line diff for edit cards (Track 4, U2): the longest common subsequence of lines, so an edit
 * shows the lines it kept as context around what it removed and added. Pure; large inputs fall
 * back to "all removed, then all added" to keep the work bounded.
 */

export interface DiffLine {
  op: ' ' | '-' | '+';
  text: string;
}

/** Above this many cells (lines × lines), skip the LCS table. */
const MAX_CELLS = 1_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text) => ({ op: '-' as const, text })),
      ...b.map((text) => ({ op: '+' as const, text })),
    ];
  }
  // lcs[i][j]: length of the LCS of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const below = lcs[i + 1] as Uint32Array;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] ?? '' });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ op: '-', text: a[i++] ?? '' });
    } else {
      out.push({ op: '+', text: b[j++] ?? '' });
    }
  }
  while (i < a.length) out.push({ op: '-', text: a[i++] ?? '' });
  while (j < b.length) out.push({ op: '+', text: b[j++] ?? '' });
  return out;
}
