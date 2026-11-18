import {
  dialog,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { gitChannel } from "../../shared/channels";
import { gitRequest, type GitResult } from "../../shared/git";
import { GitService, type GitConfirmation } from "./git-service";
import { GitServiceError } from "./git-runner";
import { DirectoryError } from "./directory-store";
import { handleIpc } from "./ipc-router";

export function gitDialogs(window: BrowserWindow) {
  return {
    confirm: async (plan: GitConfirmation) => {
      const action = { add: "添加", update: "修改", remove: "删除" }[
        plan.action
      ];
      const result = await dialog.showMessageBox(window, {
        type: "warning",
        title: `${action} Git Remote`,
        message: `确认${action} Remote「${plan.name}」？`,
        detail: `工作树：${plan.root}\n${plan.target === "push" ? "Push URL" : "Fetch URL"}：${plan.before.join("\n") || "未配置"}${plan.url ? `\n新地址：${plan.url}` : ""}\n\n${plan.action === "remove" ? "将删除本地 Remote 配置及其远程跟踪引用，不会删除远端仓库。" : "仅修改本地 Remote 配置，不发起 Fetch、Pull 或 Push。"}${plan.action === "update" ? "\n修改第一个地址，保留其他地址。" : ""}`,
        buttons: ["取消", `确认${action}`],
        defaultId: 0,
        cancelId: 0,
      });
      return result.response === 1;
    },
    openBrowser: (url: string) => shell.openExternal(url),
  };
}
export function registerGitHandler(
  trusted: (event: IpcMainInvokeEvent) => boolean,
  service?: GitService,
) {
  handleIpc(gitChannel, async (event, input: unknown): Promise<GitResult> => {
    if (!trusted(event))
      return {
        ok: false,
        error: { code: "PERMISSION_DENIED", message: "请求来源无效。" },
      };
    const parsed = gitRequest.safeParse(input);
    if (!parsed.success)
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "请检查 Remote 名称、地址，或刷新仓库后重试。",
        },
      };
    if (!service)
      return {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Git 服务不可用，请检查数据库。",
        },
      };
    try {
      return { ok: true, data: await service.execute(parsed.data) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof GitServiceError ? error.code : "GIT_FAILED",
          message:
            error instanceof GitServiceError || error instanceof DirectoryError
              ? error.message
              : "Git 操作失败，请刷新后重试。",
        },
      };
    }
  });
}
