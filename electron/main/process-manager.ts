import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type { PreviewLog, PreviewSession } from "../../shared/runtime.ts";
import { PreviewJournal, SecretRedactor } from "./preview-log.ts";
import {
  assertPortsAvailable,
  PreviewError,
  waitUntilReady,
  type LaunchPlan,
} from "./web-command-adapter.ts";

interface Running {
  view: PreviewSession;
  plan: LaunchPlan;
  child: ChildProcessWithoutNullStreams;
  abort: AbortController;
  closed: Promise<void>;
  failure?: string;
  timer?: NodeJS.Timeout;
}
interface ManagerOptions {
  host: string;
  launcher: string;
  executable: string;
  journal: PreviewJournal;
  notify?: (session: PreviewSession) => void;
}
export class ProcessManager {
  private readonly sessions = new Map<string, Running>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private closing = false;
  private revision = 0;
  private readonly options: ManagerOptions;
  constructor(options: ManagerOptions) {
    this.options = options;
  }
  busy(id: string) {
    return this.queues.has(id) || this.active(id);
  }
  active(id: string) {
    return this.sessions.get(id)?.view.active ?? false;
  }
  get(id: string) {
    const view = this.sessions.get(id)?.view;
    return view ? structuredClone(view) : null;
  }
  list() {
    return [...this.sessions.keys()].map((id) => this.get(id)!);
  }
  exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new PreviewError("DevHub 正在退出。"));
    const task = (this.queues.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    this.queues.set(id, task);
    void task
      .finally(() => {
        if (this.queues.get(id) === task) this.queues.delete(id);
      })
      .catch(() => {});
    return task;
  }
  private publish(session: Running, immediate = false) {
    session.view.revision = ++this.revision;
    if (immediate) {
      clearTimeout(session.timer);
      session.timer = undefined;
      this.options.notify?.(structuredClone(session.view));
    } else if (!session.timer)
      session.timer = setTimeout(() => {
        session.timer = undefined;
        this.options.notify?.(structuredClone(session.view));
      }, 100);
  }
  async start(
    id: string,
    plan: LaunchPlan,
    variables: Record<string, string>,
    sensitive: string[],
  ) {
    if (this.closing) throw new PreviewError("DevHub 正在退出。");
    if (this.active(id))
      throw new PreviewError("该项目已有运行中的预览，请先停止或使用重启。");
    if (process.platform !== "win32")
      throw new PreviewError("当前版本仅支持 Windows 预览进程管理。");
    await assertPortsAvailable(plan.config);
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Windows environment names are case-insensitive. Avoid duplicate PATH/Path.
    for (const [name, value] of Object.entries(variables)) {
      for (const key of Object.keys(env))
        if (key.toUpperCase() === name.toUpperCase()) delete env[key];
      env[name] = value;
    }
    for (const key of Object.keys(env))
      if (
        key.toUpperCase().startsWith("DEVHUB_") ||
        key.toUpperCase() === "ELECTRON_RUN_AS_NODE"
      )
        delete env[key];
    env.ELECTRON_RUN_AS_NODE = "1";
    env.DEVHUB_LAUNCH_SPEC = JSON.stringify({
      command: plan.command,
      args: plan.args,
      cwd: plan.cwd,
    });
    const child = spawn(
      this.options.host,
      [this.options.executable, this.options.launcher],
      { cwd: plan.cwd, env, windowsHide: true, stdio: "pipe" },
    );
    let closed!: () => void;
    const session: Running = {
      child,
      plan,
      abort: new AbortController(),
      closed: new Promise<void>((resolve) => {
        closed = resolve;
      }),
      view: {
        id: randomUUID(),
        projectId: id,
        revision: 0,
        state: "starting",
        ready: plan.config.readyCheck ? "checking" : "unconfigured",
        active: true,
        message: "正在启动预览…",
        exitCode: null,
        startedAt: new Date().toISOString(),
        logs: [],
      },
    };
    this.sessions.set(id, session);
    // Retain at most 20 finished sessions; active previews are never discarded.
    const finished = [...this.sessions].filter(
      ([, value]) => !value.view.active,
    );
    for (const [key] of finished.slice(0, Math.max(0, finished.length - 20)))
      this.sessions.delete(key);
    let sequence = 0;
    const log = (stream: PreviewLog["stream"], text: string) => {
      for (let offset = 0; offset < text.length; offset += 4096) {
        const entry: PreviewLog = {
          sequence: ++sequence,
          time: new Date().toISOString(),
          stream,
          text: text.slice(offset, offset + 4096),
        };
        session.view.logs.push(entry);
        this.options.journal.record(id, session.view.id, entry);
      }
      if (session.view.logs.length > 500)
        session.view.logs.splice(0, session.view.logs.length - 500);
      if (this.options.journal.failed)
        session.view.message = "日志文件写入受限，界面继续保留最近日志。";
      this.publish(session);
    };
    for (const stream of ["stdout", "stderr"] as const) {
      const decoder = new StringDecoder("utf8");
      const redactor = new SecretRedactor(sensitive);
      child[stream].on("data", (buffer: Buffer) =>
        log(stream, redactor.push(decoder.write(buffer))),
      );
      child[stream].once("end", () =>
        log(stream, redactor.push(decoder.end(), true)),
      );
    }
    child.stdin.on("error", () => {});
    child.once("error", () => {
      session.failure = "预览宿主启动失败，请检查程序文件和目录权限。";
    });
    child.once("spawn", () => {
      if (session.view.state !== "starting") return;
      session.view.state = "running";
      session.view.message = plan.config.readyCheck
        ? "进程已启动，正在检查服务…"
        : "进程已启动（未配置就绪检测）";
      this.publish(session, true);
      if (plan.config.readyCheck)
        void waitUntilReady(plan.config.readyCheck, session.abort.signal)
          .then(async (ready) => {
            if (session.abort.signal.aborted || !session.view.active) return;
            session.view.ready = ready ? "ready" : "failed";
            if (ready) {
              session.view.message = "服务已就绪。";
              this.publish(session, true);
            } else {
              session.failure = "服务就绪检测超时，已停止本次预览。";
              await this.stop(id);
            }
          })
          .catch(() => {});
    });
    child.once("close", (code) => {
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      const stopped = session.view.state === "stopping" && !session.failure;
      session.abort.abort();
      session.view.active = false;
      session.view.exitCode = code;
      session.view.state = stopped ? "stopped" : "failed";
      if (!stopped && session.view.ready !== "unconfigured")
        session.view.ready = "failed";
      session.view.message =
        session.failure ??
        (stopped
          ? "预览已停止。"
          : `预览进程已退出（${code ?? "未知状态"}）。请查看日志。`);
      log("system", session.view.message);
      this.publish(session, true);
      closed();
    });
    this.publish(session, true);
    return this.get(id)!;
  }
  async stop(id: string) {
    const session = this.sessions.get(id);
    if (!session?.view.active) return this.get(id);
    session.view.state = "stopping";
    session.view.message = "正在停止预览及其子进程…";
    session.abort.abort();
    this.publish(session, true);
    session.child.stdin.end();
    await Promise.race([
      session.closed,
      delay(4000, undefined, { ref: false }),
    ]);
    if (session.view.active) {
      session.child.kill();
      await Promise.race([
        session.closed,
        delay(3000, undefined, { ref: false }),
      ]);
    }
    if (session.view.active) {
      session.view.state = "failed";
      session.view.message = "预览宿主尚未退出，请重试停止操作。";
      this.publish(session, true);
      throw new PreviewError(session.view.message);
    }
    await this.options.journal.flush();
    return this.get(id);
  }
  async shutdown() {
    this.closing = true;
    await Promise.allSettled([...this.queues.values()]);
    await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.stop(id)),
    );
    await this.options.journal.flush();
  }
}
