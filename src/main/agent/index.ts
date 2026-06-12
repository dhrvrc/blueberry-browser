// Agent module seam — scaffold only, intentionally empty.
//
// This directory is the first-class home for the upcoming glass-box CodeAct
// browser agent (see agent_docs/feature_spec.md). Feature work lands here:
//
//   TODO(agent): AgentRunner  — sandboxed eval loop that runs LLM-authored
//                               TypeScript against the `blueberry` SDK, with
//                               live code streaming + intra-agent concurrency.
//   TODO(agent): BlueberrySDK — the `blueberry` SDK surface the agent programs
//                               against, built on TabService (src/main/TabService.ts)
//                               so it shares the exact tab code path as IPC handlers.
//   TODO(agent): register agent IPC channels by adding entries to
//                src/shared/ipc-schema.ts and handlers via typedHandle.
//
// No runtime code yet — this export keeps the module importable and typechecked.
export {};
