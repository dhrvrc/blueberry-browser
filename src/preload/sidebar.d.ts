import { ElectronAPI } from "@electron-toolkit/preload";
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

interface SidebarAPI {
  // Chat functionality
  sendChatMessage: (request: ChatRequest) => Promise<void>;
  clearChat: () => Promise<void>;
  getMessages: () => Promise<CoreMessage[]>;
  onChatResponse: (callback: (data: ChatResponse) => void) => void;
  onMessagesUpdated: (callback: (messages: CoreMessage[]) => void) => void;
  removeChatResponseListener: () => void;
  removeMessagesUpdatedListener: () => void;

  // Page content access
  getPageContent: () => Promise<string | null>;
  getPageText: () => Promise<string | null>;
  getCurrentUrl: () => Promise<string | null>;

  // Agent — lifecycle
  runAgent: (task: string) => Promise<{ agentId: string }>;
  abortAgent: (agentId: string) => Promise<void>;
  approveAction: (agentId: string, requestId: string, approved: boolean) => Promise<void>;
  saveAutomation: (agentId: string, name: string) => Promise<{ id: string } | null>;
  replayAutomation: (automationId: string) => Promise<{ agentId: string } | null>;
  listAutomations: () => Promise<AutomationSummary[]>;
  openFile: (url: string) => Promise<void>;

  // Agent — event stream (raw push)
  onAgentEvent: (callback: (event: AgentEvent) => void) => void;
  removeAgentEventListener: () => void;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    sidebarAPI: SidebarAPI;
  }
}
