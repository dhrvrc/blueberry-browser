/**
 * Shared CSV parsing utilities used by FileStore (CSV viewer) and DataConnector (data analysis).
 * A single implementation keeps rendering and analysis in sync.
 */

/**
 * Parse a CSV string into rows of cells.
 * Handles quoted fields (commas, newlines, escaped quotes per RFC 4180).
 */
export function parseCsvCells(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  let i = 0;

  while (i < csv.length) {
    const ch = csv[i];
    if (inQ) {
      if (ch === '"' && csv[i + 1] === '"') {
        cell += '"'; i += 2; continue;
      }
      if (ch === '"') { inQ = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ""; i++; continue; }
    if (ch === '\r' && csv[i + 1] === '\n') { row.push(cell); cell = ""; rows.push(row); row = []; i += 2; continue; }
    if (ch === '\n' || ch === '\r') { row.push(cell); cell = ""; rows.push(row); row = []; i++; continue; }
    cell += ch; i++;
  }
  row.push(cell);
  if (row.some(c => c !== "")) rows.push(row);
  return rows;
}

/**
 * Parse a CSV string into an array of row objects keyed by header.
 * First row is the header. Empty input returns [].
 * Rows with fewer cells than the header get "" for missing keys; extra cells are dropped.
 */
export function parseCsvRows(csv: string): Array<Record<string, string>> {
  const cells = parseCsvCells(csv);
  if (cells.length === 0) return [];
  const [header, ...dataRows] = cells;
  return dataRows.map(row => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = i < row.length ? row[i] : "";
    }
    return obj;
  });
}
