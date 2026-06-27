/**
 * TypeScript type definitions for the `blueberry` SDK as presented to the LLM.
 * Every method is async / Promise-returning — the worker communicates over a
 * MessagePort so there is no synchronous return path.
 *
 * This string is embedded verbatim in the agent system prompt so the model
 * sees the exact types and knows to await every call.
 */
export const SDK_TYPE_DEFS = `
// All blueberry methods are async — always await them.
// The proxy runs in a sandbox and every call is a MessagePort round-trip.

interface BlueberryTab {
  /** Return the full outer HTML of the page. */
  getHtml(tabId?: string): Promise<string>;
  /**
   * Get text content. With no selector: the whole page's visible text.
   * With a CSS selector: the text of the FIRST matching element (trimmed, "" if none).
   * PREFER THIS over runJs for reading text — e.g. getText("#firstHeading").
   */
  getText(selector?: string, tabId?: string): Promise<string>;
  /** Text of EVERY element matching the selector — e.g. getTexts(".title a") for all headlines. */
  getTexts(selector: string, tabId?: string): Promise<string[]>;
  /** Links { text, href } for anchors matching the selector (default "a"). */
  getLinks(selector?: string, tabId?: string): Promise<Array<{ text: string; href: string }>>;
  /** Wait until an element matching the CSS selector appears (or timeout). */
  waitForSelector(selector: string, timeoutMs?: number, tabId?: string): Promise<boolean>;
  /** Capture a screenshot of the tab as a data URL. */
  screenshot(tabId?: string): Promise<string>;
  /** Navigate the tab to a URL (include https://). */
  navigate(url: string, tabId?: string): Promise<void>;
  /**
   * Execute JavaScript in the page and return its result.
   * The code runs via executeJavaScript, so the RESULT IS THE VALUE OF THE LAST
   * EXPRESSION. If you wrap logic in an IIFE you MUST return the value, e.g.
   * (() => { ...; return data; })() — otherwise you get undefined.
   * Only JSON-serializable values cross back: map DOM nodes/NodeLists to plain
   * arrays/objects first, e.g. Array.from(els).map(e => e.textContent).
   */
  runJs(code: string, tabId?: string): Promise<unknown>;
  /** Click the first element matching the CSS selector. */
  click(selector: string, tabId?: string): Promise<void>;
  /** Type text into the first element matching the CSS selector. */
  type(selector: string, text: string, tabId?: string): Promise<void>;
  /** Poll until the JS expression evaluates truthy or the timeout elapses. */
  waitFor(expr: string, timeoutMs?: number, tabId?: string): Promise<boolean>;
}

interface BlueberryMcpFetch {
  /** Fetch a URL and return { status: number, text: string }. */
  get(args: { url: string }): Promise<{ status: number; text: string }>;
}

interface BlueberryMcpFs {
  /** Read a file from the workspace. path is relative to the workspace root. */
  read(args: { path: string }): Promise<string>;
  /** Write a file to the workspace. path is relative. Returns ok and the relative path. */
  write(args: { path: string; content: string }): Promise<{ ok: true; path: string }>;
  /** List entries in a workspace directory. path defaults to the workspace root. */
  list(args: { path?: string }): Promise<Array<{ name: string; isDir: boolean; size: number }>>;
  /** Delete a file or directory in the workspace. path must be relative. */
  delete(args: { path: string }): Promise<{ ok: true }>;
}

interface BlueberryMcpData {
  /** Parse a CSV string into an array of row objects keyed by header. */
  parseCsv(args: { content: string }): Promise<Array<Record<string, unknown>>>;
  /** Parse a JSON string into an array of row objects. Accepts array, {data:[...]}, or {rows:[...]}. */
  parseJson(args: { content: string }): Promise<Array<Record<string, unknown>>>;
  /** Summarize rows: row count and per-column stats (type, count, nulls, distinct, min, max, mean, sample). */
  summarize(args: { rows: Array<Record<string, unknown>> }): Promise<{
    rowCount: number;
    columns: Array<{
      name: string;
      type: "number" | "string";
      count: number;
      nulls: number;
      distinct: number;
      min: number | string | null;
      max: number | string | null;
      mean: number | null;
      sample: unknown;
    }>;
  }>;
  /** Group rows by a column and aggregate another column. op: "sum"|"avg"|"count"|"min"|"max". */
  groupBy(args: {
    rows: Array<Record<string, unknown>>;
    by: string;
    agg: { column: string; op: "sum" | "avg" | "count" | "min" | "max" };
  }): Promise<Array<Record<string, unknown>>>;
  /** Filter rows by a structured predicate. op: "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"contains". */
  filter(args: {
    rows: Array<Record<string, unknown>>;
    where: { column: string; op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains"; value: string | number };
  }): Promise<Array<Record<string, unknown>>>;
  /** Sort rows by a column. dir defaults to "asc". Nulls sort last. */
  sort(args: {
    rows: Array<Record<string, unknown>>;
    by: string;
    dir?: "asc" | "desc";
  }): Promise<Array<Record<string, unknown>>>;
  /** Return the top n rows sorted descending by a numeric column. n defaults to 10. */
  topN(args: {
    rows: Array<Record<string, unknown>>;
    by: string;
    n?: number;
  }): Promise<Array<Record<string, unknown>>>;
}

interface BlueberryMcp {
  fetch: BlueberryMcpFetch;
  /** Sandboxed workspace filesystem: read/write/list/delete relative to ~/.blueberry/workspace/. */
  fs: BlueberryMcpFs;
  /** In-process DataFrame-lite: parse CSV/JSON, summarize, groupBy, filter, sort, topN. */
  data: BlueberryMcpData;
}

declare const blueberry: {
  tab: BlueberryTab;
  /** Send a status message visible to the user in real time. */
  notifyUser(message: string): Promise<void>;
  /**
   * Request human approval before a destructive or irreversible action.
   * Returns true if approved, false if denied.
   * Use ONLY for purchases, deletes, form submissions that cannot be undone.
   * Run autonomously for everything else.
   */
  requireApproval(message: string): Promise<boolean>;
  mcp: BlueberryMcp;
  /**
   * Spawn a child agent to do an independent sub-task in its own tab.
   * Resolves with its result string. Use Promise.all for parallel children.
   * Max depth 2, ~8 agents total.
   */
  spawn(task: string): Promise<string>;
  /**
   * Write a file the user can find on disk and open it as a rendered browser tab.
   * type "csv" renders a styled table, "md" renders markdown, "html" renders your
   * page verbatim (write a SELF-CONTAINED page: inline CSS/JS, no external or CDN
   * scripts -- the page loads from file:// with web security on, so external
   * resources are blocked), "text" shows plain text.
   * content is the raw file string. Returns the file:// URL of the viewer.
   * Prefer showFile (opens a tab) when the user wants something visual or savable.
   */
  showFile(name: string, content: string, type: "csv" | "md" | "html" | "text"): Promise<string>;
  /** Like showFile but only writes the file without opening a new tab. Returns the file:// URL. */
  createFile(name: string, content: string, type: "csv" | "md" | "html" | "text"): Promise<string>;
};
`.trim();
