import { BaseWindow } from "electron";
import { Tab } from "./Tab";
import { TopBar } from "./TopBar";
import { SideBar } from "./SideBar";
import { TabService } from "./TabService";
import { TOPBAR_HEIGHT, SIDEBAR_WIDTH } from "./constants";

export class Window {
  private _baseWindow: BaseWindow;
  private tabsMap: Map<string, Tab> = new Map();
  private activeTabId: string | null = null;
  private tabCounter: number = 0;
  /** Tab IDs created for agent background use — excluded from get-tabs. */
  private backgroundTabIds: Set<string> = new Set();
  /**
   * Maps an agent background tab → the popup tabs its page spawned
   * (target="_blank"/window.open). These are owned by the agent and reaped
   * when the agent tab is destroyed, so an agent's own browsing never leaves
   * orphan tabs behind. See createAgentChildTab / destroyTab.
   */
  private agentChildTabs: Map<string, Set<string>> = new Map();
  private _topBar: TopBar;
  private _sideBar: SideBar;
  private _tabService: TabService = new TabService(
    (id) => this.tabsMap.get(id) ?? null,
    () => this.activeTab,
    () => this.createBackgroundTab(),
    (id) => this.destroyTab(id),
    (url) => { const t = this.createTab(url); this.switchActiveTab(t.id); return t; },
  );

  constructor() {
    // Create the browser window.
    this._baseWindow = new BaseWindow({
      width: 1000,
      height: 800,
      show: true,
      autoHideMenuBar: false,
      titleBarStyle: "hidden",
      ...(process.platform !== "darwin" ? { titleBarOverlay: true } : {}),
      trafficLightPosition: { x: 15, y: 13 },
    });

    this._baseWindow.setMinimumSize(1000, 800);

    this._topBar = new TopBar(this._baseWindow);
    this._sideBar = new SideBar(this._baseWindow, this._tabService.activeTab, this._tabService);

    // Create the first tab
    this.createTab();

    // Set up window resize handler
    this._baseWindow.on("resize", () => {
      this.updateTabBounds();
      this._topBar.updateBounds();
      this._sideBar.updateBounds();
      // Notify renderer of resize through active tab
      const bounds = this._baseWindow.getBounds();
      if (this.activeTab) {
        this.activeTab.webContents.send("window-resized", {
          width: bounds.width,
          height: bounds.height,
        });
      }
    });

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this._baseWindow.on("closed", () => {
      // Clean up all tabs when window is closed
      this.tabsMap.forEach((tab) => tab.destroy());
      this.tabsMap.clear();
    });
  }

  // Getters
  get window(): BaseWindow {
    return this._baseWindow;
  }

  get activeTab(): Tab | null {
    if (this.activeTabId) {
      return this.tabsMap.get(this.activeTabId) || null;
    }
    return null;
  }

  /** All tabs, including agent-owned tabs (shown in the strip, never auto-focused). */
  get allTabs(): Tab[] {
    return Array.from(this.tabsMap.values());
  }

  /** Agent-owned tab ids — surfaced so the strip can label them by owner. */
  get agentTabIds(): string[] {
    return Array.from(this.backgroundTabIds);
  }

  get tabCount(): number {
    return this.tabsMap.size;
  }

  /** Open a link (from a page's target="_blank"/window.open) as a focused in-app tab. */
  private openLinkInNewTab(url: string): void {
    const tab = this.createTab(url);
    this.switchActiveTab(tab.id);
  }

  /**
   * Open a popup from an AGENT tab (`ownerTabId`) as a hidden child tab owned by
   * that agent, rather than a focused user tab. The child renders like any other
   * background tab and is recorded under the agent's root owner so destroyTab can
   * reap the whole tree when the agent finishes. Its own popups nest under the
   * same root owner (resolved via agentChildTabs), so chains don't leak either.
   */
  private createAgentChildTab(ownerTabId: string, url: string): void {
    // Resolve to the ROOT agent owner: if ownerTabId is itself a tracked child,
    // attribute the new popup to the agent at the top of the chain.
    let rootOwner = ownerTabId;
    for (const [owner, children] of this.agentChildTabs) {
      if (children.has(ownerTabId)) {
        rootOwner = owner;
        break;
      }
    }
    const child = this.createBackgroundTab();
    child.loadURL(url);
    let set = this.agentChildTabs.get(rootOwner);
    if (!set) {
      set = new Set();
      this.agentChildTabs.set(rootOwner, set);
    }
    set.add(child.id);
  }

