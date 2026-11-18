import type { ReactiveController, ReactiveControllerHost } from "lit";
import type {
  PreviewSession,
  RuntimeRequest,
  RuntimeData,
} from "../shared/runtime";

export async function runtimeCall(
  request: RuntimeRequest,
): Promise<RuntimeData> {
  const result = await window.devhub?.runtime(request);
  if (!result?.ok)
    throw new Error(
      result && !result.ok ? result.error.message : "运行服务不可用。",
    );
  return result.data;
}
export class RuntimeController implements ReactiveController {
  private readonly host: ReactiveControllerHost;
  private readonly project: () => string | undefined;
  private unsubscribe?: () => void;
  private generation = 0;
  sessions = new Map<string, PreviewSession>();
  error = "";
  constructor(
    host: ReactiveControllerHost,
    project: () => string | undefined = () => undefined,
  ) {
    this.host = host;
    this.project = project;
    host.addController(this);
  }
  accept(session: PreviewSession) {
    if (this.project() && this.project() !== session.projectId) return;
    if (
      (this.sessions.get(session.projectId)?.revision ?? -1) > session.revision
    )
      return;
    this.sessions.set(session.projectId, session);
    this.host.requestUpdate();
  }
  hostConnected() {
    const generation = ++this.generation;
    this.unsubscribe = window.devhub?.onPreview((session) =>
      this.accept(session),
    );
    // Lit properties supplied by a parent are set before the first microtask.
    void Promise.resolve()
      .then(async () => {
        const id = this.project();
        const data = await runtimeCall(
          id ? { action: "status", projectId: id } : { action: "sessions" },
        );
        if (generation !== this.generation) return;
        if (data.session) this.accept(data.session);
        for (const session of data.sessions ?? []) this.accept(session);
      })
      .catch((error: Error) => {
        if (generation === this.generation) {
          this.error = error.message;
          this.host.requestUpdate();
        }
      });
  }
  hostDisconnected() {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
export function sessionLabel(session: PreviewSession) {
  if (session.state === "stopped") return "已停止";
  if (session.state === "failed") return "运行失败";
  if (session.state === "stopping") return "停止中";
  if (session.state === "starting") return "启动中";
  return session.ready === "ready"
    ? "服务已就绪"
    : session.ready === "checking"
      ? "检测中"
      : "进程已启动";
}
