import { ipcRenderer } from "electron";
import type { IpcSchema } from "../shared/ipc-schema";

export function typedInvoke<C extends keyof IpcSchema>(
  channel: C,
  ...args: IpcSchema[C]["params"]
): Promise<IpcSchema[C]["result"]> {
  return ipcRenderer.invoke(channel, ...args);
}
