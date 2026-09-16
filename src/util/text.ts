/** Truncate long text keeping the head and tail, with a marker in the middle. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(200, Math.floor(maxChars / 2) - 60);
  const head = text.slice(0, keep);
  const tail = text.slice(-keep);
  const dropped = text.length - head.length - tail.length;
  return `${head}\n\n… [${dropped.toLocaleString()} characters truncated] …\n\n${tail}`;
}

/** Truncate to the first N lines. */
export function firstLines(text: string, n: number): string {
  const lines = text.split('\n');
  if (lines.length <= n) return text;
  return `${lines.slice(0, n).join('\n')}\n… (${lines.length - n} more lines)`;
}

/** Format bytes for humans. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Cheap token estimate (~4 chars/token) for display only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Heuristic binary check: NUL byte in the first 8 KB. */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
