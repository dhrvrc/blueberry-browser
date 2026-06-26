import { writeFile, mkdir, readdir, stat, rm } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
// marked is a pure-JS CommonJS module — require() is the safe import form.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { marked } = require("marked") as { marked: { parse(md: string): string } };

export type FileType = "csv" | "md" | "html" | "text";

const FILES_DIR = join(homedir(), ".blueberry", "files");
const MAX_FILE_DIRS = 50;

// ---------------------------------------------------------------------------
// Name sanitisation
// ---------------------------------------------------------------------------

/** Strip everything but alphanumeric, dot, underscore, hyphen. Fall back to "file". */
function sanitiseName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "");
  // Strip any leading dots (hidden-file convention) and path components.
  const base = cleaned.replace(/^\.+/, "") || "file";
  // Drop any existing extension so we can enforce the correct one.
  return base.replace(/\.[^.]*$/, "") || "file";
}

function extFor(type: FileType): string {
  switch (type) {
    case "csv":  return "csv";
    case "md":   return "md";
    case "html": return "html";
    case "text": return "txt";
  }
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

function pageShell(title: string, bodyHtml: string, extraStyle = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;background:#fff;padding:32px 40px;max-width:960px;margin:0 auto}
${extraStyle}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// CSV → HTML table
// ---------------------------------------------------------------------------

/** Parse a CSV string into rows of cells. Handles quoted fields (commas, newlines, escaped quotes). */
function parseCsv(csv: string): string[][] {
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

function csvToHtml(csv: string): string {
  const rows = parseCsv(csv);
  if (rows.length === 0) return "<p>No data.</p>";

  const tableStyle = `
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid #d1d5db;padding:8px 12px;text-align:left}
th{background:#f3f4f6;font-weight:600}
tr:nth-child(even) td{background:#f9fafb}
tr:hover td{background:#eff6ff}`;

  const [header, ...data] = rows;
  const thead = `<thead><tr>${header.map(h => `<th>${escHtml(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${data.map(r => `<tr>${r.map(c => `<td>${escHtml(c)}</td>`).join("")}</tr>`).join("\n")}</tbody>`;
  return pageShell("Generated CSV", `<table>${thead}${tbody}</table>`, tableStyle);
}

// ---------------------------------------------------------------------------
// Markdown → HTML
// ---------------------------------------------------------------------------

const MD_STYLE = `
h1,h2,h3,h4,h5,h6{margin:1.4em 0 0.5em;line-height:1.25;color:#111}
h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.25em}
p{margin:0.75em 0}
a{color:#2563eb}a:hover{text-decoration:underline}
code{font-family:"SFMono-Regular",Consolas,monospace;font-size:0.875em;background:#f3f4f6;padding:2px 6px;border-radius:3px}
pre{background:#f3f4f6;padding:16px;border-radius:6px;overflow:auto;margin:1em 0}
pre code{background:none;padding:0}
blockquote{border-left:4px solid #d1d5db;padding-left:16px;color:#6b7280;margin:1em 0}
table{border-collapse:collapse;width:100%;margin:1em 0}
th,td{border:1px solid #d1d5db;padding:8px 12px;text-align:left}
th{background:#f3f4f6;font-weight:600}
img{max-width:100%}
ul,ol{padding-left:1.5em;margin:0.75em 0}
li{margin:0.25em 0}
hr{border:none;border-top:1px solid #e5e7eb;margin:2em 0}`;

function mdToHtml(md: string, title: string): string {
  const body = marked.parse(md);
  return pageShell(title, `<article>${body}</article>`, MD_STYLE);
}

// ---------------------------------------------------------------------------
// Text → HTML
// ---------------------------------------------------------------------------

function textToHtml(text: string, title: string): string {
  const preStyle = `pre{white-space:pre-wrap;word-break:break-word;font-family:"SFMono-Regular",Consolas,monospace;font-size:13px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:20px;overflow:auto}`;
  return pageShell(title, `<pre>${escHtml(text)}</pre>`, preStyle);
}

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

async function pruneOldDirs(): Promise<void> {
  try {
    const entries = await readdir(FILES_DIR);
    if (entries.length <= MAX_FILE_DIRS) return;
    // Stat each entry to get mtime.
    const stats = await Promise.all(
      entries.map(async (e) => {
        try {
          const s = await stat(join(FILES_DIR, e));
          return { name: e, mtime: s.mtime.getTime() };
        } catch {
          return null;
        }
      }),
    );
    const valid = stats.filter((s): s is { name: string; mtime: number } => s !== null);
    // Sort ascending by mtime — oldest first.
    valid.sort((a, b) => a.mtime - b.mtime);
    const toDelete = valid.slice(0, valid.length - MAX_FILE_DIRS);
    await Promise.all(toDelete.map(({ name }) => rm(join(FILES_DIR, name), { recursive: true, force: true }).catch(() => {})));
  } catch {
    // Best-effort; ignore errors.
  }
}

// ---------------------------------------------------------------------------
// FileStore
// ---------------------------------------------------------------------------

export class FileStore {
  /**
   * Write a generated file + its rendered viewer to ~/.blueberry/files/<uuid>/.
   * Returns { dir, viewerUrl } — viewerUrl is a file:// URL pointing at index.html.
   */
  async write(
    name: string,
    content: string,
    type: FileType,
  ): Promise<{ dir: string; viewerUrl: string }> {
    const baseName = sanitiseName(name);
    const ext = extFor(type);
    const dir = join(FILES_DIR, randomUUID());
    await mkdir(dir, { recursive: true });

    // Write the raw file.
    const rawName = `${baseName}.${ext}`;
    await writeFile(join(dir, rawName), content, "utf8");

    // Build and write index.html (the rendered viewer).
    let viewerHtml: string;
    switch (type) {
      case "csv":
        viewerHtml = csvToHtml(content);
        break;
      case "md":
        viewerHtml = mdToHtml(content, baseName);
        break;
      case "html":
        // The agent's self-contained HTML is the viewer verbatim.
        viewerHtml = content;
        break;
      case "text":
        viewerHtml = textToHtml(content, baseName);
        break;
    }
    await writeFile(join(dir, "index.html"), viewerHtml, "utf8");

    const viewerUrl = pathToFileURL(join(dir, "index.html")).href;

    // Prune oldest dirs if over cap (best-effort, fire-and-forget).
    pruneOldDirs().catch(() => {});

    return { dir, viewerUrl };
  }
}
