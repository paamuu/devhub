import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { maintenance } from "./maintenance";
export function handleIpc(
  channel: string,
  handler: (event: IpcMainInvokeEvent, input: unknown) => unknown,
) {
  ipcMain.handle(channel, (event, input: unknown) =>
    maintenance.request(() => handler(event, input)),
  );
}
