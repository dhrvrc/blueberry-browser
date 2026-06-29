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
// Now on Anthropic Opus 4.8 (LLM_PROVIDER=anthropic). The OpenAI entry stays
// as a fallback if the provider is flipped back to openai.
const AGENT_MODELS: Record<LLMProvider, string> = {
  openai: "gpt-5.4",
  anthropic: "claude-opus-4-8",
};

// Model for SPAWNED sub-agents — same as root for reliable page extraction.
const SUBAGENT_MODELS: Record<LLMProvider, string> = {
  openai: "gpt-5.4",
  anthropic: "claude-opus-4-8",
};

const MAX_CONTEXT_LENGTH = 4000;
const DEFAULT_TEMPERATURE = 0.7;
// The root agent model (gpt-5.1) is a reasoning model and rejects the
// `temperature` setting, so the agent path omits it (see streamCodeAct).
// Agent LLM calls are serialized through a gate with an ADAPTIVE gap: it starts
// at 0 (full speed) and only grows when the provider actually rate-limits us,
// then decays back down as calls succeed. So single-agent runs stay fast and
// only heavy multi-agent bursts slow down — as much as the account needs, no
// more. Bounds keep it sane.
const GAP_MIN_MS = 0;
const GAP_MAX_MS = 24_000;
const GAP_ON_LIMIT_MS = 8_000; // add this to the gap each time we get rate-limited
const GAP_DECAY_MS = 2_000; // subtract this after each successful call

/** True if the error is a provider rate-limit / quota error. */
function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rate.?limit|tokens per min|requests per min|TPM|RPM|too large|quota|429/i.test(msg);
}

