import { contextBridge } from "electron";
import { electronAPI } from "@electron-toolkit/preload";
import { typedInvoke } from "./typed-invoke";

// TopBar specific APIs
const topBarAPI = {
  // Tab management
  createTab: (url?: string) =>
    typedInvoke("create-tab", url),
  closeTab: (tabId: string) =>
    typedInvoke("close-tab", tabId),
  switchTab: (tabId: string) =>
    typedInvoke("switch-tab", tabId),
  getTabs: () => typedInvoke("get-tabs"),

  // Tab navigation
  navigateTab: (tabId: string, url: string) =>
    typedInvoke("navigate-tab", tabId, url),
  goBack: (tabId: string) =>
    typedInvoke("tab-go-back", tabId),
  goForward: (tabId: string) =>
    typedInvoke("tab-go-forward", tabId),
  reload: (tabId: string) =>
    typedInvoke("tab-reload", tabId),

  // Tab actions
  tabScreenshot: (tabId: string) =>
    typedInvoke("tab-screenshot", tabId),
  tabRunJs: (tabId: string, code: string) =>
    typedInvoke("tab-run-js", tabId, code),

  // Sidebar
  toggleSidebar: () =>
    typedInvoke("toggle-sidebar"),
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("topBarAPI", topBarAPI);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.topBarAPI = topBarAPI;
}

