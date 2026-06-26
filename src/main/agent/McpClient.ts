/**
 * MCP connector registry. Each Connector is an in-process implementation of a
 * "server" (named by string). Registering a real MCP-stdio or OAuth connector
 * is a matter of calling register() — no infrastructure changes needed.
 *
 * MVP ships one connector: "fetch" — blueberry.mcp.fetch.get({url}) → { status, text }
 */
export interface Connector {
  call(tool: string, args: unknown): Promise<unknown>;
}

export class McpClient {
  private connectors = new Map<string, Connector>();

  constructor() {
    // Register the built-in fetch connector (no OAuth, no external deps).
    this.register("fetch", new FetchConnector());
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