  // Tab management methods
  createTab(url?: string): Tab {
    const tabId = `tab-${++this.tabCounter}`;
    const tab = new Tab(tabId, url, (linkUrl) => this.openLinkInNewTab(linkUrl));

    // Add the tab's WebContentsView to the window
    this._baseWindow.contentView.addChildView(tab.view);

    // Set the bounds to fill the window below the topbar and to the left of sidebar
    const bounds = this._baseWindow.getBounds();
    tab.view.setBounds({
      x: 0,
      y: TOPBAR_HEIGHT, // Start below the topbar
      width: bounds.width - SIDEBAR_WIDTH, // Subtract sidebar width
      height: bounds.height - TOPBAR_HEIGHT, // Subtract topbar height
    });

    // Store the tab
    this.tabsMap.set(tabId, tab);

    // If this is the first tab, make it active
    if (this.tabsMap.size === 1) {
      this.switchActiveTab(tabId);
    } else {
      // Hide the tab initially if it's not the first one
      tab.hide();
    }

    return tab;
  }

  closeTab(tabId: string): boolean {
    const tab = this.tabsMap.get(tabId);
    if (!tab) {
      return false;
    }

    // Remove the WebContentsView from the window
    this._baseWindow.contentView.removeChildView(tab.view);

    // Destroy the tab
    tab.destroy();

    // Remove from our tabs map
    this.tabsMap.delete(tabId);
    this.backgroundTabIds.delete(tabId); // keep agent-tab set consistent

    // If this was the active tab, switch to another tab
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
      const remainingTabs = Array.from(this.tabsMap.keys());
      if (remainingTabs.length > 0) {
        this.switchActiveTab(remainingTabs[0]);
      }
    }

    // If no tabs left, close the window
    if (this.tabsMap.size === 0) {
      this._baseWindow.close();
    }

