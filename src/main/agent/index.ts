// Agent module home. The glass-box CodeAct agent lives in this directory:
// AgentService (entry point, owned by SideBar), AgentRunner (eval loop +
// sandbox worker lifecycle), BlueberrySDK (the real SDK in main),
// sandbox.worker (the utilityProcess), plus the stores and McpClient.
// Settled design + scope: agent_docs/feature_spec.md.
export { AgentService } from "./AgentService";
