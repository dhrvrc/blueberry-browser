import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { CoreMessage } from "ai";

const AGENTS_DIR = join(homedir(), ".blueberry", "agents");

async function ensureDir(): Promise<void> {
  await mkdir(AGENTS_DIR, { recursive: true });
}

/** Minimal interface consumed by AgentRunner — implemented by AgentStore and EphemeralStore. */
export interface IAgentStore {
  load(agentId: string): Promise<CoreMessage[]>;
  append(agentId: string, message: CoreMessage): void;
}

/**
 * Persists and reloads agent conversation history (CoreMessage[]) across
 * sessions. One JSON file per agentId in ~/.blueberry/agents/.
 */
export class AgentStore implements IAgentStore {
  private cache = new Map<string, CoreMessage[]>();

  async load(agentId: string): Promise<CoreMessage[]> {
    if (this.cache.has(agentId)) return this.cache.get(agentId)!;
    await ensureDir();
    try {
      const raw = await readFile(join(AGENTS_DIR, `${agentId}.json`), "utf8");
      const messages = JSON.parse(raw) as CoreMessage[];
      this.cache.set(agentId, messages);
      return messages;
    } catch {
      this.cache.set(agentId, []);
      return [];
    }
  }

  append(agentId: string, message: CoreMessage): void {
    const history = this.cache.get(agentId) ?? [];
    history.push(message);
    this.cache.set(agentId, history);
    // Write-through (fire and forget — errors logged only)
    this.flush(agentId, history).catch((e) =>
      console.error("AgentStore: flush failed", e),
    );
  }

  private async flush(agentId: string, messages: CoreMessage[]): Promise<void> {
    await ensureDir();
    await writeFile(
      join(AGENTS_DIR, `${agentId}.json`),
      JSON.stringify(messages, null, 2),
      "utf8",
    );
  }
}
