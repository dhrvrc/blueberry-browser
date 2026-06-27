import { NativeImage, WebContentsView, shell } from "electron";

export class Tab {
  private webContentsView: WebContentsView;
  private _id: string;
  private _title: string;
  private _url: string;
  private _isVisible: boolean = false;
  // Called when the page opens a link in a new window (target="_blank" /
  // window.open) — the host opens it as a new in-app tab.
  private onOpenUrl?: (url: string) => void;

  constructor(id: string, url: string = "https://www.google.com", onOpenUrl?: (url: string) => void) {
    this._id = id;
    this._url = url;
    this._title = "New Tab";
    this.onOpenUrl = onOpenUrl;

    // Create the WebContentsView for web content only
    this.webContentsView = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });

    // Set up event listeners
    this.setupEventListeners();

    // Load the initial URL
    this.loadURL(url);
  }

  private setupEventListeners(): void {
    // Open target="_blank" / window.open links as a NEW IN-APP TAB (not a blank
    // Electron child window, and not the system browser). Applied per-tab here
    // so EVERY tab (incl. dynamically created ones like dashboards) gets it.
    this.webContentsView.webContents.setWindowOpenHandler((details) => {
      if (/^https?:/i.test(details.url) && this.onOpenUrl) this.onOpenUrl(details.url);
      else if (/^https?:/i.test(details.url)) shell.openExternal(details.url);
      return { action: "deny" };
    });

    // For a generated-file viewer tab (a static artifact, not a browsable page),
    // also send same-frame link clicks to a new tab so the artifact stays open.
    this.webContentsView.webContents.on("will-navigate", (event, url) => {
      const isViewer = this._url.startsWith("file://") && this._url.includes("/.blueberry/files/");
      if (!isViewer) return;
      if (/^https?:/i.test(url) && url !== this._url) {
        event.preventDefault();
        if (this.onOpenUrl) this.onOpenUrl(url);
      }
    });

    // Update title when page title changes
    this.webContentsView.webContents.on("page-title-updated", (_, title) => {
      this._title = title;
    });

    // Update URL when navigation occurs
    this.webContentsView.webContents.on("did-navigate", (_, url) => {
      this._url = url;
    });

    this.webContentsView.webContents.on("did-navigate-in-page", (_, url) => {
      this._url = url;
    });
  }

  // Getters
  get id(): string {
    return this._id;
  }

  get title(): string {
    return this._title;
  }

  get url(): string {
    return this._url;
  }

  get isVisible(): boolean {
    return this._isVisible;
  }

  get webContents() {
    return this.webContentsView.webContents;
  }

  get view(): WebContentsView {
    return this.webContentsView;
  }

  // Public methods
  show(): void {
    this._isVisible = true;
    this.webContentsView.setVisible(true);
  }

  hide(): void {
    this._isVisible = false;
    this.webContentsView.setVisible(false);
  }

  async screenshot(): Promise<NativeImage> {
    return await this.webContentsView.webContents.capturePage();
  }

  async runJs(code: string): Promise<any> {
    return await this.webContentsView.webContents.executeJavaScript(code);
  }

  async getTabHtml(): Promise<string> {
    return await this.runJs("document.documentElement.outerHTML");
  }

  async getTabText(): Promise<string> {
    return await this.runJs("document.documentElement.innerText");
  }

  loadURL(url: string): Promise<void> {
    this._url = url;
    return this.webContentsView.webContents.loadURL(url);
  }

  goBack(): void {
    if (this.webContentsView.webContents.navigationHistory.canGoBack()) {
      this.webContentsView.webContents.navigationHistory.goBack();
    }
  }

  goForward(): void {
    if (this.webContentsView.webContents.navigationHistory.canGoForward()) {
      this.webContentsView.webContents.navigationHistory.goForward();
    }
  }

  reload(): void {
    this.webContentsView.webContents.reload();
  }

  stop(): void {
    this.webContentsView.webContents.stop();
  }

  destroy(): void {
    this.webContentsView.webContents.close();
  }
}
