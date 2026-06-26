import type { TabService } from "../TabService";
import type { AgentEvent } from "../../shared/ipc-schema";
import type { McpClient } from "./McpClient";
import { FileStore, type FileType } from "./FileStore";

export type { FileType };

const OVERLAY_DELAY_MS = 400;

// JS strings injected via runJs for Set-of-Marks overlays.
// JSON.stringify is used on the selector to avoid injection issues.
const OVERLAY_SHOW_JS = (selector: string, label: string): string => `
(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return;
  const r = el.getBoundingClientRect();
  const d = document.createElement('div');
  d.id = '__blueberry_som';
  d.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'pointer-events:none',
    'border:2px solid rgba(59,130,246,0.8)',
    'background:rgba(59,130,246,0.08)',
    'border-radius:3px',
    'box-sizing:border-box',
    \`top:\${r.top}px\`,
    \`left:\${r.left}px\`,
    \`width:\${r.width}px\`,
    \`height:\${r.height}px\`,
  ].join(';');
  const lbl = document.createElement('span');
  lbl.textContent = ${JSON.stringify(label)};
  lbl.style.cssText = 'position:absolute;top:-18px;left:0;font:bold 11px/1 monospace;color:rgba(59,130,246,1);background:#fff;padding:1px 4px;border-radius:2px;';
  d.appendChild(lbl);
  document.body.appendChild(d);
})();
`;

const OVERLAY_HIDE_JS = `
(function() {
  const d = document.getElementById('__blueberry_som');
  if (d) d.remove();
})();
`;

interface SdkContext {
  emit: (e: AgentEvent) => void;
  requestApproval: (agentId: string, message: string) => Promise<boolean>;
  mcp: McpClient;
  agentId: string;
  /** The background tab owned by this agent (child agents), or null (root uses active tab). */
  ownedTabId: string | null;
  /** Spawn a child agent; resolves with its result string. */
  spawn: (parentId: string, task: string) => Promise<string>;
}

export class BlueberrySDK {
  private readonly fileStore = new FileStore();

  constructor(
    private readonly tabService: TabService,
    private readonly ctx: SdkContext,
  ) {}

  private activeId(): string {
    const tab = this.tabService.activeTab();
    if (!tab) throw new Error("No active tab");
    return tab.id;
  }

  private resolveId(tabId?: string): string {
    // Explicit tabId wins; then own background tab (child agents); then active tab (root).
    if (tabId) return tabId;
    if (this.ctx.ownedTabId) return this.ctx.ownedTabId;
    return this.activeId();
  }

  async getHtml(tabId?: string): Promise<string> {
    return this.tabService.getHtml(this.resolveId(tabId));
  }

  /**
   * Page text, or the text of the first NON-EMPTY element matching `selector`.
   * Skips whitespace-only matches (e.g. Wikipedia's empty leading <p>) so the
   * agent rarely needs runJs for reading content.
   */
  async getText(selector?: string, tabId?: string): Promise<string> {
    if (!selector) return this.tabService.getText(this.resolveId(tabId));
    const js = `(() => {
      const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      for (const el of els) {
        const t = (el.innerText || el.textContent || "").trim();
        if (t) return t;
      }
      return "";
    })()`;
    return (await this.runJs(js, tabId)) as string;
  }

  /** Text of EVERY element matching `selector` (e.g. all headlines). */
  async getTexts(selector: string, tabId?: string): Promise<string[]> {
    const js = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(el => (el.innerText || el.textContent || "").trim()).filter(Boolean)`;
    return (await this.runJs(js, tabId)) as string[];
  }

  /** Links ({text, href}) for every anchor matching `selector` (default: all <a>). */
  async getLinks(selector = "a", tabId?: string): Promise<Array<{ text: string; href: string }>> {
    const js = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(a => ({ text: (a.textContent || "").trim(), href: a.href || "" })).filter(l => l.href)`;
    return (await this.runJs(js, tabId)) as Array<{ text: string; href: string }>;
  }

  /** Wait until `selector` appears on the page (or timeout). */
  async waitForSelector(selector: string, timeoutMs = 10000, tabId?: string): Promise<boolean> {
    return this.waitFor(`document.querySelector(${JSON.stringify(selector)})`, timeoutMs, tabId);
  }

  async screenshot(tabId?: string): Promise<string> {
    return this.tabService.screenshot(this.resolveId(tabId));
  }

