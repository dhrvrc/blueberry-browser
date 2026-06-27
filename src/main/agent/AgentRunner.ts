import { utilityProcess, MessageChannelMain } from "electron";
import { join } from "path";
import type { AgentEvent } from "../../shared/ipc-schema";
import type { TabService } from "../TabService";
import type { LLMClient } from "../LLMClient";
import type { BlueberrySDK } from "./BlueberrySDK";
import type { FileType } from "./FileStore";
import type { IAgentStore } from "./AgentStore";
import { stripTypes } from "./transpile";

const RUN_TIMEOUT_MS = 120_000;
// CodeAct error-retry: if a run errors, the agent sees the error and rewrites
// the code, up to this many total attempts (1 initial + retries).
const MAX_ATTEMPTS = 3;
// How many recent history messages (user+assistant) to send to the model.
const HISTORY_TURNS = 6;

interface Deps {
  tabService: TabService;
  emit: (e: AgentEvent) => void;
  llm: LLMClient;
  sdk: BlueberrySDK;
  store: IAgentStore;
  /** Spawn a child agent; resolves with its result string. */
  spawn: (parentId: string, task: string) => Promise<string>;
  /** Spawned children use the cheaper sub-agent model tier. */
  isSubAgent?: boolean;
}

// Pending approval: parks until resolveApproval is called.
interface PendingApproval {
  resolve: (approved: boolean) => void;
}

export class AgentRunner {
  private readonly agentId: string;
  private readonly deps: Deps;
  private worker: Electron.UtilityProcess | null = null;
  private port: Electron.MessagePortMain | null = null;
  private abortController: AbortController | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  private lastScript: string | null = null;
  private approvalCounter = 0;
  private aborted = false;
  // Runtime errors observed during the current step (SDK errors surfaced as
  // error observations). Populated by dispatchSdkCall; cleared at the start
  // of each step so one step's errors don't bleed into the next.
  private runErrors: string[] = [];
  // The in-flight script run, settled by exec-done/exec-error or rejected on
  // worker death (abort/timeout/crash). Tracked here so the single persistent
  // port listener can resolve it without swapping handlers per run.
  private activeRun: { runId: string; resolve: () => void; reject: (e: Error) => void } | null = null;
  // The return value from the most recent worker "return" message (cleared on
  // attempt start — must not inherit a prior attempt's value).
  private lastReturn: string | null = null;

  constructor(agentId: string, deps: Deps) {
    this.agentId = agentId;
    this.deps = deps;
  }

  /**
   * Fire-and-forget: run a new task through the multi-turn eval loop.
   * Callers that need the return value use runCapture instead.
   */
  run(task: string): Promise<void> {
    return this.executeRun(task);
  }

  /**
   * Run the task and return this agent's final return value.
   * On any error or abort, resolves with a sentinel string rather than rejecting,
   * so a failed child does NOT reject the parent's Promise.all.
   */
  async runCapture(task: string): Promise<string> {
    try {
      await this.executeRun(task);
      return this.lastReturn ?? "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `[agent ${this.agentId} failed: ${msg}]`;
    }
  }

