import { LitElement, css, html } from "lit";
import {
  folderName,
  type CreationOperation,
  type CreationRequest,
  type CreationState,
} from "../shared/creation";

const labels: Record<CreationState, string> = {
  copying: "复制中",
  publishing: "目录落位中",
  registering: "登记中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
  interrupted: "已中断",
};

class CreationPanel extends LitElement {
  static properties = {
    templateId: {},
    operations: { state: true },
    message: { state: true },
    busy: { state: true },
  };
  declare templateId: string;
  declare private operations: CreationOperation[];
  declare private message: string;
  declare private busy: boolean;
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    super();
    this.templateId = "";
    this.operations = [];
    this.message = "";
    this.busy = false;
  }
  connectedCallback() {
    super.connectedCallback();
    void this.poll();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.timer);
  }
  private async poll() {
    try {
      const result = await window.devhub?.creation({ action: "list" });
      if (result?.ok) {
        const previous = this.operations
          .map((operation) => `${operation.id}:${operation.state}`)
          .join();
        this.operations = result.data;
        if (
          previous !==
          result.data
            .map((operation) => `${operation.id}:${operation.state}`)
            .join()
        ) {
          this.dispatchEvent(
            new CustomEvent("projects-changed", {
              bubbles: true,
              composed: true,
            }),
          );
        }
      }
    } catch {
      this.message = "无法读取创建任务。";
    }
    if (this.isConnected) this.timer = setTimeout(() => void this.poll(), 1000);
  }
  private async execute(request: CreationRequest) {
    if (this.busy) return;
    this.busy = true;
    this.message = "";
    try {
      const result = await window.devhub?.creation(request);
      if (!result) throw new Error("本地创建服务不可用。");
      if (!result.ok) throw new Error(result.error.message);
      this.operations = result.data;
      this.dispatchEvent(
        new CustomEvent("projects-changed", { bubbles: true, composed: true }),
      );
    } catch (error) {
      this.message = error instanceof Error ? error.message : "创建操作失败。";
    } finally {
      this.busy = false;
    }
  }
  private submit(event: SubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    const name = folderName.safeParse(form.get("name"));
    if (!name.success) {
      this.message = "请输入有效的 Windows 文件夹名称。";
      return;
    }
    void this.execute({
      action: "start",
      templateId: this.templateId,
      name: name.data,
      initializeGit: form.get("git") === "on",
    });
  }
  protected render() {
    return html`
      ${
        this.templateId
          ? html`<form @submit=${this.submit}>
              <label
                >新项目名称<input name="name" required maxlength="100"
              /></label>
              <label
                ><input type="checkbox" name="git" />初始化新的 Git 仓库</label
              >
              <button ?disabled=${this.busy}>选择父目录并确认创建</button>
            </form>`
          : null
      }
      ${this.message ? html`<p role="alert">${this.message}</p>` : null}
      ${
        !this.templateId && this.operations.length
          ? html`<section aria-label="创建任务">
              <h2>创建任务</h2>
              ${this.operations.map(
                (operation) =>
                  html`<article>
                    <strong>${operation.name}</strong> ·
                    ${labels[operation.state]} · 已复制 ${operation.copied}
                    个文件
                    <p><code>${operation.target}</code></p>
                    ${operation.message ? html`<p>${operation.message}</p>` : null}
                    ${operation.state === "copying" ? html`<button ?disabled=${this.busy} @click=${() => this.execute({ action: "cancel", id: operation.id })}>取消创建</button>` : null}
                    ${
                      ["failed", "interrupted"].includes(operation.state)
                        ? html`<p>
                              临时目录 <code>${operation.temporary}</code>
                            </p>
                            <button
                              ?disabled=${this.busy}
                              @click=${() => this.execute({ action: "resume", id: operation.id })}
                            >
                              恢复创建或登记
                            </button>`
                        : null
                    }
                  </article>`,
              )}
            </section>`
          : null
      }
    `;
  }
  static styles = css`
    form {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.6rem;
      padding-block: 0.8rem;
    }
    input,
    button {
      font: inherit;
      padding: 0.35rem 0.6rem;
      border: 1px solid #a8b7c2;
      border-radius: 4px;
    }
    button {
      background: #356c82;
      color: white;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.5;
    }
    :is(input, button):focus-visible {
      outline: 2px solid #356c82;
      outline-offset: 2px;
    }
    h2 {
      font-size: 1rem;
    }
    p {
      margin: 0.4rem 0;
      overflow-wrap: anywhere;
    }
    article {
      border-top: 1px solid #dce2e8;
      padding: 0.8rem 0;
    }
    section {
      background: white;
      padding: 1rem;
      margin-top: 1rem;
      border: 1px solid #dce2e8;
    }
    [role="alert"] {
      color: #93451b;
    }
  `;
}
customElements.define("devhub-creation-panel", CreationPanel);
