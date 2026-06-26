import { is } from "@electron-toolkit/utils";
import { BaseWindow, WebContentsView } from "electron";
import { join } from "path";
import { LLMClient } from "./LLMClient";
import { TOPBAR_HEIGHT, SIDEBAR_WIDTH } from "./constants";
import type { Tab } from "./Tab";
import type { TabService } from "./TabService";
import { AgentService } from "./agent/AgentService";

export class SideBar {
  private webContentsView: WebContentsView;
  private baseWindow: BaseWindow;
  private llmClient: LLMClient;
  private _agentService: AgentService;
  private isVisible: boolean = true;

  constructor(baseWindow: BaseWindow, getActiveTab: () => Tab | null, tabService: TabService) {
    this.baseWindow = baseWindow;
    this.webContentsView = this.createWebContentsView();
    baseWindow.contentView.addChildView(this.webContentsView);
    this.setupBounds();

    // Initialize LLM client with a resolver for the active tab (avoids a
    // circular Window <-> LLMClient dependency).
    this.llmClient = new LLMClient(
      this.webContentsView.webContents,
      getActiveTab,
    );

    // Agent service — shares the same LLMClient and tabService as chat.
    this._agentService = new AgentService(
      this.webContentsView.webContents,
      tabService,
      this.llmClient,
    );
  }

  private createWebContentsView(): WebContentsView {
    const webContentsView = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, "../preload/sidebar.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // Need to disable sandbox for preload to work
      },
    });

    // Load the Sidebar React app
    if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
      // In development, load through Vite dev server
      const sidebarUrl = new URL(
        "/sidebar/",
        process.env["ELECTRON_RENDERER_URL"],
      );
      webContentsView.webContents.loadURL(sidebarUrl.toString());
    } else {
      webContentsView.webContents.loadFile(
        join(__dirname, "../renderer/sidebar.html"),
      );
    }

    return webContentsView;
  }

  private setupBounds(): void {
    if (!this.isVisible) return;

    const bounds = this.baseWindow.getBounds();
    this.webContentsView.setBounds({
      x: bounds.width - SIDEBAR_WIDTH, // sidebar on the right
      y: TOPBAR_HEIGHT, // Start below the topbar
      width: SIDEBAR_WIDTH,
      height: bounds.height - TOPBAR_HEIGHT, // Subtract topbar height
    });
  }

  updateBounds(): void {
    if (this.isVisible) {
      this.setupBounds();
    } else {
      // Hide the sidebar
      this.webContentsView.setBounds({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    }
  }

  get view(): WebContentsView {
    return this.webContentsView;
  }

  get client(): LLMClient {
    return this.llmClient;
  }

  get agent(): AgentService {
    return this._agentService;
  }

  show(): void {
    this.isVisible = true;
    this.setupBounds();
  }

  hide(): void {
    this.isVisible = false;
    this.webContentsView.setBounds({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  }

  toggle(): void {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  getIsVisible(): boolean {
    return this.isVisible;
  }
}
