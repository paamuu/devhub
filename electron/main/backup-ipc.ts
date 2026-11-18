import {
  ipcMain,
  dialog,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import type { DatabaseSync } from "node:sqlite";
import type { EnvironmentStore } from "./environment-store";
import { BackupStore, BackupError, type PreparedBackup } from "./backup-store";
import { maintenance } from "./maintenance";
import { backupChannel } from "../../shared/channels";
import { backupRequest, type BackupResult } from "../../shared/backup";

interface Options {
  window: BrowserWindow;
  trusted(event: IpcMainInvokeEvent): boolean;
  store: BackupStore;
  database(): DatabaseSync | undefined;
  environment(): EnvironmentStore | undefined;
  creationActive(): boolean;
  close(): Promise<void>;
  restart(): void;
  startupMessage: string;
  appVersion: string;
}
export function registerBackupHandler(options: Options) {
  let prepared: PreparedBackup | undefined,
    expires = 0,
    busy = false;
  let pending: Promise<void> = Promise.resolve();
  ipcMain.handle(
    backupChannel,
    async (event, input: unknown): Promise<BackupResult> => {
      if (!options.trusted(event))
        return { ok: false, error: { message: "请求来源无效。" } };
      const parsed = backupRequest.safeParse(input);
      if (!parsed.success)
        return { ok: false, error: { message: "备份请求无效。" } };
      if (parsed.data.action === "status")
        return { ok: true, data: { message: options.startupMessage } };
      if (busy)
        return {
          ok: false,
          error: { message: "已有备份或恢复操作正在进行。" },
        };
      busy = true;
      let finish!: () => void;
      pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        const request = parsed.data;
        if (request.action === "prepare") {
          const selected = await dialog.showOpenDialog(options.window, {
            title: "选择 DevHub 备份",
            properties: ["openFile"],
            filters: [{ name: "DevHub 备份", extensions: ["devhub-backup"] }],
          });
          if (selected.canceled || !selected.filePaths[0])
            return { ok: true, data: {} };
          if (prepared) {
            await options.store.discard(prepared);
            prepared = undefined;
          }
          prepared = await options.store.prepare(selected.filePaths[0]);
          expires = Date.now() + 30 * 60_000;
          return { ok: true, data: { preview: prepared.preview } };
        }
        if (request.action === "export") {
          const selected = await dialog.showSaveDialog(options.window, {
            title: "导出 DevHub 备份",
            defaultPath: `DevHub-${new Date().toISOString().slice(0, 10)}.devhub-backup`,
            filters: [{ name: "DevHub 备份", extensions: ["devhub-backup"] }],
          });
          if (selected.canceled || !selected.filePath)
            return { ok: true, data: {} };
          const path = selected.filePath;
          await maintenance.exclusive(async () => {
            if (options.creationActive())
              throw new BackupError(
                "项目创建正在进行，请等待任务结束后再备份。",
              );
            const db = options.database(),
              env = options.environment();
            if (!db || !env)
              throw new BackupError("数据服务不可用，无法生成一致性备份。");
            await options.store.export(
              db,
              await env.snapshot(),
              path,
              options.appVersion,
            );
          });
          return {
            ok: true,
            data: {
              path,
              message:
                "备份已保存，包含元数据和普通环境配置，不包含源码或密钥值。",
            },
          };
        }
        if (
          !prepared ||
          prepared.preview.token !== request.token ||
          expires < Date.now()
        )
          throw new BackupError("备份预览已失效，请重新选择文件。");
        const answer = await dialog.showMessageBox(options.window, {
          type: "warning",
          title: "恢复 DevHub 数据",
          message: "确认用此备份覆盖当前元数据和普通环境配置？",
          detail: `模板 ${prepared.preview.templates} 个，项目 ${prepared.preview.projects} 个。\n将停止活动预览，并在恢复后重启 DevHub。\n当前数据会先备份到 ~/.devhub/backups。源码目录保持原样，密钥仅在已有引用匹配时可用。`,
          buttons: ["取消", "恢复并重启"],
          defaultId: 0,
          cancelId: 0,
        });
        if (answer.response !== 1)
          return { ok: true, data: { message: "恢复已取消。" } };
        let closed = false;
        try {
          const path = await maintenance.exclusive(async () => {
            if (options.creationActive())
              throw new BackupError("项目创建正在进行，请等待任务结束后恢复。");
            const db = options.database(),
              env = options.environment();
            if (!db || !env) throw new BackupError("数据服务不可用。");
            return options.store.restore(
              prepared!,
              db,
              await env.snapshot(),
              async () => {
                await options.close();
                closed = true;
              },
            );
          });
          setTimeout(options.restart, 400);
          return {
            ok: true,
            data: {
              path,
              restarting: true,
              message: "恢复完成，正在重启。当前数据的回退备份已保留。",
            },
          };
        } catch (error) {
          if (closed) setTimeout(options.restart, 1500);
          throw error;
        }
      } catch (error) {
        return {
          ok: false,
          error: {
            message:
              error instanceof BackupError
                ? error.message
                : "备份或恢复失败，请检查文件和数据目录权限。",
          },
        };
      } finally {
        busy = false;
        finish();
      }
    },
  );
  return async () => {
    await pending;
    if (prepared) await options.store.discard(prepared).catch(() => {});
  };
}
