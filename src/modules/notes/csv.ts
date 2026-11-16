// Minimal RFC 4180 CSV for the table editor: quoted fields, escaped quotes,
// embedded delimiters/newlines, CRLF or LF. The delimiter is sniffed from the
// header line (comma, semicolon, tab) and written back unchanged, so opening
// and saving a spreadsheet's `;`-separated export doesn't rewrite it.

export type CsvDelimiter = "," | ";" | "\t";

/** Pick the delimiter that appears most in the first line (outside quotes);
 *  comma on a tie or an empty file. */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch as CsvDelimiter]++;
  }
  let best: CsvDelimiter = ",";
  for (const d of [";", "\t"] as const) {
    if (counts[d] > counts[best]) best = d;
  }
  return best;
}

/** Parse CSV text into rows of cells. A trailing newline doesn't add an empty
 *  row; blank input is no rows. Rows keep their own length (see `pad`). */
export function parseCsv(text: string, delimiter: CsvDelimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let touched = false; // anything seen on the current row?

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      touched = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
      touched = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      touched = false;
    } else {
      cell += ch;
      touched = true;
    }
  }
  if (touched || cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function quote(cell: string, delimiter: CsvDelimiter): string {
  return /["\n\r]/.test(cell) || cell.includes(delimiter)
    ? `"${cell.replace(/"/g, '""')}"`
    : cell;
}

/** Serialize rows to CSV (LF line endings, trailing newline). */
export function serializeCsv(
  rows: string[][],
  delimiter: CsvDelimiter,
): string {
  return rows
    .map((r) => r.map((c) => quote(c, delimiter)).join(delimiter) + "\n")
    .join("");
}

/** Make every row as wide as the widest, and at least one row × one column. */
export function pad(rows: string[][]): string[][] {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const out = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
  return out.length > 0 ? out : [Array(width).fill("")];
}
