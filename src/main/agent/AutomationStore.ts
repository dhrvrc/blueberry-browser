import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import type { AutomationSummary } from "../../shared/ipc-schema";

export interface Automation {
  id: string;
  name: string;
  task: string;
  script: string;
  createdAt: string;
}

const AUTOMATIONS_DIR = join(homedir(), ".blueberry", "automations");

async function ensureDir(): Promise<void> {
  await mkdir(AUTOMATIONS_DIR, { recursive: true });
}

export class AutomationStore {
  async save(name: string, task: string, script: string): Promise<Automation> {
    await ensureDir();
    const automation: Automation = {
      id: randomUUID(),
      name,
      task,
      script,
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      join(AUTOMATIONS_DIR, `${automation.id}.json`),
      JSON.stringify(automation, null, 2),
      "utf8",
    );
    return automation;
  }

  async list(): Promise<AutomationSummary[]> {
    await ensureDir();
    let files: string[];
    try {
      files = await readdir(AUTOMATIONS_DIR);
    } catch {
      return [];
    }
    const results: AutomationSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(AUTOMATIONS_DIR, file), "utf8");
        const a = JSON.parse(raw) as Automation;
        results.push({ id: a.id, name: a.name, task: a.task, createdAt: a.createdAt });
      } catch {
        // Skip corrupt files
      }
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<Automation | null> {
    try {
      const raw = await readFile(join(AUTOMATIONS_DIR, `${id}.json`), "utf8");
      return JSON.parse(raw) as Automation;
    } catch {
      return null;
    }
  }
}