  /**
   * Single-shot CodeAct eval loop with an error-retry: generate code, run it,
   * and on a thrown error feed the error back and regenerate (up to MAX_ATTEMPTS).
   * A prose-only response (no code block) is a conversational answer.
   * Both run() and runCapture() delegate here.
   */
  private async executeRun(task: string): Promise<void> {
    this.abortController = new AbortController();
    this.aborted = false;
    this.lastReturn = null;
    const { emit, store } = this.deps;

    emit({ kind: "run-start", agentId: this.agentId, task });
    store.append(this.agentId, { role: "user", content: task });

    try {
      let instruction = task;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (this.aborted) break;
        const error = await this.attempt(instruction, attempt);
        if (!error) {
          emit({ kind: "run-end", agentId: this.agentId, ok: true });
          return;
        }
        if (attempt < MAX_ATTEMPTS) {
          emit({
            kind: "observation",
            agentId: this.agentId,
            stream: "warn",
            text: "Hit an error — feeding it back to the agent to correct and re-run.",
          });
          instruction =
            `Your previous code failed with this error:\n${error}\n\n` +
            `Here is the code you ran:\n${this.lastScript ?? "(none)"}\n\n` +
            `Fix the problem and return corrected code for the original task: ${task}`;
        } else {
          emit({ kind: "run-end", agentId: this.agentId, ok: false, error });
        }
      }
    } catch (err) {
      if (this.aborted || (err as Error)?.name === "AbortError") {
        emit({ kind: "run-end", agentId: this.agentId, ok: false, error: "aborted" });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ kind: "run-end", agentId: this.agentId, ok: false, error: msg });
      }
    } finally {
      this.abortController = null;
    }
  }

  /**
   * One attempt: stream an LLM turn, then either run its code or (if prose-only)
   * treat the prose as the final answer. Returns an error string if the attempt
   * failed (script threw, transpile error, or a runtime SDK error), or null on success.
   */
  private async attempt(instruction: string, attempt: number): Promise<string | null> {
    const { emit, llm, store } = this.deps;
    this.runErrors = [];
    this.lastReturn = null;

    if (attempt > 1) emit({ kind: "attempt-start", agentId: this.agentId });

    const fullHistory = await store.load(this.agentId);
    const history = fullHistory.slice(0, -1).slice(-HISTORY_TURNS);

    const stepId = `llm-${attempt}`;
    const label = attempt === 1 ? "Generating code" : "Revising code";
    emit({ kind: "step", agentId: this.agentId, stepId, label, status: "running" });

    const fullText = await llm.streamCodeAct(
      instruction,
      await this.buildContext(),
      history,
      (delta) => emit({ kind: "reasoning", agentId: this.agentId, text: delta }),
      (delta) => emit({ kind: "code", agentId: this.agentId, delta }),
      this.abortController!.signal,
      this.deps.isSubAgent ? "sub" : "root",
    );
    emit({ kind: "step", agentId: this.agentId, stepId, label, status: "done" });

    const code = extractCode(fullText);
    store.append(this.agentId, { role: "assistant", content: fullText });

    // No code block → conversational answer.
    if (code === null) {
      const answer = extractProse(fullText);
      this.lastReturn = answer;
      emit({ kind: "answer", agentId: this.agentId, text: answer });
      return null;
    }

    emit({ kind: "code-complete", agentId: this.agentId, code });

    const tStep = `transpile-${attempt}`;
    emit({ kind: "step", agentId: this.agentId, stepId: tStep, label: "Compiling", status: "running" });
    let compiledJs: string;
    try {
      compiledJs = stripTypes(code);
    } catch (err) {
      const msg = `Compile error: ${err instanceof Error ? err.message : String(err)}`;
      emit({ kind: "observation", agentId: this.agentId, stream: "error", text: msg });
      emit({ kind: "step", agentId: this.agentId, stepId: tStep, label: "Compiling", status: "error", detail: msg });
      return msg;
    }
    emit({ kind: "step", agentId: this.agentId, stepId: tStep, label: "Compiling", status: "done" });

    this.lastScript = compiledJs;
    try {
      await this.runScript(compiledJs);
    } catch (err) {
      if (this.aborted) throw err;
      return err instanceof Error ? err.message : String(err);
    }
    // A script that finished but had SDK errors (e.g. a runJs failure) is retry-worthy.
    return this.runErrors.length > 0 ? this.runErrors.join("; ") : null;
  }

  /** Replay a saved compiled script — skips LLM, steps 2–5. Zero model cost. */
  async replay(script: string): Promise<void> {
    this.abortController = new AbortController();
    this.aborted = false;
    const { emit } = this.deps;
    emit({ kind: "run-start", agentId: this.agentId, task: "(replay)" });
    emit({ kind: "code-complete", agentId: this.agentId, code: script });
    emit({ kind: "step", agentId: this.agentId, stepId: "replay", label: "Replaying saved automation", status: "running" });
    try {
      await this.runScript(script);
      this.lastScript = script;
      emit({ kind: "step", agentId: this.agentId, stepId: "replay", label: "Replaying saved automation", status: "done" });
      emit({ kind: "run-end", agentId: this.agentId, ok: true });
    } catch (err) {
      const aborted = this.aborted;
      const msg = aborted ? "aborted" : err instanceof Error ? err.message : String(err);
      emit({ kind: "step", agentId: this.agentId, stepId: "replay", label: "Replaying saved automation", status: "error", detail: msg });
      emit({ kind: "run-end", agentId: this.agentId, ok: false, error: msg });
    } finally {
      this.abortController = null;
    }
  }

  abort(): void {
    // Mark first so the in-flight run()'s catch reports a single "aborted"
    // run-end (killing the worker rejects runScript via the exit handler).
    this.aborted = true;
    this.abortController?.abort();
    this.killWorker("aborted");
    // Reject any parked approvals.
    for (const [, p] of this.pendingApprovals) p.resolve(false);
    this.pendingApprovals.clear();
  }

  resolveApproval(requestId: string, approved: boolean): void {
    const p = this.pendingApprovals.get(requestId);
    if (!p) return;
    this.pendingApprovals.delete(requestId);
    this.deps.emit({ kind: "approval-resolved", agentId: this.agentId, requestId, approved });
    p.resolve(approved);
  }

  getLastScript(): string | null {
    return this.lastScript;
  }

  dispose(): void {
    this.killWorker("disposed");
    this.pendingApprovals.clear();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async buildContext(): Promise<{ url: string | null; pageText: string | null; screenshot: string | null }> {
    const tab = this.deps.tabService.activeTab();
    if (!tab) return { url: null, pageText: null, screenshot: null };
    // The agent prompt does NOT send the screenshot (only the chat path does),
    // so don't capture it here — it's wasted work + latency. Page text is
    // trimmed to keep the request well under the model's token budget; the
    // agent re-reads the page itself with getText/runJs when it needs more.
    let pageText: string | null = null;
    try {
      pageText = (await this.deps.tabService.getText(tab.id)).slice(0, 2000);
    } catch {
      pageText = null;
    }
    return { url: tab.url, screenshot: null, pageText };
  }

  private ensureWorker(): void {
    if (this.worker) return;

    // Lazy-spawn a fresh utilityProcess.
    this.worker = utilityProcess.fork(
      join(__dirname, "sandbox.worker.js"),
      [],
      { stdio: "pipe", serviceName: "blueberry-agent" },
    );

    // Capture stdout/stderr → observation events.
    this.worker.stdout?.on("data", (buf: Buffer) => {
      this.deps.emit({ kind: "observation", agentId: this.agentId, stream: "stdout", text: buf.toString() });
    });
    this.worker.stderr?.on("data", (buf: Buffer) => {
      this.deps.emit({ kind: "observation", agentId: this.agentId, stream: "error", text: buf.toString() });
    });

    this.worker.on("exit", () => {
      this.worker = null;
      this.port = null;
      // If a run was in flight when the worker died, settle it (abort/crash).
      this.failActiveRun(new Error("Agent worker exited"));
    });

    // Wire the MessageChannel.
    const { port1, port2 } = new MessageChannelMain();
    this.port = port1;
    // Transfer port2 to the worker.
    this.worker.postMessage({ type: "port" }, [port2]);

    // Single persistent listener for the worker's lifetime.
    this.port.on("message", (e: Electron.MessageEvent) => {
      this.handleWorkerMessage(e.data as WorkerMessage);
    });
    this.port.start();
  }

  private runScript(compiledJs: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ensureWorker();
      const runId = `run-${Date.now()}`;

      const timeout = setTimeout(() => {
        this.killWorker("timeout"); // exit handler fails the active run
      }, RUN_TIMEOUT_MS);

      this.activeRun = {
        runId,
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      };
      this.port!.postMessage({ type: "exec", runId, code: compiledJs });
    });
  }

  /** Settle the in-flight script run with a failure (worker death/timeout). */
  private failActiveRun(err: Error): void {
    const run = this.activeRun;
    if (!run) return;
    this.activeRun = null;
    run.reject(err);
  }

  /** Dispatch a message from the worker. Explicit table — no blind property access. */
  private handleWorkerMessage(msg: WorkerMessage): void {
    if (msg.type === "call") {
      this.dispatchSdkCall(msg);
    } else if (msg.type === "console") {
      const stream = msg.level === "error" ? "error" : msg.level === "warn" ? "warn" : "stdout";
      this.deps.emit({ kind: "observation", agentId: this.agentId, stream, text: msg.text ?? "" });
    } else if (msg.type === "return") {
      // Only honor a return for the run currently in flight (runs are
      // sequential per runner, but this guards against a stale message).
      if (this.activeRun?.runId === msg.runId) this.lastReturn = msg.text ?? "";
      this.deps.emit({ kind: "observation", agentId: this.agentId, stream: "return", text: msg.text ?? "" });
    } else if (msg.type === "missed-await") {
      this.deps.emit({ kind: "observation", agentId: this.agentId, stream: "warn", text: msg.text ?? "⚠ Missed await" });
    } else if (msg.type === "exec-done") {
      const run = this.activeRun;
      if (run && run.runId === msg.runId) {
        this.activeRun = null;
        run.resolve();
      }
    } else if (msg.type === "exec-error") {
      const run = this.activeRun;
      if (run && run.runId === msg.runId) {
        this.activeRun = null;
        this.deps.emit({ kind: "observation", agentId: this.agentId, stream: "error", text: msg.error ?? "Script error" });
        run.reject(new Error(msg.error ?? "Script error"));
      }
    }
  }

  private async dispatchSdkCall(msg: WorkerMessage): Promise<void> {
    const { id, method, args = [] } = msg;
    const { sdk, emit } = this.deps;
    try {
      let result: unknown;

      // Explicit dispatch table — capability-safe (no blind property access).
      if (method === "tab.getHtml") {
        result = await sdk.getHtml(args[0] as string | undefined);
      } else if (method === "tab.getText") {
        result = await sdk.getText(args[0] as string | undefined, args[1] as string | undefined);
      } else if (method === "tab.getTexts") {
        result = await sdk.getTexts(args[0] as string, args[1] as string | undefined);
      } else if (method === "tab.getLinks") {
        result = await sdk.getLinks(args[0] as string | undefined, args[1] as string | undefined);
      } else if (method === "tab.waitForSelector") {
        result = await sdk.waitForSelector(args[0] as string, args[1] as number | undefined, args[2] as string | undefined);
      } else if (method === "tab.screenshot") {
        result = await sdk.screenshot(args[0] as string | undefined);
      } else if (method === "tab.navigate") {
        result = await sdk.navigate(args[0] as string, args[1] as string | undefined);
      } else if (method === "tab.runJs") {
        result = await sdk.runJs(args[0] as string, args[1] as string | undefined);
      } else if (method === "tab.click") {
        result = await sdk.click(args[0] as string, args[1] as string | undefined);
      } else if (method === "tab.type") {
        result = await sdk.type(args[0] as string, args[1] as string, args[2] as string | undefined);
      } else if (method === "tab.waitFor") {
        result = await sdk.waitFor(args[0] as string, args[1] as number | undefined, args[2] as string | undefined);
      } else if (method === "notifyUser") {
        result = await sdk.notifyUser(args[0] as string);
      } else if (method === "createFile") {
        result = await sdk.createFile(args[0] as string, args[1] as string, args[2] as FileType);
      } else if (method === "showFile") {
        result = await sdk.showFile(args[0] as string, args[1] as string, args[2] as FileType);
      } else if (method === "spawn") {
        result = await this.deps.spawn(this.agentId, args[0] as string);
      } else if (method === "requireApproval") {
        result = await this.handleApproval(args[0] as string);
      } else if (method?.startsWith("mcp.")) {
        // mcp.<server>.<tool> → sdk.mcpCall(server, tool, args[0])
        const parts = method.split(".");
        if (parts.length >= 3) {
          result = await sdk.mcpCall(parts[1], parts[2], args[0]);
        } else {
          throw new Error(`Invalid mcp method: ${method}`);
        }
      } else {
        throw new Error(`Unknown SDK method: ${method}`);
      }

      // The worker may have been killed mid-call (abort/timeout) — if so the
      // port is gone and there is nothing to reply to.
      this.port?.postMessage({ type: "result", id, value: result ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.port?.postMessage({ type: "error", id, message, stack });
      const text = `SDK error (${method}): ${message}`;
      this.runErrors.push(text);
      emit({ kind: "observation", agentId: this.agentId, stream: "error", text });
    }
  }

  private handleApproval(message: string): Promise<boolean> {
    const requestId = `req-${++this.approvalCounter}`;
    this.deps.emit({ kind: "approval-request", agentId: this.agentId, requestId, message });
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(requestId, { resolve });
    });
  }

  /**
   * Public seam used by BlueberrySDK (via AgentService) to park an approval
   * request and wait for resolveApproval to be called from IPC.
   */
  handleApprovalRequest(_agentId: string, message: string): Promise<boolean> {
    return this.handleApproval(message);
  }

  private killWorker(reason: string): void {
    if (this.worker) {
      console.log(`AgentRunner [${this.agentId}]: killing worker (${reason})`);
      this.worker.kill();
      this.worker = null;
      this.port = null;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Returns the fenced code block, or null if the response is prose-only (a chat
// answer or the done-signal). The unified blueberry assistant writes code only
// when it needs to act; prose-only = the task is done.
function extractCode(text: string): string | null {
  const match = text.match(/```(?:ts|typescript|js|javascript)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

// Strip the fenced code block out of the response, leaving the prose (reasoning
// or, for a chat-only answer, the whole message).
function extractProse(text: string): string {
  return text.replace(/```(?:ts|typescript|js|javascript)?\n[\s\S]*?```/g, "").trim();
}

interface WorkerMessage {
  type: string;
  id?: number;
  method?: string;
  args?: unknown[];
  runId?: string;
  error?: string;
  stack?: string;
  level?: string;
  text?: string;
  value?: unknown;
}
