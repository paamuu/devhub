import { LitElement, html, css } from "lit";
import { runtimeStyles } from "./runtime-styles";
import type { BackupRequest, BackupPreview } from "../shared/backup";

class BackupSettings extends LitElement {
  static properties = {
    busy: { state: true },
    message: { state: true },
    error: { state: true },
    preview: { state: true },
    path: { state: true },
    restarting: { state: true },
  };
  declare private busy: boolean;
  declare private message: string;
  declare private error: string;
  declare private preview?: BackupPreview;
  declare private path: string;
  declare private restarting: boolean;
  constructor() {
    super();
    this.busy = false;
    this.message = "";
    this.error = "";
    this.path = "";
    this.restarting = false;
  }
  protected firstUpdated() {
    void this.run({ action: "status" });
  }
  private async run(request: BackupRequest) {
    this.busy = true;
    this.error = "";
    try {
      const result = await window.devhub?.backup(request);
      if (!result?.ok)
        throw new Error(
          result && !result.ok ? result.error.message : "备份服务不可用。",
        );
      this.message = result.data.message ?? "";
      if (result.data.preview) this.preview = result.data.preview;
      if (result.data.path) this.path = result.data.path;
      this.restarting = result.data.restarting ?? false;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "备份操作失败。";
    } finally {
      this.busy = false;
    }
  }
  protected render() {
    return html`<section aria-labelledby="backup-title">
      <h2 id="backup-title">备份与恢复</h2>
      <p>
        备份包含模板、项目登记、设置、普通环境变量和密钥引用。源码、密钥值、Git
        对象与日志不包含在备份中。
      </p>
      <div class="actions">
        <button
          ?disabled=${this.busy || this.restarting}
          @click=${() => this.run({ action: "export" })}
        >
          导出备份</button
        ><button
          ?disabled=${this.busy || this.restarting}
          @click=${() => this.run({ action: "prepare" })}
        >
          选择恢复文件
        </button>
      </div>
      ${this.busy ? html`<p role="status">正在处理数据，请等待…</p>` : null}
      ${this.error ? html`<p role="alert">${this.error}</p>` : null}${this.message ? html`<p role="status">${this.message}</p>` : null}
      ${this.path ? html`<p>已保存到 <code>${this.path}</code></p>` : null}
      ${
        this.preview
          ? html`<div class="review">
              <h2>恢复预览</h2>
              <dl>
                <dt>备份时间</dt>
                <dd>${new Date(this.preview.createdAt).toLocaleString()}</dd>
                <dt>登记数据</dt>
                <dd>
                  ${this.preview.templates} 个模板，${this.preview.projects}
                  个项目
                </dd>
                <dt>不可用路径</dt>
                <dd>${this.preview.missingPaths} 个</dd>
                <dt>密钥引用</dt>
                <dd>
                  ${this.preview.secretReferences} 个，恢复后检查本机匹配情况
                </dd>
              </dl>
              <p>
                确认恢复将覆盖当前元数据和普通环境配置，停止预览并重启
                DevHub。恢复前会自动保留当前数据备份。
              </p>
              <button
                class="restore"
                ?disabled=${this.busy || this.restarting}
                @click=${() => this.run({ action: "restore", token: this.preview!.token })}
              >
                恢复此备份…
              </button>
            </div>`
          : null
      }
    </section>`;
  }
  static styles = [
    runtimeStyles,
    css`
      dl {
        display: grid;
        grid-template-columns: 7rem 1fr;
        gap: 0.5rem;
      }
      dd {
        margin: 0;
      }
      code {
        overflow-wrap: anywhere;
      }
      .review {
        border-top: 1px solid #dce2e8;
        padding-top: 1rem;
        margin-top: 1rem;
      }
      .restore {
        color: #93451b;
      }
    `,
  ];
}
customElements.define("devhub-backup-settings", BackupSettings);
