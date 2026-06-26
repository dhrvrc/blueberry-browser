import type { WebContents } from "electron";
import type { AgentEvent, AutomationSummary } from "../../shared/ipc-schema";
import type { TabService } from "../TabService";
import type { LLMClient } from "../LLMClient";
import type { CoreMessage } from "ai";
import { BlueberrySDK } from "./BlueberrySDK";
import { McpClient } from "./McpClient";
import { AutomationStore } from "./AutomationStore";
import { AgentStore } from "./AgentStore";
import type { IAgentStore } from "./AgentStore";
import { AgentRunner } from "./AgentRunner";

/**
 * In-memory AgentStore for ephemeral child agents.
 * Children don't persist history — they run once and are discarded.
 * Structurally compatible with AgentStore (same load/append signatures).
 */
class EphemeralStore implements IAgentStore {
  private history: CoreMessage[] = [];

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  load(_agentId: string): Promise<CoreMessage[]> {
    return Promise.resolve(this.history);
  }

  append(_agentId: string, msg: CoreMessage): void {
    this.history.push(msg);
  }
}

// Only the root agent may spawn: root = depth 0, its children = depth 1, and a
// depth-1 agent is not allowed to spawn further (one level deep for now).
const MAX_DEPTH = 1;
const MAX_CONCURRENT_AGENTS = 6;

/**
 * Top-level agent coordinator owned by SideBar. Constructs the object graph
 * (SDK, stores, runners) and exposes the six operations called by AgentIPC.
 * Emits agent-event via raw webContents.send — NOT a typedHandle channel.
 *
 * In multi-agent mode, runners is a Map keyed by dotted agentId:
 *   root: "agent-1"
 *   children: "agent-1.1", "agent-1.2", "agent-1.1.1", …
 *
 * Depth is segments - 1 (e.g. "agent-1.2.1" → 3 segments → depth 2).
 */
export class AgentService {
  private readonly webContents: WebContents;
  private readonly tabService: TabService;
  private readonly llm: LLMClient;
  private readonly automationStore: AutomationStore;
  private readonly agentStore: AgentStore;
  private readonly mcp: McpClient;
  /** Registry of all live runners keyed by agentId. */
  private readonly runners = new Map<string, AgentRunner>();
  /** Per-parent child counter for generating dotted IDs. */
  private readonly childCounters = new Map<string, number>();
  /** The root agentId — constant for the service's lifetime. */
  readonly agentId = "agent-1";

  constructor(webContents: WebContents, tabService: TabService, llm: LLMClient) {
    this.webContents = webContents;
    this.tabService = tabService;
    this.llm = llm;
    this.automationStore = new AutomationStore();
    this.agentStore = new AgentStore();
    this.mcp = new McpClient();

    // Build and register the root runner.
    const rootRunner = this.buildRunner(this.agentId, null, this.agentStore);
    this.runners.set(this.agentId, rootRunner);
  }

  // ─── Public API (called by AgentIPC) ────────────────────────────────────────

  async run(task: string): Promise<{ agentId: string }> {
    const root = this.runners.get(this.agentId);
    if (!root) throw new Error("Root runner not found");
    root.run(task).catch((e) => console.error("AgentService.run error:", e));
    return { agentId: this.agentId };
  }

  abort(agentId: string): void {
    // Collect matching ids (this agent + all descendants).
    const matchingIds = Array.from(this.runners.keys()).filter(
      (id) => id === agentId || id.startsWith(agentId + "."),
    );

    // Abort children first: sort deepest (most dots) first.
    matchingIds.sort((a, b) => this.depthOf(b) - this.depthOf(a));

    for (const id of matchingIds) {
      const runner = this.runners.get(id);
      if (runner) {
        runner.abort();
        runner.dispose();
        this.runners.delete(id);
      }
    }

    // Re-register root if it was aborted, so next run() works.
    // Background tabs for child agents are cleaned up by spawnChild's finally block.
    if (agentId === this.agentId && !this.runners.has(this.agentId)) {
      const rootRunner = this.buildRunner(this.agentId, null, this.agentStore);
      this.runners.set(this.agentId, rootRunner);
    }
  }

  resolveApproval(agentId: string, requestId: string, approved: boolean): void {
    this.runners.get(agentId)?.resolveApproval(requestId, approved);
  }

