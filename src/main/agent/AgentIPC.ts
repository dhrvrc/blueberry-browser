import { typedHandle } from "../typed-handle";
import type { AgentService } from "./AgentService";

/**
 * Register the six agent lifecycle IPC channels.
 * Called from EventManager.handleAgentEvents() after SideBar is constructed.
 */
export function registerAgentIpc(agentService: AgentService): void {
  typedHandle("agent-run", (_, task) => agentService.run(task));

  typedHandle("agent-abort", (_, agentId) => {
    agentService.abort(agentId);
  });

  typedHandle("agent-approval-response", (_, agentId, requestId, approved) => {
    agentService.resolveApproval(agentId, requestId, approved);
  });

  typedHandle("agent-save", (_, agentId, name) => agentService.save(agentId, name));

  typedHandle("agent-replay", (_, automationId) => agentService.replay(automationId));

  typedHandle("agent-list-automations", () => agentService.listAutomations());

  typedHandle("agent-open-file", (_, url) => {
    agentService.openFile(url);
  });
}
