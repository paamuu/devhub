import type { DatabaseSync } from "node:sqlite";
import crossSpawn from "cross-spawn";
import { DirectoryStore, resolveDirectory } from "./directory-store.ts";
import { EnvironmentStore } from "./environment-store.ts";
import { ProcessManager } from "./process-manager.ts";
import {
  prepareWebCommand,
  PreviewError,
  type LaunchPlan,
} from "./web-command-adapter.ts";
import {
  ideConfigSchema,
  type RuntimeData,
  type RuntimeRequest,
  type IdeConfig,
} from "../../shared/runtime.ts";

export async function launchIde(config: IdeConfig, path: string) {
  const child = crossSpawn(config.command, [...config.args, path], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", () =>
      reject(new PreviewError("IDE 启动失败，请检查可执行文件和参数。")),
    );
    // Command shims can spawn cmd.exe successfully but fail to find the IDE.
    const timer = setTimeout(() => {
      child.unref();
      resolve();
    }, 400);
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new PreviewError("IDE 已异常退出，请检查配置。"));
    });
  });
}
interface Options {
  database: DatabaseSync;
  store: DirectoryStore;
  environment: EnvironmentStore;
  manager: ProcessManager;
  confirm(plan: LaunchPlan, restart: boolean): Promise<boolean>;
  openBrowser(url: string): Promise<void>;
  selectIde(): Promise<string | null>;
  openIde?: typeof launchIde;
  directoryBusy(): boolean;
}
export class RuntimeService {
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
  }
  private ide(projectId?: string): {
    ide: IdeConfig | null;
    inherited: boolean;
  } {
    const read = (key: string) => {
      const row = this.options.database
        .prepare("SELECT value_json FROM app_settings WHERE key = ?")
        .get(key);
      if (!row) return null;
      try {
        return ideConfigSchema.parse(JSON.parse(String(row.value_json)));
      } catch {
        throw new PreviewError("IDE 配置无法读取，请重新保存。");
      }
    };
    const projectConfig = projectId
      ? this.options.database
          .prepare("SELECT ide_config_json FROM projects WHERE id = ?")
          .get(projectId)?.ide_config_json
      : null;
    const override = projectConfig
      ? ideConfigSchema.parse(JSON.parse(String(projectConfig)))
      : null;
    return {
      ide: override ?? read("ide.default"),
      inherited: Boolean(projectId && !override),
    };
  }
  private saveIde(projectId: string | undefined, config: IdeConfig | null) {
    if (projectId) {
      this.options.database
        .prepare("UPDATE projects SET ide_config_json = ? WHERE id = ?")
        .run(config ? JSON.stringify(config) : null, projectId);
      return this.ide(projectId);
    }
    const key = "ide.default";
    if (config)
      this.options.database
        .prepare(
          "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
        )
        .run(key, JSON.stringify(config), new Date().toISOString());
    else
      this.options.database
        .prepare("DELETE FROM app_settings WHERE key = ?")
        .run(key);
    return this.ide(projectId);
  }
  async removeProject(_id: string) {
    await this.options.environment.prune(
      this.options.database
        .prepare("SELECT id FROM projects")
        .all()
        .map((row) => String(row.id)),
    );
  }
  async execute(request: RuntimeRequest): Promise<RuntimeData> {
    const { manager } = this.options;
    if (request.action === "sessions")
      return { sessions: manager.list().filter((item) => item.active) };
    if (request.action === "select-ide")
      return { executable: await this.options.selectIde() };
    if (!request.projectId) {
      if (request.action === "ide-config") return this.ide();
      if (request.action === "save-ide")
        return this.saveIde(undefined, request.config);
      throw new PreviewError("缺少项目标识。");
    }
    const projectId = request.projectId;
    this.options.store.require("project", projectId);
    if (request.action === "status") return { session: manager.get(projectId) };
    // Serialize changes, native consent and launches for each project.
    return manager.exclusive(projectId, async () => {
      const { store, environment } = this.options;
      store.require("project", projectId);
      switch (request.action) {
        case "environment":
          return { environment: await environment.view(projectId) };
        case "save-environment":
          await environment.save(projectId, request.values);
          return { environment: await environment.view(projectId) };
        case "set-secret":
          await environment.setSecret(projectId, request.name, request.value);
          return { environment: await environment.view(projectId) };
        case "remove-secret":
          await environment.removeSecret(projectId, request.name);
          return { environment: await environment.view(projectId) };
        case "ide-config":
          return this.ide(projectId);
        case "save-ide":
          return this.saveIde(projectId, request.config);
        case "open-ide": {
          const config = this.ide(projectId).ide;
          if (!config)
            throw new PreviewError("请先在 Settings 或项目设置中配置 IDE。");
          const current = store.require("project", projectId);
          const actual = await resolveDirectory(current.path);
          if (actual.key !== current.key)
            throw new PreviewError("项目目录已改变，请重新关联。");
          await (this.options.openIde ?? launchIde)(config, actual.path);
          store.markOpened("project", projectId);
          return {};
        }
        case "stop":
          return { session: await manager.stop(projectId) };
        case "start":
        case "restart": {
          if (this.options.directoryBusy())
            throw new PreviewError("正在回收目录，请稍后重试。");
          if (request.action === "start" && manager.active(projectId))
            throw new PreviewError("该项目已有运行中的预览。");
          const prepare = async () => {
            const current = store.require("project", projectId);
            const actual = await resolveDirectory(current.path);
            if (current.key !== actual.key)
              throw new PreviewError("项目目录已改变，请重新关联。");
            const row = this.options.database
              .prepare("SELECT preview_config_json FROM projects WHERE id = ?")
              .get(projectId);
            return prepareWebCommand(
              actual.path,
              JSON.parse(String(row?.preview_config_json ?? "null")),
            );
          };
          const plan = await prepare();
          if (!(await this.options.confirm(plan, request.action === "restart")))
            return { session: manager.get(projectId) };
          if (this.options.directoryBusy())
            throw new PreviewError("正在回收目录，请稍后重试。");
          const currentPlan = await prepare();
          if (JSON.stringify(currentPlan) !== JSON.stringify(plan))
            throw new PreviewError("预览配置已改变，请重新启动并确认。");
          const env = await environment.resolve(projectId);
          if (request.action === "restart") await manager.stop(projectId);
          const session = await manager.start(
            projectId,
            plan,
            env.values,
            env.sensitive,
          );
          store.markOpened("project", projectId);
          return { session };
        }
        case "browser": {
          const row = this.options.database
            .prepare("SELECT preview_config_json FROM projects WHERE id = ?")
            .get(projectId);
          const config = JSON.parse(String(row?.preview_config_json ?? "null"));
          let url: URL;
          try {
            url = new URL(config?.previewUrl);
          } catch {
            throw new PreviewError("请先配置预览地址。");
          }
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw new PreviewError("预览地址仅支持不含凭据的 HTTP / HTTPS。");
          await this.options.openBrowser(url.href);
          return {};
        }
      }
      return {};
    });
  }
}
