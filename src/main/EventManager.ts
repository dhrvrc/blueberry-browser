import { ipcMain, WebContents } from "electron";
import type { Window } from "./Window";
import { typedHandle } from "./typed-handle";
import { registerAgentIpc } from "./agent/AgentIPC";

export class EventManager {
  private mainWindow: Window;

  constructor(mainWindow: Window) {
    this.mainWindow = mainWindow;
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Tab management events
    this.handleTabEvents();

    // Sidebar events
    this.handleSidebarEvents();

    // Page content events
    this.handlePageContentEvents();

    // Dark mode events
    this.handleDarkModeEvents();

    // Agent events
    this.handleAgentEvents();

    // Debug events
    this.handleDebugEvents();
  }

  private handleTabEvents(): void {
    const tabService = this.mainWindow.tabService;

    // Create new tab
    typedHandle("create-tab", (_, url?) => {
      const newTab = this.mainWindow.createTab(url);
      return { id: newTab.id, title: newTab.title, url: newTab.url };
    });

    // Close tab
    typedHandle("close-tab", (_, id) => {
      this.mainWindow.closeTab(id);
    });

    // Switch tab
    typedHandle("switch-tab", (_, id) => {
      this.mainWindow.switchActiveTab(id);
    });

    // Get tabs
    typedHandle("get-tabs", () => {
      const activeTabId = this.mainWindow.activeTab?.id;
      const agentTabIds = new Set(this.mainWindow.agentTabIds);
      return this.mainWindow.allTabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        isActive: activeTabId === tab.id,
        isAgent: agentTabIds.has(tab.id),
      }));
    });

    typedHandle("navigate-tab", async (_, tabId, url) => {
      if (!this.mainWindow.getTab(tabId)) return false;
      await tabService.navigate(tabId, url);
      return true;
    });

    // Tab-specific navigation handlers
    typedHandle("tab-go-back", (_, tabId) => {
      if (!this.mainWindow.getTab(tabId)) return false;
      tabService.goBack(tabId);
      return true;
    });

    typedHandle("tab-go-forward", (_, tabId) => {
      if (!this.mainWindow.getTab(tabId)) return false;
      tabService.goForward(tabId);
      return true;
    });

    typedHandle("tab-reload", (_, tabId) => {
      if (!this.mainWindow.getTab(tabId)) return false;
      tabService.reload(tabId);
      return true;
    });

    typedHandle("tab-screenshot", async (_, tabId) => {
      if (!this.mainWindow.getTab(tabId)) return null;
      return tabService.screenshot(tabId);
    });

    typedHandle("tab-run-js", async (_, tabId, code) => {
      if (!this.mainWindow.getTab(tabId)) return null;
      return tabService.runJs(tabId, code);
    });
  }

  private handleSidebarEvents(): void {
    // Toggle sidebar
    typedHandle("toggle-sidebar", () => {
      this.mainWindow.sidebar.toggle();
      this.mainWindow.updateAllBounds();
      return true;
    });

    // Chat message
    typedHandle("sidebar-chat-message", async (_, request) => {
      // The LLMClient now handles getting the screenshot and context directly
      await this.mainWindow.sidebar.client.sendChatMessage(request);
    });

    // Clear chat
    typedHandle("sidebar-clear-chat", () => {
      this.mainWindow.sidebar.client.clearMessages();
      return true;
    });

    // Get messages
    typedHandle("sidebar-get-messages", () => {
      return this.mainWindow.sidebar.client.getMessages();
    });
  }

  private handlePageContentEvents(): void {
    const tabService = this.mainWindow.tabService;

    // Get page content
    typedHandle("get-page-content", async () => {
      const active = this.mainWindow.activeTab;
      if (!active) return null;
      try {
        return await tabService.getHtml(active.id);
      } catch (error) {
        console.error("Error getting page content:", error);
        return null;
      }
    });

    // Get page text
    typedHandle("get-page-text", async () => {
      const active = this.mainWindow.activeTab;
      if (!active) return null;
      try {
        return await tabService.getText(active.id);
      } catch (error) {
        console.error("Error getting page text:", error);
        return null;
      }
    });

    // Get current URL
    typedHandle("get-current-url", () => {
      if (this.mainWindow.activeTab) {
        return this.mainWindow.activeTab.url;
      }
      return null;
    });
  }

  private handleDarkModeEvents(): void {
    // Dark mode broadcasting
    ipcMain.on("dark-mode-changed", (event, isDarkMode) => {
      this.broadcastDarkMode(event.sender, isDarkMode);
    });
  }

  private handleAgentEvents(): void {
    registerAgentIpc(this.mainWindow.sidebar.agent);
  }

  private handleDebugEvents(): void {
    // Ping test
    ipcMain.on("ping", () => console.log("pong"));
  }

  private broadcastDarkMode(sender: WebContents, isDarkMode: boolean): void {
    // Send to topbar
    if (this.mainWindow.topBar.view.webContents !== sender) {
      this.mainWindow.topBar.view.webContents.send(
        "dark-mode-updated",
        isDarkMode
      );
    }

    // Send to sidebar
    if (this.mainWindow.sidebar.view.webContents !== sender) {
      this.mainWindow.sidebar.view.webContents.send(
        "dark-mode-updated",
        isDarkMode
      );
    }

    // Send to all tabs
    this.mainWindow.allTabs.forEach((tab) => {
      if (tab.webContents !== sender) {
        tab.webContents.send("dark-mode-updated", isDarkMode);
      }
    });
  }

  // Clean up event listeners
  public cleanup(): void {
    ipcMain.removeAllListeners();
  }
}