    return true;
  }

  switchActiveTab(tabId: string): boolean {
    const tab = this.tabsMap.get(tabId);
    if (!tab) {
      return false;
    }

    // Bring the new active tab to the TOP of the view stack. We no longer
    // hide other tabs (agent tabs must keep rendering behind this one), so
    // visibility is purely z-order: re-adding a child view puts it on top.
    tab.show();
    this._baseWindow.contentView.addChildView(tab.view);
    this.activeTabId = tabId;
    this.updateTabBounds();

    // Update the window title to match the tab title
    this._baseWindow.setTitle(tab.title || "Blueberry Browser");

    return true;
  }

  getTab(tabId: string): Tab | null {
    return this.tabsMap.get(tabId) || null;
  }

  /**
   * Create a hidden background tab for agent use. Never switches active tab,
   * never sets visible bounds. Tracked in backgroundTabIds so get-tabs excludes it.
   */
  createBackgroundTab(): Tab {
    const tabId = `tab-${++this.tabCounter}`;
    // An agent tab's popups (target="_blank"/window.open) open as HIDDEN child
    // tabs parented to this agent — not focused user tabs. They're tracked in
    // agentChildTabs and reaped when this agent tab is destroyed, so the agent's
    // own browsing never leaves orphan tabs behind.
    const tab = new Tab(tabId, undefined, (linkUrl) => this.createAgentChildTab(tabId, linkUrl));
    // Add BELOW the active tab so it renders but stays hidden behind it. A
    // setVisible(false) view is throttled by Chromium and won't fully load
    // pages — agents need it rendering, just not in front of the user.
    const activeView = this.activeTabId ? this.tabsMap.get(this.activeTabId)?.view : undefined;
    if (activeView) {
      const idx = this._baseWindow.contentView.children.indexOf(activeView);
      this._baseWindow.contentView.addChildView(tab.view, Math.max(0, idx));
    } else {
      this._baseWindow.contentView.addChildView(tab.view);
    }
    this.tabsMap.set(tabId, tab);
    this.backgroundTabIds.add(tabId);
    this.updateTabBounds(); // give it real bounds so the page actually renders
    return tab;
  }

  /**
   * Destroy a tab created by createBackgroundTab (or any tab). Null-safe.
   * Removes from tabsMap and backgroundTabIds; never closes the window.
   */
  destroyTab(tabId: string): void {
    const tab = this.tabsMap.get(tabId);
    if (!tab) return;

    // Reap any popup tabs this agent tab spawned (target="_blank"/window.open),
    // so an agent's own browsing leaves no orphan tabs behind. Done before the
    // parent teardown; childIds are deleted from agentChildTabs as we go.
    const childIds = this.agentChildTabs.get(tabId);
    if (childIds) {
      this.agentChildTabs.delete(tabId);
      for (const childId of childIds) this.destroyTab(childId);
    }

    try {
      this._baseWindow.contentView.removeChildView(tab.view);
      tab.destroy();
    } catch {
      // Ignore errors during cleanup (e.g. already-destroyed view).
    }
    this.tabsMap.delete(tabId);
    this.backgroundTabIds.delete(tabId);

    // If the user was viewing this agent tab, fall back to another tab so the
    // content area doesn't go blank (mirrors closeTab's active-tab handling).
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
      const remaining = Array.from(this.tabsMap.keys());
      if (remaining.length > 0) this.switchActiveTab(remaining[0]);
    }
  }

  // Window methods
  show(): void {
    this._baseWindow.show();
  }

  hide(): void {
    this._baseWindow.hide();
  }

  close(): void {
    this._baseWindow.close();
  }

  focus(): void {
    this._baseWindow.focus();
  }

  minimize(): void {
    this._baseWindow.minimize();
  }

  maximize(): void {
    this._baseWindow.maximize();
  }

  unmaximize(): void {
    this._baseWindow.unmaximize();
  }

  isMaximized(): boolean {
    return this._baseWindow.isMaximized();
  }

  setTitle(title: string): void {
    this._baseWindow.setTitle(title);
  }

  setBounds(bounds: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }): void {
    this._baseWindow.setBounds(bounds);
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return this._baseWindow.getBounds();
  }

  // Handle window resize to update tab bounds
  private updateTabBounds(): void {
    const bounds = this._baseWindow.getBounds();
    // Only subtract sidebar width if it's visible
    const sidebarWidth = this._sideBar.getIsVisible() ? SIDEBAR_WIDTH : 0;

    this.tabsMap.forEach((tab) => {
      // Every tab (incl. agent tabs) gets normal bounds so its page renders.
      // Agent tabs sit BEHIND the active tab in the view stack, so they're
      // hidden from the user but still load/render — a setVisible(false) or
      // unbounded view is throttled by Chromium and won't load pages.
      tab.view.setBounds({
        x: 0,
        y: TOPBAR_HEIGHT, // Start below the topbar
        width: bounds.width - sidebarWidth,
        height: bounds.height - TOPBAR_HEIGHT, // Subtract topbar height
      });
    });
  }

  // Public method to update all bounds when sidebar is toggled
  updateAllBounds(): void {
    this.updateTabBounds();
    this._sideBar.updateBounds();
  }

  // Getter for sidebar to access from main process
  get sidebar(): SideBar {
    return this._sideBar;
  }

  // Getter for topBar to access from main process
  get topBar(): TopBar {
    return this._topBar;
  }

  // Getter for tabService to access from EventManager and agent code
  get tabService(): TabService {
    return this._tabService;
  }

  // Getter for all tabs as array
  get tabs(): Tab[] {
    return Array.from(this.tabsMap.values());
  }

  // Getter for baseWindow to access from Menu
  get baseWindow(): BaseWindow {
    return this._baseWindow;
  }
}
