/**
 * Stateless DataFrame-lite connector for the MCP registry.
 * Rows are passed in args each call — the agent threads the array between calls.
 * No eval — the filter tool uses a structured predicate, not arbitrary code.
 */

import { parseCsvRows } from "../csv";
import type { Connector } from "../McpClient";

const MAX_ROWS = 50_000;

type Row = Record<string, unknown>;

interface ColumnStat {
  name: string;
  type: "number" | "string";
  count: number;
  nulls: number;
  distinct: number;
  min: number | string | null;
  max: number | string | null;
  mean: number | null;
  sample: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce a cell value to number, treating ""/null/undefined as null. */
function coerceNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** Infer column type: "number" if ALL non-null values coerce to finite numbers. */
function inferType(values: unknown[]): "number" | "string" {
  const nonNull = values.filter(v => v !== null && v !== undefined && v !== "");
  if (nonNull.length === 0) return "string";
  return nonNull.every(v => coerceNum(v) !== null) ? "number" : "string";
}

/** Collect all distinct keys across rows. */
function allColumns(rows: Row[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) seen.add(k);
  }
  return Array.from(seen);
}

/** Assert rows is a valid array within MAX_ROWS. */
function assertRows(rows: unknown): asserts rows is Row[] {
  if (!Array.isArray(rows)) throw new Error("data connector: rows must be an array");
  if (rows.length > MAX_ROWS) throw new Error(`data connector: rows exceeds MAX_ROWS (${MAX_ROWS})`);
}

/** Assert a column exists in the row set (check first row that has any key). */
function assertColumn(rows: Row[], col: string): void {
  const cols = allColumns(rows);
  if (!cols.includes(col)) {
    throw new Error(`data connector: column "${col}" not found`);
  }
}

// ---------------------------------------------------------------------------
// DataConnector
// ---------------------------------------------------------------------------

