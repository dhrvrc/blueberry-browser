import { contextBridge } from "electron";
import { electronAPI } from "@electron-toolkit/preload";
import { typedInvoke } from "./typed-invoke";
import type { CoreMessage } from "ai";
import type { AgentEvent, AutomationSummary } from "../shared/ipc-schema";

interface ChatRequest {
  message: string;
  messageId: string;
}

interface ChatResponse {
  messageId: string;
  content: string;
  isComplete: boolean;
}

// Sidebar specific APIs
const sidebarAPI = {
  // Chat functionality
  sendChatMessage: (request: ChatRequest) =>
    typedInvoke("sidebar-chat-message", request),

  clearChat: () => typedInvoke("sidebar-clear-chat"),

  getMessages: () => typedInvoke("sidebar-get-messages"),

  onChatResponse: (callback: (data: ChatResponse) => void) => {
    electronAPI.ipcRenderer.on("chat-response", (_, data) => callback(data));
  },

  onMessagesUpdated: (callback: (messages: CoreMessage[]) => void) => {
    electronAPI.ipcRenderer.on("chat-messages-updated", (_, messages) =>
      callback(messages),
    );
  },

  removeChatResponseListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("chat-response");
  },

  removeMessagesUpdatedListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("chat-messages-updated");
  },

  // Page content access
  getPageContent: () => typedInvoke("get-page-content"),
  getPageText: () => typedInvoke("get-page-text"),
  getCurrentUrl: () => typedInvoke("get-current-url"),

  // Agent — lifecycle channels (request/response)
  runAgent: (task: string) => typedInvoke("agent-run", task),
  abortAgent: (agentId: string) => typedInvoke("agent-abort", agentId),
  approveAction: (agentId: string, requestId: string, approved: boolean) =>
    typedInvoke("agent-approval-response", agentId, requestId, approved),
  saveAutomation: (agentId: string, name: string) =>
    typedInvoke("agent-save", agentId, name),
  replayAutomation: (automationId: string) =>
    typedInvoke("agent-replay", automationId),
  listAutomations: (): Promise<AutomationSummary[]> =>
    typedInvoke("agent-list-automations"),
  openFile: (url: string) => typedInvoke("agent-open-file", url),

  // Agent — raw push channel (not in IpcSchema)
  onAgentEvent: (callback: (event: AgentEvent) => void) => {
    electronAPI.ipcRenderer.on("agent-event", (_, e) => callback(e));
  },
  removeAgentEventListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("agent-event");
  },
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("sidebarAPI", sidebarAPI);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.sidebarAPI = sidebarAPI;
}