  async navigate(url: string, tabId?: string): Promise<void> {
    try {
      await this.tabService.navigate(this.resolveId(tabId), url);
    } catch (err) {
      // ERR_ABORTED (-3) means the load was superseded by a redirect or a
      // following navigation — benign for an agent (the page still loads).
      // Surface other failures (DNS, connection refused, etc.).
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("ERR_ABORTED")) throw err;
    }
  }

  async runJs(code: string, tabId?: string): Promise<unknown> {
    const id = this.resolveId(tabId);
    // Run the snippet AS WRITTEN inside a try/catch so an in-page throw comes
    // back as a real message (Electron otherwise reports "Script failed to
    // execute" with no detail, and the agent has no renderer console). The
    // snippet stays the body of an async arrow, so it keeps last-expression /
    // IIFE semantics exactly as plain executeJavaScript would — we do NOT
    // transpile or re-wrap it (that corrupted regexes and broke extraction).
    const wrapped =
      `(async () => { try { return (${code}\n); }` +
      ` catch (e) { return { __blueberryError: (e && e.message) ? String(e.message) : String(e) }; } })()`;
    let result: unknown;
    try {
      result = await this.tabService.runJs(id, wrapped);
    } catch {
      // The snippet wasn't a single expression (e.g. top-level statements with
      // their own `return`). Run it raw — original behavior, no corruption.
      result = await this.tabService.runJs(id, code);
    }
    if (result && typeof result === "object" && "__blueberryError" in result) {
      throw new Error(`runJs error in page: ${(result as { __blueberryError: string }).__blueberryError}`);
    }
    return result;
  }

  async click(selector: string, tabId?: string): Promise<void> {
    const id = this.resolveId(tabId);
    // Show overlay
    this.ctx.emit({ kind: "overlay", agentId: this.ctx.agentId, selector, action: "click", phase: "show" });
    await this.tabService.runJs(id, OVERLAY_SHOW_JS(selector, "click"));
    await delay(OVERLAY_DELAY_MS);
    // Perform click
    await this.tabService.runJs(id, `document.querySelector(${JSON.stringify(selector)})?.click()`);
    // Remove overlay
    await this.tabService.runJs(id, OVERLAY_HIDE_JS);
    this.ctx.emit({ kind: "overlay", agentId: this.ctx.agentId, selector, action: "click", phase: "hide" });
  }

  async type(selector: string, text: string, tabId?: string): Promise<void> {
    const id = this.resolveId(tabId);
    this.ctx.emit({ kind: "overlay", agentId: this.ctx.agentId, selector, action: "type", phase: "show" });
    await this.tabService.runJs(id, OVERLAY_SHOW_JS(selector, "type"));
    await delay(OVERLAY_DELAY_MS);
    // Set value and dispatch input/change events
    await this.tabService.runJs(
      id,
      `(function(){
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSet) nativeSet.call(el, ${JSON.stringify(text)});
        else el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
    );
    await this.tabService.runJs(id, OVERLAY_HIDE_JS);
    this.ctx.emit({ kind: "overlay", agentId: this.ctx.agentId, selector, action: "type", phase: "hide" });
  }

  async waitFor(expr: string, timeoutMs = 10000, tabId?: string): Promise<boolean> {
    const id = this.resolveId(tabId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.tabService.runJs(id, `!!(${expr})`);
      if (result) return true;
      await delay(250);
    }
    return false;
  }

  async notifyUser(message: string): Promise<void> {
    this.ctx.emit({ kind: "status", agentId: this.ctx.agentId, text: message });
  }

  async requireApproval(message: string): Promise<boolean> {
    return this.ctx.requestApproval(this.ctx.agentId, message);
  }

  async mcpCall(server: string, tool: string, args: unknown): Promise<unknown> {
    return this.ctx.mcp.call(server, tool, args);
  }

  /**
   * Spawn a child agent to run an independent sub-task in its own tab.
   * Resolves with the child's result string. Use Promise.all for parallel children.
   */
  async spawn(task: string): Promise<string> {
    return this.ctx.spawn(this.ctx.agentId, task);
  }

  /**
   * Write a file to ~/.blueberry/files/ and return its file:// viewer URL.
   * Does NOT open a browser tab — use showFile to also open it for the user.
   */
  async createFile(name: string, content: string, type: FileType): Promise<string> {
    const { viewerUrl } = await this.fileStore.write(name, content, type);
    return viewerUrl;
  }

  /**
   * Write a file to ~/.blueberry/files/ and surface it to the user as a
   * clickable card in the chat (via the `file` event). The user clicks the
   * card to open the rendered viewer in a tab — we do NOT auto-open it.
   * Returns the file:// viewer URL.
   */
  async showFile(name: string, content: string, type: FileType): Promise<string> {
    const { viewerUrl } = await this.fileStore.write(name, content, type);
    this.ctx.emit({ kind: "file", agentId: this.ctx.agentId, name, fileType: type, url: viewerUrl });
    return viewerUrl;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
