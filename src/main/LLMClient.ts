import { WebContents } from "electron";
import { streamText, type LanguageModel, type CoreMessage, type ImagePart, type TextPart } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import * as dotenv from "dotenv";
import { join } from "path";
import type { Tab } from "./Tab";
import { SDK_TYPE_DEFS } from "./agent/sdk-types";

// Load environment variables from .env file
dotenv.config({ path: join(__dirname, "../../.env") });

interface ChatRequest {
  message: string;
  messageId: string;
}

interface StreamChunk {
  content: string;
  isComplete: boolean;
}

type LLMProvider = "openai" | "anthropic";

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-20241022",
};

// Model for the ROOT agent's code generation (multi-step planning).
// gpt-5.1 is the proven-good model for this task; gpt-5.4/5.5 regressed page
// extraction in testing, so we stay on 5.1 until a newer model is validated.
const AGENT_MODELS: Record<LLMProvider, string> = {
  openai: "gpt-5.1",
  anthropic: "claude-3-5-sonnet-20241022",
};

// Model for SPAWNED sub-agents. Same proven model as root for now (their tasks
// are small but page extraction needs the same reliability). The concurrency
// gate — not a weaker model — is what protects the rate limit.
const SUBAGENT_MODELS: Record<LLMProvider, string> = {
  openai: "gpt-5.1",
  anthropic: "claude-3-5-sonnet-20241022",
};

const MAX_CONTEXT_LENGTH = 4000;
const DEFAULT_TEMPERATURE = 0.7;
// The root agent model (gpt-5.1) is a reasoning model and rejects the
// `temperature` setting, so the agent path omits it (see streamCodeAct).
// Limit concurrent agent LLM calls so parallel spawns don't blow the provider's
// tokens-per-minute rate limit — calls queue and run a few at a time.
const MAX_CONCURRENT_AGENT_CALLS = 2;

export class LLMClient {
  private readonly webContents: WebContents;
  private readonly getActiveTab: () => Tab | null;
  private readonly provider: LLMProvider;
  private readonly modelName: string;
  private readonly model: LanguageModel | null;
  private readonly agentModel: LanguageModel | null;
  private readonly subAgentModel: LanguageModel | null;
  private messages: CoreMessage[] = [];
  // Simple FIFO gate limiting concurrent agent LLM calls (rate-limit control).
  private agentCallSlots = MAX_CONCURRENT_AGENT_CALLS;
  private agentCallQueue: Array<() => void> = [];

  constructor(webContents: WebContents, getActiveTab: () => Tab | null) {
    this.webContents = webContents;
    this.getActiveTab = getActiveTab;
    this.provider = this.getProvider();
    this.modelName = this.getModelName();
    this.model = this.initializeModel();
    this.agentModel = this.initializeAgentModel(AGENT_MODELS[this.provider]);
    this.subAgentModel = this.initializeAgentModel(SUBAGENT_MODELS[this.provider]);

    this.logInitializationStatus();
  }

  private getProvider(): LLMProvider {
    const provider = process.env.LLM_PROVIDER?.toLowerCase();
    if (provider === "anthropic") return "anthropic";
    return "openai"; // Default to OpenAI
  }

  private getModelName(): string {
    return process.env.LLM_MODEL || DEFAULT_MODELS[this.provider];
  }

  private initializeModel(): LanguageModel | null {
    const apiKey = this.getApiKey();
    if (!apiKey) return null;

    switch (this.provider) {
      case "anthropic":
        return anthropic(this.modelName);
      case "openai":
        return openai(this.modelName);
      default:
        return null;
    }
  }

  private initializeAgentModel(modelName: string): LanguageModel | null {
    const apiKey = this.getApiKey();
    if (!apiKey) return null;
    switch (this.provider) {
      case "anthropic":
        return anthropic(modelName);
      case "openai":
        return openai(modelName);
      default:
        return null;
    }
  }

  // Acquire a slot from the concurrency gate; resolves when one is free.
  private acquireAgentSlot(): Promise<void> {
    if (this.agentCallSlots > 0) {
      this.agentCallSlots--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.agentCallQueue.push(resolve));
  }

  private releaseAgentSlot(): void {
    const next = this.agentCallQueue.shift();
    if (next) next();
    else this.agentCallSlots++;
  }

  private getApiKey(): string | undefined {
    switch (this.provider) {
      case "anthropic":
        return process.env.ANTHROPIC_API_KEY;
      case "openai":
        return process.env.OPENAI_API_KEY;
      default:
        return undefined;
    }
  }

