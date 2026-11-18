import { LitElement, css, html } from "lit";
import type { DirectoryEntry } from "../shared/contracts";
import type {
  EnvironmentView,
  RuntimeRequest,
  PreviewLog,
} from "../shared/runtime";
import { plainEnvironment } from "../shared/runtime";
import {
  RuntimeController,
  runtimeCall,
  sessionLabel,
} from "./runtime-controller";
import { runtimeStyles } from "./runtime-styles";
import "./ide-settings";

class PreviewPanel extends LitElement {
  static properties = {
    entry: { attribute: false },
    busy: { state: true },
    error: { state: true },
    environment: { state: true },
    paused: { state: true },
  };
  declare entry: DirectoryEntry;
  declare private busy: boolean;
  declare private error: string;
  declare private environment: EnvironmentView | undefined;
  declare private paused: boolean;
  private frozen: PreviewLog[] = [];
  private readonly runtime = new RuntimeController(this, () => this.entry?.id);
  constructor() {
    super();
    this.busy = false;
    this.error = "";
    this.paused = false;
  }
  private async run(request: RuntimeRequest) {
    this.busy = true;
    this.error = "";
    try {
      const data = await runtimeCall(request);
      if (data.session) this.runtime.accept(data.session);
      if (data.environment) this.environment = data.environment;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "运行操作失败。";
    } finally {
      this.busy = false;
    }
  }
  private saveEnvironment(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    try {
      const values = plainEnvironment.parse(
        JSON.parse(String(new FormData(form).get("values"))),
      );
      void this.run({
        action: "save-environment",
        projectId: this.entry.id,
        values,
      });
    } catch {
      this.error = "普通变量必须是 JSON 对象，名称有效且值均为字符串。";
    }
  }
  protected updated() {
    if (!this.paused) {
      const log = this.renderRoot.querySelector(".logs");
      if (log) log.scrollTop = log.scrollHeight;
    }
  }
  protected render() {
    const projectId = this.entry.id;
    const session = this.runtime.sessions.get(projectId);
    const active = session?.active ?? false;
    const logs = this.paused ? this.frozen : (session?.logs ?? []);
    return html`<section aria-label="项目运行">
        <div class="actions">
          <h2>Preview</h2>
          <span class="badge" data-ready=${session?.ready === "ready" && active}
            >${session ? sessionLabel(session) : "未启动"}</span
          >
        </div>
        <p role="status">
          ${session?.message ?? "启动前会显示本次执行命令，请确认你信任项目脚本。"}
        </p>
        <div class="actions">
          <button
            class="primary"
            ?disabled=${this.busy || active || !this.entry.previewConfig || this.entry.availability !== "available"}
            @click=${() => this.run({ action: "start", projectId })}
          >
            启动预览
          </button>
          <button
            ?disabled=${this.busy || !active}
            @click=${() => this.run({ action: "stop", projectId })}
          >
            停止
          </button>
          <button
            ?disabled=${this.busy || !this.entry.previewConfig || this.entry.availability !== "available"}
            @click=${() => this.run({ action: "restart", projectId })}
          >
            重启
          </button>
          <button
            ?disabled=${this.busy || !this.entry.previewConfig?.previewUrl}
            @click=${() => this.run({ action: "browser", projectId })}
          >
            浏览器预览
          </button>
          <button
            ?disabled=${this.busy || this.entry.availability !== "available"}
            @click=${() => this.run({ action: "open-ide", projectId })}
          >
            在 IDE 打开
          </button>
        </div>
        ${!this.entry.previewConfig ? html`<p>请使用上方「编辑」填写预览命令与就绪检测。</p>` : null}
        ${this.error || this.runtime.error ? html`<p role="alert">${this.error || this.runtime.error}</p>` : null}
        <div class="log-heading">
          <strong>运行日志</strong
          ><button
            @click=${() => {
              this.paused = !this.paused;
              if (this.paused) this.frozen = [...(session?.logs ?? [])];
            }}
          >
            ${this.paused ? "恢复实时日志" : "暂停滚动"}</button
          ><small>最近 500 条 · 密钥脱敏</small>
        </div>
        <pre class="logs" tabindex="0" aria-label="预览日志">
${logs.length ? logs.map((entry) => html`<span class=${entry.stream}>${entry.text}</span>`) : "暂无日志。"}</pre>
        <details
          @toggle=${(event: Event) => {
            if ((event.target as HTMLDetailsElement).open && !this.environment)
              void this.run({ action: "environment", projectId });
          }}
        >
          <summary>环境变量与密钥</summary>
          <p>
            按项目保存于用户目录的 .devhub
            中，修改后在下次启动时生效。密钥仅显示配置状态。
          </p>
          ${
            this.environment
              ? html` <form @submit=${this.saveEnvironment}>
                    <label
                      >普通变量（JSON 对象）<textarea
                        name="values"
                        spellcheck="false"
                        .value=${JSON.stringify(this.environment.values, null, 2)}
                      ></textarea></label
                    ><button ?disabled=${this.busy}>保存普通变量</button>
                  </form>
                  <ul>
                    ${this.environment.secrets.map((secret) => html`<li><code>${secret.name}</code> · ${secret.configured ? "已配置" : "引用缺失"}<button ?disabled=${this.busy} @click=${() => this.run({ action: "remove-secret", projectId, name: secret.name })}>移除</button></li>`)}
                  </ul>
                  <form
                    @submit=${(event: SubmitEvent) => {
                      event.preventDefault();
                      const form = event.currentTarget as HTMLFormElement;
                      const fields = new FormData(form);
                      const name = String(fields.get("name"));
                      const value = String(fields.get("secret"));
                      (
                        form.elements.namedItem("secret") as HTMLInputElement
                      ).value = "";
                      void this.run({
                        action: "set-secret",
                        projectId,
                        name,
                        value,
                      });
                    }}
                  >
                    <label
                      >密钥变量名<input
                        name="name"
                        required
                        pattern="[A-Za-z_][A-Za-z0-9_]*"
                        maxlength="128"
                        autocomplete="off"
                    /></label>
                    <label
                      >密钥值<input
                        type="password"
                        name="secret"
                        required
                        maxlength="8192"
                        autocomplete="new-password"
                    /></label>
                    <button ?disabled=${this.busy}>保存 / 替换密钥</button>
                  </form>`
              : html`<p>正在读取环境配置…</p>`
          }
        </details>
      </section>
      <devhub-ide-settings .projectId=${projectId}></devhub-ide-settings>`;
  }
  static styles = [
    runtimeStyles,
    css`
      h2 {
        margin: 0;
      }
      .badge {
        background: #e9eef2;
        padding: 0.2rem 0.5rem;
        border-radius: 3px;
        font-size: 0.82rem;
      }
      .badge[data-ready] {
        background: #d9eee4;
        color: #245c43;
      }
      .log-heading {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.7rem;
        margin: 1.2rem 0 0.4rem;
      }
      .logs {
        box-sizing: border-box;
        height: 15rem;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        padding: 0.8rem;
        background: #182630;
        color: #d5e1e7;
        border-radius: 4px;
        font:
          0.8rem/1.5 ui-monospace,
          Consolas,
          monospace;
      }
      .stderr {
        color: #f2bd94;
      }
      .system {
        color: #8ecbd1;
      }
      li {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: center;
        margin: 0.4rem 0;
      }
      ul {
        padding: 0;
        list-style: none;
      }
    `,
  ];
}
customElements.define("devhub-preview-panel", PreviewPanel);
