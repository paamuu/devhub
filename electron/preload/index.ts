import { contextBridge, ipcRenderer } from "electron";
import {
  directoryChannel,
  workspaceStatusChannel,
  runtimeChannel,
  previewEventChannel,
  gitChannel,
  backupChannel,
} from "../../shared/channels";
import type { DevHubAPI } from "../../shared/contracts";
import { creationChannel } from "../../shared/channels";

const api: DevHubAPI = {
  backup: (request) => ipcRenderer.invoke(backupChannel, request),
  git: (request) => ipcRenderer.invoke(gitChannel, request),
  runtime: (request) => ipcRenderer.invoke(runtimeChannel, request),
  onPreview: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      session: Parameters<typeof callback>[0],
    ) => callback(session);
    ipcRenderer.on(previewEventChannel, listener);
    return () => ipcRenderer.removeListener(previewEventChannel, listener);
  },
  creation: (request) => ipcRenderer.invoke(creationChannel, request),
  workspaceStatus: () => ipcRenderer.invoke(workspaceStatusChannel),
  directory: (request) => ipcRenderer.invoke(directoryChannel, request),
};

contextBridge.exposeInMainWorld("devhub", api);