  private logInitializationStatus(): void {
    if (this.model) {
      console.log(
        `✅ LLM Client initialized with ${this.provider} provider using model: ${this.modelName}`
      );
    } else {
      const keyName =
        this.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      console.error(
        `❌ LLM Client initialization failed: ${keyName} not found in environment variables.\n` +
          `Please add your API key to the .env file in the project root.`
      );
    }
  }

  async sendChatMessage(request: ChatRequest): Promise<void> {
    try {
      // Get screenshot from active tab if available
      let screenshot: string | null = null;
      const activeTab = this.getActiveTab();
      if (activeTab) {
        try {
          const image = await activeTab.screenshot();
          screenshot = image.toDataURL();
        } catch (error) {
          console.error("Failed to capture screenshot:", error);
        }
      }

      // Build user message content with screenshot first, then text
      const userContent: Array<ImagePart | TextPart> = [];
      
      // Add screenshot as the first part if available
      if (screenshot) {
        userContent.push({
          type: "image",
          image: screenshot,
        });
      }
      
      // Add text content
      userContent.push({
        type: "text",
        text: request.message,
      });

      // Create user message in CoreMessage format
      const userMessage: CoreMessage = {
        role: "user",
        content: userContent.length === 1 ? request.message : userContent,
      };
      
      this.messages.push(userMessage);

      // Send updated messages to renderer
      this.sendMessagesToRenderer();

      if (!this.model) {
        this.sendErrorMessage(
          request.messageId,
          "LLM service is not configured. Please add your API key to the .env file."
        );
        return;
      }

      const messages = await this.prepareMessagesWithContext(request);
      await this.streamResponse(messages, request.messageId);
    } catch (error) {
      console.error("Error in LLM request:", error);
      this.handleStreamError(error, request.messageId);
    }
  }

  clearMessages(): void {
    this.messages = [];
    this.sendMessagesToRenderer();
  }

  getMessages(): CoreMessage[] {
    return this.messages;
  }

  private sendMessagesToRenderer(): void {
    this.webContents.send("chat-messages-updated", this.messages);
  }

  private async prepareMessagesWithContext(_request: ChatRequest): Promise<CoreMessage[]> {
    // Get page context from active tab
    let pageUrl: string | null = null;
    let pageText: string | null = null;

    const activeTab = this.getActiveTab();
    if (activeTab) {
      pageUrl = activeTab.url;
      try {
        pageText = await activeTab.getTabText();
      } catch (error) {
        console.error("Failed to get page text:", error);
      }
    }

    // Build system message
    const systemMessage: CoreMessage = {
      role: "system",
      content: this.buildSystemPrompt(pageUrl, pageText),
    };

    // Include all messages in history (system + conversation)
    return [systemMessage, ...this.messages];
  }

  private buildSystemPrompt(url: string | null, pageText: string | null): string {
    const parts: string[] = [
      "You are a helpful AI assistant integrated into a web browser.",
      "You can analyze and discuss web pages with the user.",
      "The user's messages may include screenshots of the current page as the first image.",
    ];

    if (url) {
      parts.push(`\nCurrent page URL: ${url}`);
    }

    if (pageText) {
      const truncatedText = this.truncateText(pageText, MAX_CONTEXT_LENGTH);
      parts.push(`\nPage content (text):\n${truncatedText}`);
    }

    parts.push(
      "\nPlease provide helpful, accurate, and contextual responses about the current webpage.",
      "If the user asks about specific content, refer to the page content and/or screenshot provided."
    );

    return parts.join("\n");
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
  }

  private async streamResponse(
    messages: CoreMessage[],
    messageId: string
  ): Promise<void> {
    if (!this.model) {
      throw new Error("Model not initialized");
    }

    try {
      const result = await streamText({
        model: this.model,
        messages,
        temperature: DEFAULT_TEMPERATURE,
        maxRetries: 3,
        abortSignal: undefined, // Could add abort controller for cancellation
      });

      await this.processStream(result.textStream, messageId);
    } catch (error) {
      throw error; // Re-throw to be handled by the caller
    }
  }

