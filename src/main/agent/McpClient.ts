/**
 * MCP connector registry. Each Connector is an in-process implementation of a
 * "server" (named by string). Registering a real MCP-stdio or OAuth connector
 * is a matter of calling register() — no infrastructure changes needed.
 *
 * Ships three built-in connectors:
 *   "fetch" — blueberry.mcp.fetch.get({url}) → { status, text }
 *   "fs"    — blueberry.mcp.fs.{read,write,list,delete} — sandboxed to ~/.blueberry/workspace/
 *   "data"  — blueberry.mcp.data.* — stateless DataFrame-lite (parseCsv/parseJson/summarize/…)
 */
import { FsConnector } from "./connectors/FsConnector";
import { DataConnector } from "./connectors/DataConnector";

export interface Connector {
  call(tool: string, args: unknown): Promise<unknown>;
}

export class McpClient {
  private connectors = new Map<string, Connector>();

  constructor() {
    // Register the built-in connectors (no OAuth, no external deps).
    this.register("fetch", new FetchConnector());
    this.register("fs", new FsConnector());
    this.register("data", new DataConnector());
  }

  register(name: string, connector: Connector): void {
    this.connectors.set(name, connector);
  }

  async call(server: string, tool: string, args: unknown): Promise<unknown> {
    const connector = this.connectors.get(server);
    if (!connector) throw new Error(`MCP server not registered: ${server}`);
    return connector.call(tool, args);
  }
}

/** Fetch connector: one tool — get(url) → { status, text } */
class FetchConnector implements Connector {
  async call(tool: string, args: unknown): Promise<unknown> {
    if (tool !== "get") throw new Error(`fetch connector: unknown tool "${tool}"`);
    const { url } = args as { url: string };
    const res = await fetch(url);
    const text = await res.text();
    return { status: res.status, text };
  }
}
