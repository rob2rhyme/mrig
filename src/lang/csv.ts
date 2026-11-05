/**
 * A small RFC 4180 CSV reader for CLDF tables (A4). It keeps the line each row starts on, so
 * search results can point at `file:line`. Quoted fields may hold commas, quotes ("") and
 * newlines; CRLF and LF both end a row; a UTF-8 byte-order mark is skipped.
 */
export interface CsvRow {
  /** 1-based line the row starts on. */
  line: number;
  cells: string[];
  /** The row's source text, as it appears in the file (without the final newline). */
  raw: string;
}

export function parseCsv(text: string): CsvRow[] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let rowStart = 0;
  const endRow = (end: number) => {
    cells.push(cell);
    // A blank line is not a row.
    if (!(cells.length === 1 && cells[0] === '')) {
      rows.push({ line: rowLine, cells, raw: s.slice(rowStart, end) });
    }
    cells = [];
    cell = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === '\n') line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      cells.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      endRow(i);
      if (c === '\r' && s[i + 1] === '\n') i++;
      line++;
      rowLine = line;
      rowStart = i + 1;
    } else cell += c;
  }
  if (cell !== '' || cells.length > 0) endRow(s.length);
  return rows;
}
