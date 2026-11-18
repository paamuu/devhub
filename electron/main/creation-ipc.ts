import { type BrowserWindow, type IpcMainInvokeEvent, dialog } from "electron";
import { creationChannel } from "../../shared/channels";
import { creationRequest, type CreationResult } from "../../shared/creation";
import { DirectoryError } from "./directory-store";
import type { ProjectCreation } from "./project-creation";
import { handleIpc } from "./ipc-router";

export function registerCreationHandler(
  window: BrowserWindow,
  trusted: (event: IpcMainInvokeEvent) => boolean,
  service: ProjectCreation | undefined,
  isDirectoryMutation: () => boolean,
) {
  let selecting = false;
  handleIpc(
    creationChannel,
    async (event, input: unknown): Promise<CreationResult> => {
      if (!trusted(event) || !service)
        return { ok: false, error: { message: "无法访问创建服务。" } };
      const parsed = creationRequest.safeParse(input);
      if (!parsed.success)
        return { ok: false, error: { message: "请检查项目名称和模板。" } };
      const request = parsed.data;
      try {
        if (
          ["start", "resume"].includes(request.action) &&
          isDirectoryMutation()
        )
          throw new DirectoryError("目录回收正在进行，请完成后重试。");
        switch (request.action) {
          case "start": {
            if (selecting) throw new DirectoryError("创建确认窗口已经打开。");
            selecting = true;
            try {
              const result = await dialog.showOpenDialog(window, {
                title: "选择新项目的父目录",
                properties: ["openDirectory"],
              });
              if (result.canceled || !result.filePaths[0]) break;
              const payload = await service.prepare(
                request.templateId,
                request.name,
                result.filePaths[0],
                request.initializeGit,
              );
              const confirmation = await dialog.showMessageBox(window, {
                type: "question",
                title: "从模板创建项目",
                message: `创建 ${request.name}`,
                detail: `模板目录\n${payload.source}\n\n最终目录\n${payload.target}\n\n${request.initializeGit ? "初始化新的 Git 仓库" : "不初始化 Git"}\n\n排除 .git、node_modules、dist、build、coverage、.cache、.turbo、.env 和 .env.*。保留 .env.example、.env.sample、.env.template。跳过符号链接及 junction。`,
                buttons: ["取消", "创建"],
                defaultId: 0,
                cancelId: 0,
              });
              if (confirmation.response === 1) {
                if (isDirectoryMutation())
                  throw new DirectoryError("目录回收正在进行，请重新创建。");
                service.start(payload);
              }
            } finally {
              selecting = false;
            }
            break;
          }
          case "cancel":
            service.cancel(request.id);
            break;
          case "resume":
            await service.resume(request.id);
            break;
          case "list":
            break;
        }
        return { ok: true, data: service.list() };
      } catch (error) {
        return {
          ok: false,
          error: {
            message:
              error instanceof DirectoryError
                ? error.message
                : "创建操作失败，请刷新后检查任务状态。",
          },
        };
      }
    },
  );
}
