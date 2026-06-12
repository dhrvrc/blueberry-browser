import type { CoreMessage } from "ai";

// Frontend-visible tab descriptor returned by get-tabs.
export interface TabInfo {
  id: string;
  title: string;
  url: string;
  isActive: boolean;
}

// Chat request sent from the sidebar renderer to main.
export interface ChatRequest {
  message: string;
  messageId: string;
}

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
  // agent channels added here when feature work begins
}