  async save(agentId: string, name: string): Promise<{ id: string } | null> {
    if (agentId !== this.agentId) return null;
    const runner = this.runners.get(this.agentId);
    if (!runner) return null;
    const script = runner.getLastScript();
    if (!script) return null;
    const history = await this.agentStore.load(agentId);
    const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
    const task = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "(agent task)";
    const automation = await this.automationStore.save(name, task, script);
    return { id: automation.id };
  }

  async replay(automationId: string): Promise<{ agentId: string } | null> {
    const automation = await this.automationStore.get(automationId);
    if (!automation) return null;
    const runner = this.runners.get(this.agentId);
    if (!runner) return null;
    runner.replay(automation.script).catch((e) => console.error("AgentService.replay error:", e));
    return { agentId: this.agentId };
  }

  async listAutomations(): Promise<AutomationSummary[]> {
    return this.automationStore.list();
  }

  /** Open an agent-generated file viewer (file:// URL) in a new focused tab. */
  openFile(url: string): void {
    this.tabService.openUserTab(url);
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private emit(e: AgentEvent): void {
    this.webContents.send("agent-event", e);
  }

  private depthOf(agentId: string): number {
    return agentId.split(".").length - 1;
  }

  private nextChildId(parentId: string): string {
    const n = (this.childCounters.get(parentId) ?? 0) + 1;
    this.childCounters.set(parentId, n);
    return `${parentId}.${n}`;
  }

  /**
   * Build a runner + its SDK wired together.
   * The requestApproval forward-reference pattern: construct a holder object,
   * build the SDK pointing at it, then fill it once the runner exists.
   */
  private buildRunner(
    agentId: string,
    ownedTabId: string | null,
    store: IAgentStore,
  ): AgentRunner {
    // Forward reference: the SDK's requestApproval will call whichever runner
    // is registered for this agentId at call time — so we use a late-bound closure.
    const requestApproval = (aid: string, message: string): Promise<boolean> => {
      const runner = this.runners.get(aid);
      if (!runner) return Promise.resolve(false);
      return runner.handleApprovalRequest(aid, message);
    };

    const sdk = new BlueberrySDK(this.tabService, {
      agentId,
      emit: (e) => this.emit(e),
      requestApproval,
      mcp: this.mcp,
      ownedTabId,
      spawn: (pid, task) => this.spawnChild(pid, task),
    });

    const runner = new AgentRunner(agentId, {
      tabService: this.tabService,
      emit: (e) => this.emit(e),
      llm: this.llm,
      sdk,
      store,
      spawn: (pid, task) => this.spawnChild(pid, task),
      // Children own a tab; the root uses the active tab. Children are sub-agents.
      isSubAgent: ownedTabId !== null,
    });

    return runner;
  }

  /**
   * Spawn a child agent: creates its own tab, runner, and SDK.
   * Resolves with the child's return value (never rejects — failures return a sentinel).
   */
  async spawnChild(parentId: string, task: string): Promise<string> {
    const depth = this.depthOf(parentId);
    if (depth >= MAX_DEPTH) {
      this.emit({ kind: "agent-done", agentId: `${parentId}.?`, ok: false, error: "max depth reached" });
      return "[spawn rejected: max depth reached]";
    }
    if (this.runners.size >= MAX_CONCURRENT_AGENTS) {
      return "[spawn rejected: agent limit reached]";
    }

    const childId = this.nextChildId(parentId);

    this.emit({ kind: "agent-spawned", agentId: childId, parentId, task });

    let tabId: string;
    try {
      tabId = this.tabService.createBackgroundTab();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ kind: "agent-done", agentId: childId, ok: false, error: msg });
      return `[spawn rejected: ${msg}]`;
    }

    const child = this.buildRunner(childId, tabId, new EphemeralStore());
    this.runners.set(childId, child);

    try {
      const result = await child.runCapture(task);
      this.emit({ kind: "agent-done", agentId: childId, ok: true, result });
      return result;
    } catch (err) {
      // runCapture never throws — this is a safety net.
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ kind: "agent-done", agentId: childId, ok: false, error: msg });
      return `[agent ${childId} failed: ${msg}]`;
    } finally {
      child.dispose();
      this.runners.delete(childId);
      this.tabService.destroyBackgroundTab(tabId);
    }
  }
}
