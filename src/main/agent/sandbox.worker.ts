// Electron utilityProcess entry — the CodeAct sandbox.
// Runs LLM-generated TypeScript (transpiled to JS by main) against the
// all-async `blueberry` proxy. No Electron/Node primitives in scope —
// the only capability is what main mediates over the MessagePort.

// MessagePort to main (received via the first parentPort message)
let port: Electron.MessagePortMain | null = null;

// Pending call map: id → {resolve, reject}
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let callId = 0;

// Post a call to main and return a Promise of the result.
function callMain(method: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++callId;
    pending.set(id, { resolve, reject });
    port!.postMessage({ type: "call", id, method, args });
  });
}

// Recursive proxy: blueberry.tab.click("a") → callMain("tab.click", ["a"])
function makeProxy(path: string[]): unknown {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  return new Proxy(function () {}, {
    get(_, p: string | symbol) {
      if (typeof p !== "string") return undefined;
      return makeProxy([...path, p]);
    },
    apply(_t, _thisArg, args: unknown[]) {
      return callMain(path.join("."), args);
    },
  });
}

const blueberry = makeProxy([]);

const MISSED_AWAIT_MSG =
  "⚠ A value was an unresolved Promise — you likely missed an `await` on a blueberry.* call.";

// A logged "[object Promise]" almost always means a missed await — surface it
// on the observations channel so the glass-box UI flags fix #4's silent bug.
function logToMain(level: string, args: unknown[]): void {
  const text = args.map(String).join(" ");
  if (text.includes("[object Promise]")) {
    port!.postMessage({ type: "missed-await", text: MISSED_AWAIT_MSG });
  }
  port!.postMessage({ type: "console", level, text });
}

// Console captured to main as observations so the user sees stdout in the UI.
const sandboxConsole = {
  log: (...a: unknown[]) => logToMain("log", a),
  info: (...a: unknown[]) => logToMain("info", a),
  warn: (...a: unknown[]) => logToMain("warn", a),
  error: (...a: unknown[]) => logToMain("error", a),
};

// Handle a port message: either a call result/error, or exec/port setup.
function handlePortMessage(msg: { type: string; id?: number; value?: unknown; message?: string; stack?: string }): void {
  if (msg.type === "result" && msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p.resolve(msg.value); }
  } else if (msg.type === "error" && msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      const err = new Error(msg.message ?? "Unknown error");
      if (msg.stack) err.stack = msg.stack;
      p.reject(err);
    }
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

// Execute transpiled JS code in an async context and report back.
async function execCode(runId: string, code: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("blueberry", "console", `return (async () => { ${code} })()`);
    const result = await fn(blueberry, sandboxConsole);

    // Warn if the returned value is still a Promise (missed top-level await).
    if (result instanceof Promise) {
      port!.postMessage({ type: "missed-await", text: MISSED_AWAIT_MSG });
    } else if (result !== undefined) {
      // Surface the program's final value to the user (the "return" channel),
      // so a task whose answer is the returned value isn't silently dropped.
      const text = typeof result === "string" ? result : safeStringify(result);
      port!.postMessage({ type: "return", runId, text });
    }

    port!.postMessage({ type: "exec-done", runId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    port!.postMessage({ type: "exec-error", runId, error: message, stack });
  }
}

// Boot: register parentPort listener synchronously at module load.
process.parentPort.on("message", (e) => {
  // First message carries the transferred MessagePort.
  if (!port && e.ports && e.ports.length > 0) {
    port = e.ports[0];
    port.on("message", (portEvent: { data: { type: string; id?: number; value?: unknown; message?: string; stack?: string; runId?: string; code?: string } }) => {
      const msg = portEvent.data;
      if (msg.type === "exec" && msg.runId !== undefined && msg.code !== undefined) {
        execCode(msg.runId, msg.code);
      } else {
        handlePortMessage(msg);
      }
    });
    port.start();
    return;
  }

  // Subsequent parentPort messages (e.g. exec before port transfer completes) — ignored.
});
