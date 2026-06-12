import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { IpcSchema } from "../shared/ipc-schema";

export function typedHandle<C extends keyof IpcSchema>(
  channel: C,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: IpcSchema[C]["params"]
  ) => Promise<IpcSchema[C]["result"]> | IpcSchema[C]["result"]
): void {
  ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1]);
}
