import {
  dialog,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { runtimeChannel } from "../../shared/channels";
import { runtimeRequest, type RuntimeResult } from "../../shared/runtime";
import { RuntimeService } from "./runtime-service";
import { PreviewError } from "./web-command-adapter";
import { DirectoryError } from "./directory-store";
import { EnvironmentError } from "./environment-store";
import { handleIpc } from "./ipc-router";

export function runtimeDialogs(window: BrowserWindow) {
  return {
    confirm: async (
      plan: { command: string; args: string[]; cwd: string },
      restart: boolean,
    ) => {
      const result = await dialog.showMessageBox(window, {
        type: "warning",
        title: restart ? "重启项目预览" : "启动项目预览",
        message: "此操作会在本机执行项目命令。",
        detail: `可执行文件：${plan.command}\n参数：${JSON.stringify(plan.args)}\n工作目录：${plan.cwd}\n\n请确认你信任此项目及其脚本。`,
        buttons: ["取消", restart ? "停止并重启" : "执行命令"],
        defaultId: 0,
        cancelId: 0,
      });
      return result.response === 1;
    },
    openBrowser: (url: string) => shell.openExternal(url),
    selectIde: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: "选择 IDE 可执行文件",
        properties: ["openFile"],
        filters: [{ name: "可执行文件", extensions: ["exe", "cmd", "bat"] }],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  };
}
export function registerRuntimeHandler(
  trusted: (event: IpcMainInvokeEvent) => boolean,
  service?: RuntimeService,
) {
  handleIpc(
    runtimeChannel,
    async (event, input: unknown): Promise<RuntimeResult> => {
      if (!trusted(event))
        return { ok: false, error: { message: "请求来源无效。" } };
      const request = runtimeRequest.safeParse(input);
      if (!request.success)
        return {
          ok: false,
          error: { message: "运行配置格式无效，请检查输入。" },
        };
      if (!service)
        return {
          ok: false,
          error: { message: "运行服务不可用，请检查本地数据权限。" },
        };
      try {
        return { ok: true, data: await service.execute(request.data) };
      } catch (error) {
        return {
          ok: false,
          error: {
            message:
              error instanceof PreviewError ||
              error instanceof DirectoryError ||
              error instanceof EnvironmentError
                ? error.message
                : "操作失败，请检查环境配置、系统密钥保护和目录权限。",
          },
        };
      }
    },
  );
}
