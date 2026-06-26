import type { CoreMessage } from "ai";

// Frontend-visible tab descriptor returned by get-tabs.
export interface TabInfo {
  id: string;
  title: string;
  url: string;
  isActive: boolean;
  /** True for tabs owned by a spawned agent (labeled in the strip, not auto-focused). */
  isAgent?: boolean;
}

// Chat request sent from the sidebar renderer to main.
export interface ChatRequest {
  message: string;
  messageId: string;
}

// ─── Agent types ─────────────────────────────────────────────────────────────

export interface AutomationSummary {
  id: string;
  name: string;
  task: string;
  createdAt: string;
}

export type StepStatus = "pending" | "running" | "done" | "error";

/**
 * AgentEvent — discriminated union sent over the raw "agent-event" push channel
 * (webContents.send, NOT in IpcSchema). Every variant carries agentId so the
 * sidebar can route events when multi-agent lands later.
 */
export type AgentEvent =
  | { kind: "reasoning"; agentId: string; text: string }
  | { kind: "code"; agentId: string; delta: string }
  | { kind: "code-complete"; agentId: string; code: string }
  | { kind: "step"; agentId: string; stepId: string; label: string; status: StepStatus; detail?: string }
  | { kind: "observation"; agentId: string; stream: "stdout" | "return" | "error" | "warn"; text: string }
  | { kind: "overlay"; agentId: string; selector: string; action: "click" | "type"; phase: "show" | "hide" }
  | { kind: "approval-request"; agentId: string; requestId: string; message: string }
  | { kind: "approval-resolved"; agentId: string; requestId: string; approved: boolean }
  | { kind: "status"; agentId: string; text: string }
  | { kind: "run-start"; agentId: string; task: string }
  // The model answered conversationally (no code) — this is the final chat reply,
  // rendered as a plain assistant message instead of the glass-box run.
  | { kind: "answer"; agentId: string; text: string }
  // The agent generated a file (csv/md/html/text). The sidebar shows it as a
  // clickable card; clicking opens `url` (a file:// viewer) in a new tab.
  | { kind: "file"; agentId: string; name: string; fileType: "csv" | "md" | "html" | "text"; url: string }
  // Emitted before a CodeAct retry so the UI clears the failed attempt's
  // streamed reasoning/code (it would otherwise stack on top of the new one).
  | { kind: "attempt-start"; agentId: string }
  | { kind: "run-end"; agentId: string; ok: boolean; error?: string }
  | { kind: "agent-spawned"; agentId: string; parentId: string; task: string }
  | { kind: "agent-done"; agentId: string; ok: boolean; result?: string; error?: string };

// One entry per ipcMain.handle / ipcRenderer.invoke channel.
// params = the arguments after the IpcMainInvokeEvent; result = the resolved value.
export interface IpcSchema {
  "create-tab": { params: [url?: string]; result: { id: string; title: string; url: string } };
  "close-tab": { params: [tabId: string]; result: void };
  "switch-tab": { params: [tabId: string]; result: void };
  "get-tabs": { params: []; result: TabInfo[] };
  "navigate-tab": { params: [tabId: string, url: string]; result: boolean };
  "tab-go-back": { params: [tabId: string]; result: boolean };
  "tab-go-forward": { params: [tabId: string]; result: boolean };
  "tab-reload": { params: [tabId: string]; result: boolean };
  "tab-screenshot": { params: [tabId: string]; result: string | null };
  "tab-run-js": { params: [tabId: string, code: string]; result: unknown };
  "toggle-sidebar": { params: []; result: boolean };
  "sidebar-chat-message": { params: [request: ChatRequest]; result: void };
  "sidebar-clear-chat": { params: []; result: boolean };
  "sidebar-get-messages": { params: []; result: CoreMessage[] };
  "get-page-content": { params: []; result: string | null };
  "get-page-text": { params: []; result: string | null };
  "get-current-url": { params: []; result: string | null };
  // Agent lifecycle channels (request/response over typedHandle)
  "agent-run": { params: [task: string]; result: { agentId: string } };
  "agent-abort": { params: [agentId: string]; result: void };
  "agent-approval-response": { params: [agentId: string, requestId: string, approved: boolean]; result: void };
  "agent-save": { params: [agentId: string, name: string]; result: { id: string } | null };
  "agent-replay": { params: [automationId: string]; result: { agentId: string } | null };
  "agent-list-automations": { params: []; result: AutomationSummary[] };
  // Open an agent-generated file viewer (file:// URL) in a new focused tab.
  "agent-open-file": { params: [url: string]; result: void };
}
