import * as ts from "typescript";

/**
 * Strip TypeScript types from an agent program, yielding runnable JS.
 *
 * Uses the TypeScript compiler's in-process `transpileModule` (no child
 * process). esbuild's service-based API deadlocks inside the long-running
 * Electron main process, so we avoid it here. The agent program only ever
 * uses type annotations (no decorators/enums needing real codegen), and
 * top-level `await` is preserved by the ES2022 target.
 */
export function stripTypes(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
}
