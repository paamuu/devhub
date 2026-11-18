import { LitElement, html } from "lit";
import { runtimeCall } from "./runtime-controller";
import { runtimeStyles } from "./runtime-styles";
import { ideConfigSchema, type IdeConfig } from "../shared/runtime";

class IdeSettings extends LitElement {
  static properties = {
    projectId: {},
    config: { state: true },
    inherited: { state: true },
    busy: { state: true },
    message: { state: true },
  };
  declare projectId?: string;
  declare private config: IdeConfig | null;
  declare private inherited: boolean;
  declare private busy: boolean;
  declare private message: string;
  constructor() {
    super();
    this.config = null;
    this.inherited = false;
    this.busy = false;
    this.message = "";
  }
  protected firstUpdated() {
    void this.perform(async () => {
      const data = await runtimeCall({
        action: "ide-config",
        projectId: this.projectId,
      });
      this.config = data.ide ?? null;
      this.inherited = data.inherited ?? false;
    });
  }
  private async perform(work: () => Promise<void>) {
    this.busy = true;
    this.message = "";
    try {
      await work();
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : "IDE 配置操作失败。";
    } finally {
      this.busy = false;
    }
  }
  private async save(config: IdeConfig | null) {
    const data = await runtimeCall({
      action: "save-ide",
      projectId: this.projectId,
      config,
    });
    this.config = data.ide ?? null;
    this.inherited = data.inherited ?? false;
    this.message = "IDE 配置已保存。";
  }
  protected render() {
    return html`<section>
      <details ?open=${!this.projectId}>
        <summary>${this.projectId ? "项目 IDE 设置" : "默认 IDE"}</summary>
        <p>
          ${this.inherited ? "当前使用全局设置。" : "项目路径会作为最后一个独立参数传入 IDE。"}
        </p>
        <form
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            const form = event.currentTarget as HTMLFormElement;
            void this.perform(async () => {
              const fields = new FormData(form);
              let args: unknown;
              try {
                args = JSON.parse(String(fields.get("args")));
              } catch {
                throw new Error(
                  '参数必须是 JSON 字符串数组，例如 ["--new-window"]。',
                );
              }
              const parsed = ideConfigSchema.safeParse({
                command: fields.get("command"),
                args,
              });
              if (!parsed.success)
                throw new Error("请填写可执行文件和有效参数数组。");
              await this.save(parsed.data);
            });
          }}
        >
          <label
            >可执行文件或命令<input
              name="command"
              required
              .value=${this.config?.command ?? ""}
              placeholder="Code.exe / code.cmd"
          /></label>
          <button
            type="button"
            ?disabled=${this.busy}
            @click=${() =>
              this.perform(async () => {
                const data = await runtimeCall({ action: "select-ide" });
                if (data.executable)
                  (
                    this.renderRoot.querySelector(
                      '[name="command"]',
                    ) as HTMLInputElement
                  ).value = data.executable;
              })}
          >
            选择可执行文件
          </button>
          <label
            >参数（JSON 数组）<input
              name="args"
              required
              .value=${JSON.stringify(this.config?.args ?? [])}
          /></label>
          <div class="actions">
            <button class="primary" ?disabled=${this.busy}>保存 IDE</button
            ><button
              type="button"
              ?disabled=${this.busy}
              @click=${() => this.perform(() => this.save(null))}
            >
              ${this.projectId ? "恢复全局设置" : "清除默认 IDE"}
            </button>
          </div>
        </form>
        ${this.message ? html`<p role="status">${this.message}</p>` : null}
      </details>
    </section>`;
  }
  static styles = runtimeStyles;
}
customElements.define("devhub-ide-settings", IdeSettings);
