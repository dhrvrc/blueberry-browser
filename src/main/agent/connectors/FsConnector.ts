/**
 * Sandboxed filesystem connector for the MCP registry.
 * Exposes read/write/list/delete operations confined to ~/.blueberry/workspace/.
 *
 * Symlink escape: symlinks inside the workspace that point outside it are NOT
 * blocked — resolving through symlinks is accepted out-of-scope because no
 * symlink-creation tool is exposed and the workspace is user-owned storage.
 */

import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  rm,
} from "fs/promises";
import path from "path";
import { homedir } from "os";
import type { Connector } from "../McpClient";

const WORKSPACE = path.join(homedir(), ".blueberry", "workspace");

const MAX_WRITE_BYTES = 5_000_000;
const MAX_LIST_ENTRIES = 1000;

export class FsConnector implements Connector {
  /** Ensure the workspace directory exists before each tool call. */
  private async ensureWorkspace(): Promise<void> {
    await mkdir(WORKSPACE, { recursive: true });
  }

  /**
   * Resolve a relative path inside the workspace.
   * Rejects empty/non-string input, absolute paths, and paths that escape the workspace.
   */
  private resolve(requestedPath: unknown): string {
    if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
      throw new Error("fs connector: path must be a non-empty string");
    }
    if (path.isAbsolute(requestedPath)) {
      throw new Error("fs connector: path must be relative to the workspace");
    }
    const abs = path.resolve(WORKSPACE, requestedPath);
    if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) {
      throw new Error(`fs connector: path escapes workspace: ${requestedPath}`);
    }
    return abs;
  }

  async call(tool: string, args: unknown): Promise<unknown> {
    const a = (args ?? {}) as Record<string, unknown>;

    switch (tool) {
      case "read": {
        await this.ensureWorkspace();
        const abs = this.resolve(a.path);
        try {
          return await readFile(abs, "utf8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`fs read failed: ${msg}`);
        }
      }

      case "write": {
        await this.ensureWorkspace();
        const rel = a.path;
        const content = a.content;
        if (typeof content !== "string") {
          throw new Error("fs connector: write requires content to be a string");
        }
        if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
          throw new Error(
            `fs connector: content exceeds ${MAX_WRITE_BYTES} bytes`,
          );
        }
        const abs = this.resolve(rel);
        await mkdir(path.dirname(abs), { recursive: true });
        try {
          await writeFile(abs, content, "utf8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`fs write failed: ${msg}`);
        }
        // Return the relative path the agent passed — don't leak the homedir.
        return { ok: true, path: rel };
      }

      case "list": {
        await this.ensureWorkspace();
        const reqPath = a.path ?? ".";
        const abs = this.resolve(reqPath);
        let entries;
        try {
          entries = await readdir(abs, { withFileTypes: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`fs list failed: ${msg}`);
        }
        const capped = entries.slice(0, MAX_LIST_ENTRIES);
        return await Promise.all(
          capped.map(async (entry) => {
            let size = 0;
            if (entry.isFile()) {
              try {
                const s = await stat(path.join(abs, entry.name));
                size = s.size;
              } catch {
                size = 0;
              }
            }
            return { name: entry.name, isDir: entry.isDirectory(), size };
          }),
        );
      }

      case "delete": {
        await this.ensureWorkspace();
        const abs = this.resolve(a.path);
        if (abs === WORKSPACE) {
          throw new Error("fs connector: cannot delete the workspace root");
        }
        try {
          await rm(abs, { recursive: true, force: false });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`fs delete failed: ${msg}`);
        }
        return { ok: true };
      }

      default:
        throw new Error(`fs connector: unknown tool "${tool}"`);
    }
  }
}