/** Turn a provider error (esp. rate-limit / too-large) into a clear message. */
function translateLlmError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/rate.?limit|tokens per min|TPM|request too large|too large/i.test(msg)) {
    return new Error(
      "Hit the model's rate/token limit — the request was too large or too frequent. " +
        "Try a shorter task or wait a moment. (Raise the limit by adding billing to your OpenAI account.)",
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

export class LLMClient {
  private readonly webContents: WebContents;
  private readonly getActiveTab: () => Tab | null;
  private readonly provider: LLMProvider;
  private readonly modelName: string;
  private readonly model: LanguageModel | null;
  private readonly agentModel: LanguageModel | null;
  private readonly subAgentModel: LanguageModel | null;
  private messages: CoreMessage[] = [];
  // Serializing gate for agent LLM calls with an ADAPTIVE inter-call gap.
  // `agentGate` is a promise chain; each call waits its turn, then waits until
  // `agentGapMs` after the previous one. The gap grows on rate-limit errors and
  // decays on success (see noteRateLimit/noteSuccess).
  private agentGate: Promise<void> = Promise.resolve();
  private lastAgentCallAt = 0;
  private agentGapMs = GAP_MIN_MS;

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

  // Take a turn in the serialized agent-call gate, waiting until at least
  // MIN_AGENT_CALL_GAP_MS has passed since the previous call started. Returns
  // when it's safe to proceed; pair with releaseAgentSlot() in a finally.
  private acquireAgentSlot(): Promise<void> {
    const turn = this.agentGate.then(async () => {
      const wait = this.lastAgentCallAt + this.agentGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAgentCallAt = Date.now();
    });
    this.agentGate = turn.catch(() => {});
    return turn;
  }

  private releaseAgentSlot(): void {
    // No-op: the gate is time-based, not a counted resource. Kept so call sites
    // read symmetrically (acquire … finally release).
  }

  /** Grow the inter-call gap after a rate-limit error (capped). */
  private noteRateLimit(): void {
    this.agentGapMs = Math.min(GAP_MAX_MS, this.agentGapMs + GAP_ON_LIMIT_MS);
  }

  /** Decay the gap back toward 0 after a successful call. */
  private noteSuccess(): void {
    this.agentGapMs = Math.max(GAP_MIN_MS, this.agentGapMs - GAP_DECAY_MS);
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
    compact = false,
  ): Promise<string> {
    // Sub-agents use the cheaper/faster model; root uses the strong one.
    const model = tier === "sub" ? this.subAgentModel : this.agentModel;
    if (!model) {
      throw new Error("Agent model not initialized — check your API key");
    }

    const systemPrompt = this.buildAgentSystemPrompt(context, compact);
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
        // Rate-limit errors include a retry-after; let the SDK wait and retry a
        // few times rather than failing (important on low RPM accounts).
        maxRetries: 4,
        abortSignal,
      });
    } catch (err) {
      this.releaseAgentSlot();
      if (isRateLimitError(err)) this.noteRateLimit();
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

    this.noteSuccess(); // call completed — relax the adaptive gap a bit
    return fullText;
    } catch (err) {
      // Rate-limit / too-large errors surface here (mid-stream) — translate to
      // a clear message instead of the raw provider error.
      if (isRateLimitError(err)) this.noteRateLimit();
      throw translateLlmError(err);
    } finally {
      this.releaseAgentSlot();
    }
  }

  private buildAgentSystemPrompt(
    context: { url: string | null; pageText: string | null; screenshot: string | null },
    compact = false,
  ): string {
    const parts: string[] = [
      "You are Blueberry, an autonomous browser agent INSIDE a real web browser. You CAN and DO browse the live web: navigate to any site, read/extract rendered pages, click, type, and fetch URLs — by writing a TypeScript program against the `blueberry` SDK that runs in a real sandboxed browser tab. NEVER say you can't browse, can't access live sites, or can't fetch today's pages — you can. NEVER refuse a browse/scrape/extract task or offer to 'show example scripts the user could run' — just DO it with the SDK.",
      "",
      "Decide how to respond:",
      "- ACT (write ONE ```ts program): the DEFAULT for almost everything — any task involving the web, a page, live data, navigating/clicking/typing/extracting/scraping, fetching a URL, comparing multiple sites, automating a flow, OR generating something to show (CSV, markdown doc, HTML page, dashboard). If the task could possibly need the browser or live data, ACT.",
      "- CHAT (plain prose, no code): ONLY for pure small talk (e.g. 'thanks') or a question about what YOU just did. Questions about 'this page' / 'my current page' / 'what's on the screen' are ACT — read the LIVE page with `getText()`/`getHtml()`, do NOT answer from memory or describe something you built earlier.",
      "",
      "When in doubt, ACT. When you DO write code, follow the rules below.",
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
      "7. SPAWN sub-agents for multi-source work. RULE: if the task involves visiting/scraping 2+ DIFFERENT websites or sources (e.g. 'compare Hacker News and Lobsters', 'get headlines from 3 news sites', 'check the price on Amazon and eBay'), you MUST spawn one child agent per source with `blueberry.spawn(task)` and combine the results with `Promise.all` — each child gets its own tab and works in parallel, which is faster and avoids one site's failure breaking the others. Give each child a clear, self-contained task (which URL to visit, what to extract, what to return). Only do it inline (no spawn) when the task touches a SINGLE site or is a strictly sequential flow where each step depends on the previous. Cap: depth 1 (children cannot spawn), ~6 agents total. State in your reasoning whether you are spawning and why.",
      "   Example (2 sources → spawn 2): `const [hn, lob] = await Promise.all([ blueberry.spawn('Go to https://news.ycombinator.com/, get the top 10 story titles via getTexts(\".titleline a\"), return them as a numbered list'), blueberry.spawn('Go to https://lobste.rs/, get the top 10 story titles, return them as a numbered list') ]); /* then combine hn + lob into the final output */`",
      "8. Respond with brief reasoning, then ONE fenced ```ts code block.",
      "9. Write defensively: null-check every DOM lookup, wait for the elements you need, and prefer simpler selectors that are less likely to break.",
      "",
      "## blueberry SDK types",
      "```typescript",
      SDK_TYPE_DEFS,
      "```",
      "",
      "## Capabilities and limits",
      "- You can navigate, read, click, type, run JS in the page, screenshot, and fetch URLs via `blueberry.mcp.fetch.get({ url })`.",
      "- Sandboxed workspace via blueberry.mcp.fs.read/write/list/delete({path}) — path is relative to ~/.blueberry/workspace/, cannot escape via .. or absolute paths.",
      "- blueberry.mcp.data.* to crunch fetched/extracted data BEFORE building a dashboard or making a judgment: parseCsv/parseJson to load, then summarize/groupBy/filter/sort/topN to aggregate. Tools run in-process on the rows you pass in — thread the rows array between calls. Summarize or aggregate large data instead of dumping raw rows.",
      "- INSPECT BEFORE YOU EXTRACT. Do NOT guess CSS selectors blindly (`.card`, `.startup`, `article`…) — guessed selectors that match nothing are the #1 cause of empty results. First look at the real page: `await blueberry.tab.getHtml()` (or `runJs` returning a small sample like the outerHTML of the first few candidate elements) to discover the ACTUAL tags/classes the data uses, THEN write extraction code with selectors you have confirmed exist. For a list of N items, first verify the count: `await blueberry.tab.runJs('document.querySelectorAll(\"<your-selector>\").length')` and check it's roughly N before extracting.",
      "- VERIFY YOUR RESULT before finishing. After extracting, check you actually got data: if you expected ~100 rows and got 0 (or only headers), the selector was wrong — DO NOT save an empty CSV or claim success. Inspect the DOM again, fix the selector, and re-extract. Only produce the final file/answer once the data is real and non-empty.",
      "- To extract content FROM A WEBSITE (headlines, lists, links, prices), NAVIGATE to it and use the DOM helpers (`getTexts`, `getLinks`, `getText`) — they run against the real rendered page and are reliable. Do NOT use `mcp.fetch.get` + regex on raw HTML to scrape pages — that is brittle and usually fails (sites return different/blocked markup to non-browsers). Reserve `mcp.fetch.get` for plain data endpoints (JSON/text APIs), not for scraping rendered sites. Example for HN: `await blueberry.tab.navigate('https://news.ycombinator.com/'); await blueberry.tab.waitForSelector('.titleline a'); const titles = await blueberry.tab.getTexts('.titleline a');`",
      "- When extracting HEADLINES/ARTICLES, target the article-link container, NOT every <a> on the page — a broad selector catches the logo, nav menu, 'Home', section names, and the site title (e.g. 'BBC Home' is NOT a headline). Prefer a specific article selector; FILTER results to plausible headlines (drop empty text, very short labels < ~15 chars, nav words like Home/Menu/Sign in/Sections, and the site's own name); and DEDUPLICATE. If you got too few or junk results, inspect the DOM and pick a better selector before finishing.",
      "- PREFER the high-level read helpers over runJs: `getText(selector)` for one element's text, `getTexts(selector)` for all matches, `getLinks(selector)` for {text,href}, `waitForSelector(selector)` to wait for content. Only drop to `runJs` for logic these can't express. E.g. to read a Wikipedia lead paragraph: `await blueberry.tab.waitForSelector('#mw-content-text p'); const p = await blueberry.tab.getText('#mw-content-text .mw-parser-output p');` — no runJs needed.",
      "- Prefer navigating DIRECTLY to a known URL (e.g. `https://en.wikipedia.org/wiki/Google`) instead of going through a search engine — Google/Bing search pages often block automated access. After `navigate`, `await blueberry.tab.waitFor(\"document.readyState === 'complete'\")` before reading the page.",
      "- `tab.runJs` runs PLAIN JAVASCRIPT in the page — the string must contain NO TypeScript (no `: Type` annotations, no `as`, no generics). It returns the LAST EXPRESSION'S value. If you use an IIFE you must `return` the value, and you must convert DOM collections to plain arrays before returning (`Array.from(els).map(e => ({ text: e.textContent, href: e.href }))`) — NodeLists do not serialize. Guard against empty results (a selector may match nothing).",
      "- runJs runs in the page and can throw if an element is missing or the page is not ready. ALWAYS wait for the specific content you need before reading it (e.g. `await blueberry.tab.waitFor(\"document.querySelector('#firstHeading')\")`), and write defensive snippets that null-check every querySelector and return a fallback rather than throwing.",
      "- You CAN create and display files for the user via `blueberry.showFile(name, content, type)`. Use it when the user wants a CSV/table, a markdown document, or a visual page/dashboard — it writes the file to disk and shows it as a clickable file card in the chat that the user opens to view. Use `blueberry.createFile(name, content, type)` to only write the file (no card). Types: \"csv\" (renders a styled table), \"md\" (renders markdown), \"html\" (renders your self-contained page verbatim), \"text\" (plain text in a pre). Prefer showFile over returning raw text when the output is visual or the user wants to save/share it.",
    ];

    // Full prompt: include worked examples. Compact prompt (continuation turns)
    // drops these to halve the per-turn token cost on low-TPM accounts (OQ1).
    // The SDK type defs above are always included — the model needs them every turn.
    if (!compact) {
      parts.push(
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
        "## Example (fetch CSV/JSON data → aggregate → show dashboard)",
        "```ts",
        "const { text } = await blueberry.mcp.fetch.get({ url: \"https://example.com/data.csv\" });",
        "const rows = await blueberry.mcp.data.parseCsv({ content: text });",
        "const top = await blueberry.mcp.data.topN({ rows, by: \"revenue\", n: 5 });",
        "const cols = top.length > 0 ? Object.keys(top[0]) : [];",
        "const thead = \"<tr>\" + cols.map(c => \"<th>\" + c + \"</th>\").join(\"\") + \"</tr>\";",
        "const tbody = top.map(r => \"<tr>\" + cols.map(c => \"<td>\" + r[c] + \"</td>\").join(\"\") + \"</tr>\").join(\"\");",
        "const html = \"<!doctype html><html><head><meta charset=\\\"utf-8\\\"><title>Report</title>\"",
        "  + \"<style>body{font-family:sans-serif;padding:24px}table{border-collapse:collapse}\"",
        "  + \"th,td{border:1px solid #ccc;padding:6px 12px}th{background:#f3f4f6}</style></head>\"",
        "  + \"<body><h1>Top 5 by Revenue</h1><table>\" + thead + tbody + \"</table></body></html>\";",
        "const url = await blueberry.showFile(\"report\", html, \"html\");",
        "return url;",
        "```",
      );
    }

    parts.push(
      "",
      "## IMPORTANT — self-contained HTML rule",
      "Generated HTML pages are served from a file:// URL with web security ON. External resources",
      "(CDN scripts, remote fonts, external stylesheets) are blocked. Always inline all CSS and JS.",
      "Do NOT use <script src=\"https://...\"> or <link rel=\"stylesheet\" href=\"https://...\">.",
      "Use ONLY real data you actually gathered. Do NOT invent fake URLs, emails, or phone numbers",
      "(e.g. example-company.ie) — fabricated links go nowhere and mislead the user. If you don't have",
      "a real value, omit the link or label it clearly as a placeholder. Real links should use the",
      "actual URLs you found; they open in the system browser when clicked.",
    );

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
