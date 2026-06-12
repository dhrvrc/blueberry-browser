import type { Tab } from "./Tab";

/**
 * Named tab operations decoupled from Window. IPC handlers and (future)
 * agent code call these instead of reaching through a Window reference.
 */
export class TabService {
  constructor(
    private readonly getTab: (id: string) => Tab | null,
    private readonly getActiveTab: () => Tab | null
  ) {}

  /** Resolver for the currently active tab — passed to LLMClient/agent. */
  readonly activeTab = (): Tab | null => this.getActiveTab();

  private require(tabId: string): Tab {
    const tab = this.getTab(tabId);
    if (!tab) throw new Error(`Tab not found: ${tabId}`);
    return tab;
  }

  runJs(tabId: string, code: string): Promise<unknown> {
    return this.require(tabId).runJs(code);
  }

  async screenshot(tabId: string): Promise<string> {
    const image = await this.require(tabId).screenshot();
    return image.toDataURL();
  }

  navigate(tabId: string, url: string): Promise<void> {
    return this.require(tabId).loadURL(url);
  }

  goBack(tabId: string): void {
    this.require(tabId).goBack();
  }

  goForward(tabId: string): void {
    this.require(tabId).goForward();
  }

  reload(tabId: string): void {
    this.require(tabId).reload();
  }

  getHtml(tabId: string): Promise<string> {
    return this.require(tabId).getTabHtml();
  }

  getText(tabId: string): Promise<string> {
    return this.require(tabId).getTabText();
  }
}
