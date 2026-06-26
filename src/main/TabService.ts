import type { Tab } from "./Tab";

/**
 * Named tab operations decoupled from Window. IPC handlers and (future)
 * agent code call these instead of reaching through a Window reference.
 */
export class TabService {
  constructor(
    private readonly getTab: (id: string) => Tab | null,
    private readonly getActiveTab: () => Tab | null,
    /** Optional: provision a hidden background tab for agent use. */
    private readonly createBgTab?: () => Tab,
    /** Optional: tear down a background tab by id. */
    private readonly destroyBgTab?: (id: string) => void,
    /** Optional: open a user-visible tab (creates + focuses it). */
    private readonly createUserTabCb?: (url: string) => Tab,
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

  /**
   * Provision a hidden background tab for a child agent.
   * Returns the new tab's id. Throws if not wired (Window didn't pass createBgTab).
   */
  createBackgroundTab(): string {
    if (!this.createBgTab) {
      throw new Error("TabService: createBackgroundTab not wired — createBgTab callback is missing");
    }
    const tab = this.createBgTab();
    return tab.id;
  }

  /**
   * Tear down a background tab created by createBackgroundTab.
   * No-op if not wired.
   */
  destroyBackgroundTab(id: string): void {
    if (this.destroyBgTab) {
      this.destroyBgTab(id);
    }
  }

  /**
   * Open a user-visible tab at `url` (creates the tab and focuses it).
   * Returns the new tab's id. Throws if not wired (Window didn't pass createUserTabCb).
   */
  openUserTab(url: string): string {
    if (!this.createUserTabCb) {
      throw new Error("TabService: openUserTab not wired — createUserTabCb callback is missing");
    }
    const tab = this.createUserTabCb(url);
    return tab.id;
  }
}