export class DataConnector implements Connector {
  async call(tool: string, args: unknown): Promise<unknown> {
    const a = (args ?? {}) as Record<string, unknown>;

    switch (tool) {
      // ── Parse ──────────────────────────────────────────────────────────────

      case "parseCsv": {
        const content = a.content;
        if (typeof content !== "string") {
          throw new Error("data connector: parseCsv requires content to be a string");
        }
        const rows = parseCsvRows(content);
        if (rows.length > MAX_ROWS) {
          throw new Error(`data connector: CSV exceeds MAX_ROWS (${MAX_ROWS})`);
        }
        return rows;
      }

      case "parseJson": {
        const content = a.content;
        if (typeof content !== "string") {
          throw new Error("data connector: parseJson requires content to be a string");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`data connector: JSON parse failed: ${msg}`);
        }
        let rows: Row[];
        if (Array.isArray(parsed)) {
          rows = parsed as Row[];
        } else if (parsed !== null && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          if (Array.isArray(obj.data)) {
            rows = obj.data as Row[];
          } else if (Array.isArray(obj.rows)) {
            rows = obj.rows as Row[];
          } else {
            rows = [obj as Row];
          }
        } else {
          throw new Error("data connector: JSON is not an array of rows");
        }
        if (rows.length > MAX_ROWS) {
          throw new Error(`data connector: JSON exceeds MAX_ROWS (${MAX_ROWS})`);
        }
        return rows;
      }

      // ── Analyze ────────────────────────────────────────────────────────────

      case "summarize": {
        const rows = a.rows;
        assertRows(rows);
        const columns = allColumns(rows);
        const stats: ColumnStat[] = columns.map(name => {
          const values = rows.map(r => r[name]);
          const type = inferType(values);
          const nonNull = values.filter(v => v !== null && v !== undefined && v !== "");
          const nulls = values.length - nonNull.length;
          const distinct = new Set(values.map(v => String(v))).size;
          let min: number | string | null = null;
          let max: number | string | null = null;
          let mean: number | null = null;
          if (type === "number") {
            const nums = nonNull.map(v => coerceNum(v)).filter((n): n is number => n !== null);
            if (nums.length > 0) {
              min = Math.min(...nums);
              max = Math.max(...nums);
              mean = nums.reduce((s, n) => s + n, 0) / nums.length;
            }
          } else {
            const strs = nonNull.map(v => String(v));
            if (strs.length > 0) {
              strs.sort();
              min = strs[0];
              max = strs[strs.length - 1];
              mean = null;
            }
          }
          const sample = nonNull[0] ?? null;
          return { name, type, count: nonNull.length, nulls, distinct, min, max, mean, sample };
        });
        return { rowCount: rows.length, columns: stats };
      }

      case "groupBy": {
        const rows = a.rows;
        assertRows(rows);
        const by = a.by as string;
        if (typeof by !== "string") throw new Error("data connector: groupBy requires by:string");
        assertColumn(rows, by);

        const aggSpec = a.agg as { column: string; op: "sum" | "avg" | "count" | "min" | "max" };
        if (!aggSpec || typeof aggSpec !== "object") {
          throw new Error("data connector: groupBy requires agg:{column,op}");
        }
        const { column: aggCol, op } = aggSpec;
        if (!["sum", "avg", "count", "min", "max"].includes(op)) {
          throw new Error(`data connector: invalid agg op "${op}"`);
        }
        if (op !== "count") assertColumn(rows, aggCol);

        const groups = new Map<string, Row[]>();
        for (const row of rows) {
          const key = String(row[by] ?? "");
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(row);
        }

        const resultKey = `${op}_${aggCol}`;
        return Array.from(groups.entries()).map(([groupVal, groupRows]) => {
          let aggValue: number;
          if (op === "count") {
            aggValue = groupRows.length;
          } else {
            const nums = groupRows
              .map(r => coerceNum(r[aggCol]))
              .filter((n): n is number => n !== null);
            if (nums.length === 0) {
              aggValue = 0;
            } else if (op === "sum") {
              aggValue = nums.reduce((s, n) => s + n, 0);
            } else if (op === "avg") {
              aggValue = nums.reduce((s, n) => s + n, 0) / nums.length;
            } else if (op === "min") {
              aggValue = Math.min(...nums);
            } else {
              aggValue = Math.max(...nums);
            }
          }
          return { [by]: groupVal, [resultKey]: aggValue };
        });
      }

      case "filter": {
        const rows = a.rows;
        assertRows(rows);
        const where = a.where as {
          column: string;
          op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains";
          value: string | number;
        };
        if (!where || typeof where !== "object") {
          throw new Error("data connector: filter requires where:{column,op,value}");
        }
        const { column, op, value } = where;
        assertColumn(rows, column);
        if (!["eq", "ne", "gt", "gte", "lt", "lte", "contains"].includes(op)) {
          throw new Error(`data connector: filter unknown op "${op}"`);
        }

        return rows.filter(row => {
          const cell = row[column];
          if (["gt", "gte", "lt", "lte"].includes(op)) {
            const cn = coerceNum(cell);
            const vn = coerceNum(value);
            if (cn === null || vn === null) return false;
            if (op === "gt") return cn > vn;
            if (op === "gte") return cn >= vn;
            if (op === "lt") return cn < vn;
            return cn <= vn;
          }
          if (op === "contains") {
            return String(cell ?? "").toLowerCase().includes(String(value).toLowerCase());
          }
          // eq / ne — loose string compare
          const match = String(cell ?? "") === String(value ?? "");
          return op === "eq" ? match : !match;
        });
      }

      case "sort": {
        const rows = a.rows;
        assertRows(rows);
        const by = a.by as string;
        if (typeof by !== "string") throw new Error("data connector: sort requires by:string");
        assertColumn(rows, by);
        const dir = (a.dir as string | undefined) ?? "asc";
        if (dir !== "asc" && dir !== "desc") {
          throw new Error(`data connector: sort dir must be "asc" or "desc"`);
        }

        const values = rows.map(r => r[by]);
        const isNum = inferType(values) === "number";

        return [...rows].sort((a, b) => {
          const av = a[by];
          const bv = b[by];
          // Nulls last
          const aNull = av === null || av === undefined || av === "";
          const bNull = bv === null || bv === undefined || bv === "";
          if (aNull && bNull) return 0;
          if (aNull) return 1;
          if (bNull) return -1;
          let cmp: number;
          if (isNum) {
            cmp = (coerceNum(av) ?? 0) - (coerceNum(bv) ?? 0);
          } else {
            cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
          }
          return dir === "desc" ? -cmp : cmp;
        });
      }

      case "topN": {
        const rows = a.rows;
        assertRows(rows);
        const by = a.by as string;
        if (typeof by !== "string") throw new Error("data connector: topN requires by:string");
        assertColumn(rows, by);
        const n = typeof a.n === "number" ? Math.min(a.n, rows.length) : Math.min(10, rows.length);

        const values = rows.map(r => r[by]);
        const isNum = inferType(values) === "number";

        const sorted = [...rows].sort((rowA, rowB) => {
          const av = rowA[by];
          const bv = rowB[by];
          const aNull = av === null || av === undefined || av === "";
          const bNull = bv === null || bv === undefined || bv === "";
          if (aNull && bNull) return 0;
          if (aNull) return 1;
          if (bNull) return -1;
          if (isNum) {
            return (coerceNum(bv) ?? 0) - (coerceNum(av) ?? 0); // desc numeric
          }
          return String(bv) < String(av) ? -1 : String(bv) > String(av) ? 1 : 0;
        });

        return sorted.slice(0, n);
      }

      default:
        throw new Error(`data connector: unknown tool "${tool}"`);
    }
  }
}