  private async processStream(
    textStream: AsyncIterable<string>,
    messageId: string
  ): Promise<void> {
    let accumulatedText = "";

    // Create a placeholder assistant message
    const assistantMessage: CoreMessage = {
      role: "assistant",
      content: "",
    };
    
    // Keep track of the index for updates
    const messageIndex = this.messages.length;
    this.messages.push(assistantMessage);

    for await (const chunk of textStream) {
      accumulatedText += chunk;

      // Update assistant message content
      this.messages[messageIndex] = {
        role: "assistant",
        content: accumulatedText,
      };
      this.sendMessagesToRenderer();

      this.sendStreamChunk(messageId, {
        content: chunk,
        isComplete: false,
      });
    }

    // Final update with complete content
    this.messages[messageIndex] = {
      role: "assistant",
      content: accumulatedText,
    };
    this.sendMessagesToRenderer();

    // Send the final complete signal
    this.sendStreamChunk(messageId, {
      content: accumulatedText,
      isComplete: true,
    });
  }

  private handleStreamError(error: unknown, messageId: string): void {
    console.error("Error streaming from LLM:", error);

    const errorMessage = this.getErrorMessage(error);
    this.sendErrorMessage(messageId, errorMessage);
  }

  private getErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
      return "An unexpected error occurred. Please try again.";
    }

    const message = error.message.toLowerCase();

    if (message.includes("401") || message.includes("unauthorized")) {
      return "Authentication error: Please check your API key in the .env file.";
    }

    if (message.includes("429") || message.includes("rate limit")) {
      return "Rate limit exceeded. Please try again in a few moments.";
    }

    if (
      message.includes("network") ||
      message.includes("fetch") ||
      message.includes("econnrefused")
    ) {
      return "Network error: Please check your internet connection.";
    }

    if (message.includes("timeout")) {
      return "Request timeout: The service took too long to respond. Please try again.";
    }

    return "Sorry, I encountered an error while processing your request. Please try again.";
  }

  private sendErrorMessage(messageId: string, errorMessage: string): void {
    this.sendStreamChunk(messageId, {
      content: errorMessage,
      isComplete: true,
    });
  }

  private sendStreamChunk(messageId: string, chunk: StreamChunk): void {
    this.webContents.send("chat-response", {
      messageId,
      content: chunk.content,
      isComplete: chunk.isComplete,
    });
  }

  /**
   * Stream a code-generation turn for the agent. Does NOT mutate this.messages
   * (the agent owns its own history via AgentStore). Returns the full assistant
   * text so AgentRunner can extract the TypeScript block.
   *
   * Reasoning text (before the opening ```) routes to onReasoning;
   * inside-fence deltas route to onCode.
   */
  async streamCodeAct(
    task: string,
    context: { url: string | null; pageText: string | null; screenshot: string | null },
    history: CoreMessage[],
    onReasoning: (delta: string) => void,
    onCode: (delta: string) => void,
    abortSignal?: AbortSignal,
    tier: "root" | "sub" = "root",
  ): Promise<string> {
    // Sub-agents use the cheaper/faster model; root uses the strong one.
    const model = tier === "sub" ? this.subAgentModel : this.agentModel;
    if (!model) {
      throw new Error("Agent model not initialized — check your API key");
    }

    const systemPrompt = this.buildAgentSystemPrompt(context);
    const messages: CoreMessage[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: task },
    ];

    // Gate concurrent agent calls so parallel spawns don't exceed the
    // provider's tokens-per-minute rate limit.
    await this.acquireAgentSlot();
    let result;
    try {
      result = await streamText({
        model,
        messages,
        maxRetries: 2,
        abortSignal,
      });
    } catch (err) {
      this.releaseAgentSlot();
      throw translateLlmError(err);
    }

    let fullText = "";
    // State: are we currently inside a fenced code block?
    let inFence = false;
    // Buffer to detect the fence marker across chunk boundaries.
    let trailingBuf = "";

    try {
    for await (const chunk of result.textStream) {
      fullText += chunk;

      if (!inFence) {
        // Look for opening fence in the combined trailing context + chunk.
        const search = trailingBuf + chunk;
        const fenceIdx = search.indexOf("```");
        if (fenceIdx !== -1) {
          // Everything before the fence is reasoning.
          const beforeFence = search.slice(0, fenceIdx);
          if (beforeFence) onReasoning(beforeFence);
          // Skip the fence line (up to newline) — e.g. "```ts\n"
          const afterFence = search.slice(fenceIdx + 3);
          const nlIdx = afterFence.indexOf("\n");
          const codeStart = nlIdx !== -1 ? afterFence.slice(nlIdx + 1) : "";
          inFence = true;
          trailingBuf = "";
          if (codeStart) onCode(codeStart);
        } else {
          // No fence yet — emit as reasoning, but keep last few chars buffered
          // in case the fence straddles the next chunk.
          const keep = Math.min(3, search.length);
          const emit = search.slice(0, search.length - keep);
          if (emit) onReasoning(emit);
          trailingBuf = search.slice(search.length - keep);
        }
      } else {
        // Inside fence — check for closing ```.
        const search = trailingBuf + chunk;
        const closeIdx = search.indexOf("```");
        if (closeIdx !== -1) {
          const codeChunk = search.slice(0, closeIdx);
          if (codeChunk) onCode(codeChunk);
          inFence = false;
          trailingBuf = "";
        } else {
          const keep = Math.min(3, search.length);
          const emit = search.slice(0, search.length - keep);
          if (emit) onCode(emit);
          trailingBuf = search.slice(search.length - keep);
        }
      }
    }

    // Flush any remaining buffer.
    if (trailingBuf) {
      if (inFence) onCode(trailingBuf);
      else onReasoning(trailingBuf);
    }

    return fullText;
    } catch (err) {
      // Rate-limit / too-large errors surface here (mid-stream) — translate to
      // a clear message instead of the raw provider error.
      throw translateLlmError(err);
    } finally {
      this.releaseAgentSlot();
    }
  }

  private buildAgentSystemPrompt(context: { url: string | null; pageText: string | null; screenshot: string | null }): string {
    const parts: string[] = [
      "You are Blueberry, the assistant inside Blueberry Browser. You decide how to respond:",
      "",
      "- CHAT: if the user is just talking, asking a question you can answer from the conversation or the page context already given to you, or wants an explanation — reply directly in plain prose with NO code block. Be concise and helpful.",
      "- ACT: if the task needs browser actions or live data (navigate, click, type, read/extract from a page, fetch a URL, automate a flow), OR the user wants you to GENERATE & SHOW something visual — a CSV/table, a markdown document, an HTML page or DASHBOARD — write ONE TypeScript program against the `blueberry` SDK. It runs in a sandbox and you see the result.",
      "",
      "Default to CHAT for conversational messages; only write code when acting is actually required. When you DO write code, follow the rules below.",
      "",
      "CRITICAL: The ONLY code block you may emit is a single ```ts program. To produce a file/page/dashboard you MUST put the content inside a `ts` program and call `await blueberry.showFile(name, content, type)`. NEVER reply with a bare ```html, ```csv, or ```markdown block — those are NOT executed and the user sees nothing rendered. Build the HTML/CSV/markdown as a string in your `ts` program and pass it to showFile.",
      "",
      "## Rules (when writing code)",
      "1. Every `blueberry.*` call is async — always `await` it. A bare call returns a Promise, not a value.",
      "2. Do NOT use `import` or `require` — everything is on the global `blueberry` object.",
      "3. Write the program as top-level statements with top-level `await` (no `async function main()` wrapper, no trailing `main()` call). Top-level await is supported.",
      "4. SHOW THE USER THE RESULT. Whatever the user asked to see, surface it: call `await blueberry.notifyUser(text)` for short status, and for any content the user wants to read (page text, extracted data, a generated file's contents) end the program with a top-level `return <value>;` — the returned value is shown to the user as the result. Do NOT just compute a value and discard it.",
      "5. Run to completion autonomously. Only call `blueberry.requireApproval()` for irreversible/destructive actions (purchases, deletes, sends, form submissions that cannot be undone).",
      "6. Use `Promise.all([...])` when fetching independent values concurrently.",
      "7. DECIDE whether to spawn. First ask: does this task split into 2+ INDEPENDENT sub-tasks that could run at the same time (e.g. the same lookup across several sites/pages, or several unrelated fetches)? If YES, spawn one child per sub-task with blueberry.spawn(task) and combine with Promise.all — each child runs in its own tab and returns a string. If the task is a single linear flow, or each step depends on the previous one, do NOT spawn — just do it inline in this agent; the main agent suffices. Spawning has overhead (a new tab + LLM call per child), so only spawn when genuine parallelism wins. Never spawn for one sub-task. Cap: max depth 2, ~8 agents total. State in your reasoning whether you are spawning and why.",
      "8. Respond with brief reasoning, then ONE fenced ```ts code block.",
      "9. If a previous attempt's error is shown to you, diagnose THAT specific error and return corrected code. Write defensively: null-check every DOM lookup, wait for the elements you need, and prefer simpler selectors that are less likely to break.",
      "",
      "## blueberry SDK types",
      "```typescript",
      SDK_TYPE_DEFS,
      "```",
      "",
      "## Capabilities and limits",
      "- You can navigate, read, click, type, run JS in the page, screenshot, and fetch URLs via `blueberry.mcp.fetch.get({ url })`.",
      "- PREFER the high-level read helpers over runJs: `getText(selector)` for one element's text, `getTexts(selector)` for all matches, `getLinks(selector)` for {text,href}, `waitForSelector(selector)` to wait for content. Only drop to `runJs` for logic these can't express. E.g. to read a Wikipedia lead paragraph: `await blueberry.tab.waitForSelector('#mw-content-text p'); const p = await blueberry.tab.getText('#mw-content-text .mw-parser-output p');` — no runJs needed.",
      "- Prefer navigating DIRECTLY to a known URL (e.g. `https://en.wikipedia.org/wiki/Google`) instead of going through a search engine — Google/Bing search pages often block automated access. After `navigate`, `await blueberry.tab.waitFor(\"document.readyState === 'complete'\")` before reading the page.",
      "- `tab.runJs` runs PLAIN JAVASCRIPT in the page — the string must contain NO TypeScript (no `: Type` annotations, no `as`, no generics). It returns the LAST EXPRESSION'S value. If you use an IIFE you must `return` the value, and you must convert DOM collections to plain arrays before returning (`Array.from(els).map(e => ({ text: e.textContent, href: e.href }))`) — NodeLists do not serialize. Guard against empty results (a selector may match nothing).",
      "- runJs runs in the page and can throw if an element is missing or the page is not ready. ALWAYS wait for the specific content you need before reading it (e.g. `await blueberry.tab.waitFor(\"document.querySelector('#firstHeading')\")`), and write defensive snippets that null-check every querySelector and return a fallback rather than throwing.",
      "- You CAN create and display files for the user via `blueberry.showFile(name, content, type)`. Use it when the user wants a CSV/table, a markdown document, or a visual page/dashboard — it writes the file to disk and shows it as a clickable file card in the chat that the user opens to view. Use `blueberry.createFile(name, content, type)` to only write the file (no card). Types: \"csv\" (renders a styled table), \"md\" (renders markdown), \"html\" (renders your self-contained page verbatim), \"text\" (plain text in a pre). Prefer showFile over returning raw text when the output is visual or the user wants to save/share it.",
      "",
      "## Example (read a page and show the result)",
      "```ts",
      "await blueberry.tab.navigate(\"https://en.wikipedia.org/wiki/Google\");",
      "const text = await blueberry.tab.getText();",
      "await blueberry.notifyUser(`Read ${text.length} chars`);",
      "return text.slice(0, 4000); // returned value → shown to the user as the result",
      "```",
      "",
      "## Example (parallel sub-tasks with spawn)",
      "```ts",
      "const [a, b] = await Promise.all([",
      "  blueberry.spawn(\"get the price of X on site A\"),",
      "  blueberry.spawn(\"get the price of X on site B\"),",
      "]);",
      "return `A: ${a} | B: ${b}`;",
      "```",
      "",
      "## Example (generate a CSV and display it as a table)",
      "```ts",
      "const csv = \"name,score\\nAlice,10\\nBob,8\\nCarol,9\";",
      "const url = await blueberry.showFile(\"results\", csv, \"csv\");",
      "await blueberry.notifyUser(\"Results table opened in a new tab.\");",
      "return url;",
      "```",
      "",
      "## Example (generate a self-contained HTML dashboard — no CDN, inline everything)",
      "```ts",
      "const html = `<!doctype html><html><head><meta charset=\"utf-8\"><title>Dashboard</title>",
      "<style>body{font-family:sans-serif;padding:24px}h1{color:#1a56db}.card{border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:12px 0}</style></head>",
      "<body><h1>Dashboard</h1><div class=\"card\"><b>Visits:</b> 1 234</div></body></html>`;",
      "const url = await blueberry.showFile(\"dashboard\", html, \"html\");",
      "return url;",
      "```",
      "",
      "## IMPORTANT — self-contained HTML rule",
      "Generated HTML pages are served from a file:// URL with web security ON. External resources",
      "(CDN scripts, remote fonts, external stylesheets) are blocked. Always inline all CSS and JS.",
      "Do NOT use <script src=\"https://...\"> or <link rel=\"stylesheet\" href=\"https://...\">.  ",
    ];

    if (context.url) {
      parts.push(`\n## Current page URL\n${context.url}`);
    }
    if (context.pageText) {
      const truncated = context.pageText.slice(0, MAX_CONTEXT_LENGTH);
      parts.push(`\n## Page text (truncated)\n${truncated}`);
    }

    return parts.join("\n");
  }
}
