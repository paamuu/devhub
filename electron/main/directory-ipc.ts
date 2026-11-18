import { randomUUID } from "node:crypto";
import {
  type BrowserWindow,
  type IpcMainInvokeEvent,
  dialog,
  shell,
} from "electron";
import { basename } from "node:path";
import { handleIpc } from "./ipc-router";
import { detectDirectory } from "./directory-detection";
import { recycleDirectory } from "./directory-trash";
import { directoryChannel } from "../../shared/channels";
import { type DirectoryResult, directoryRequest } from "../../shared/contracts";
import {
  DirectoryError,
  DirectoryStore,
  resolveDirectory,
} from "./directory-store";

export function registerDirectoryHandler(
  window: BrowserWindow,
  trusted: (event: IpcMainInvokeEvent) => boolean,
  store: DirectoryStore | undefined,
  protectedPaths: string[],
  hasCreation: () => boolean,
  previewBusy: (id: string) => boolean = () => false,
  removed: (id: string) => Promise<void> = async () => {},
) {
  let selection:
    { token: string; path: string; key: string; expires: number } | undefined;
  let selecting = false;
  let trashing = false;

  handleIpc(
    directoryChannel,
    async (event, input: unknown): Promise<DirectoryResult> => {
      if (!trusted(event))
        return { ok: false, error: { message: "请求来源无效。" } };
      const parsed = directoryRequest.safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          error: { message: "请检查登记资料或刷新页面后重试。" },
        };
      if (!store) return { ok: false, error: { message: "数据库不可用。" } };
      const request = parsed.data;
      try {
        const ensurePreviewIdle = () => {
          if (
            ["trash", "remove", "relink"].includes(request.action) &&
            "id" in request &&
            previewBusy(request.id)
          )
            throw new DirectoryError(
              "预览、Git 或运行配置操作正在使用此项目，请先停止预览并等待操作结束。",
            );
        };
        ensurePreviewIdle();
        if (trashing && request.action !== "list")
          throw new DirectoryError("正在处理目录回收，请完成后重试。");
        if (
          ["trash", "remove", "relink"].includes(request.action) &&
          hasCreation()
        )
          throw new DirectoryError(
            "项目创建或恢复正在使用目录，请等待任务结束后再操作。",
          );
        switch (request.action) {
          case "select": {
            if (selecting) throw new DirectoryError("目录选择窗口已经打开。");
            selecting = true;
            try {
              const result = await dialog.showOpenDialog(window, {
                properties: ["openDirectory"],
              });
              const selected = result.filePaths[0];
              if (result.canceled || !selected) return { ok: true, data: null };
              const directory = await resolveDirectory(selected);
              selection = {
                ...directory,
                token: randomUUID(),
                expires: Date.now() + 10 * 60_000,
              };
              return {
                ok: true,
                data: {
                  selection: selection.token,
                  path: directory.path,
                  name: basename(directory.path) || directory.path,
                  suggested: await detectDirectory(directory.path),
                },
              };
            } finally {
              selecting = false;
            }
          }
          case "list":
            return { ok: true, data: await store.list(request.kind) };
          case "add":
          case "relink": {
            const selected = selection;
            if (
              selected?.token !== request.selection ||
              selected.expires < Date.now()
            ) {
              throw new DirectoryError("目录选择已失效，请重新选择。");
            }
            const directory = await resolveDirectory(selected.path);
            if (selection !== selected || directory.key !== selected.key) {
              throw new DirectoryError("目录已发生变化，请重新选择。");
            }
            ensurePreviewIdle();
            if (request.action === "add")
              store.add(request.kind, directory, request.fields);
            else store.relink(request.kind, request.id, directory);
            selection = undefined;
            break;
          }
          case "edit":
            store.edit(request.kind, request.id, request.fields);
            break;
          case "archive":
            store.archive(request.id, request.archived);
            break;
          case "remove":
            store.remove(request.kind, request.id);
            if (request.kind === "project") {
              try {
                await removed(request.id);
              } catch {
                throw new DirectoryError(
                  "登记记录已移除，环境配置清理失败，将在下次启动时重试。请刷新列表。",
                );
              }
            }
            break;
          case "open": {
            const current = store.require(request.kind, request.id);
            const actual = await resolveDirectory(current.path);
            if (current.key !== actual.key)
              throw new DirectoryError("目录已发生变化，请重新关联。");
            const error = await shell.openPath(actual.path);
            if (error) throw new DirectoryError("无法打开目录。");
            store.markOpened(request.kind, request.id);
            break;
          }
          case "detail":
            store.require(request.kind, request.id);
            store.markOpened(request.kind, request.id);
            return {
              ok: true,
              data: (await store.list(request.kind)).filter(
                (entry) => entry.id === request.id,
              ),
            };
          case "trash": {
            trashing = true;
            try {
              await recycleDirectory({
                store,
                kind: request.kind,
                id: request.id,
                protectedPaths,
                confirm: async (path) => {
                  const response = await dialog.showMessageBox(window, {
                    type: "warning",
                    title: "将目录移入回收站",
                    message: "确认回收这个本地目录？",
                    detail: `${path}\n\n登记记录将保留，目录状态将显示为失效。`,
                    buttons: ["取消", "移入回收站"],
                    defaultId: 0,
                    cancelId: 0,
                  });
                  return response.response === 1;
                },
                trash: (path) => shell.trashItem(path),
              });
            } finally {
              trashing = false;
            }
            break;
          }
        }
        return { ok: true, data: null };
      } catch (error) {
        if (error instanceof DirectoryError)
          return { ok: false, error: { message: error.message } };
        console.error("DevHub directory operation failed", error);
        return { ok: false, error: { message: "目录操作失败，请重试。" } };
      }
    },
  );
  return () => trashing;
}
