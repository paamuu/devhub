import { LitElement, css, html } from "lit";
import { keyed } from "lit/directives/keyed.js";
import "./creation-panel";
import "./preview-panel";
import "./git-panel";
import { previewFields, readPreviewFields } from "./preview-fields";
import {
  directoryFields,
  type DirectoryEntry,
  type DirectoryKind,
  type DirectoryRequest,
  type DirectoryFields,
} from "../shared/contracts";

const types = {
  web: "Web",
  "mini-program": "小程序",
  backend: "后端",
  other: "其他",
} as const;
type Choice = {
  selection: string;
  path: string;
  name: string;
  suggested?: Partial<DirectoryFields>;
};
type Editor = { entry: DirectoryEntry } | { choice: Choice };

class DirectoryPage extends LitElement {
  private detailTab: "preview" | "git" = "preview";
  static properties = {
    kind: {},
    entries: { state: true },
    busy: { state: true },
    error: { state: true },
    query: { state: true },
    typeFilter: { state: true },
    tag: { state: true },
    archives: { state: true },
    editor: { state: true },
    editorError: { state: true },
    creating: { state: true },
    detail: { state: true },
    initialId: {},
  };
  declare kind: DirectoryKind;
  declare private entries?: DirectoryEntry[];
  declare private busy: boolean;
  declare private error: string;
  declare private query: string;
  declare private typeFilter: string;
  declare private tag: string;
  declare private archives: boolean;
  declare private editor?: Editor;
  declare private editorError: string;
  declare private creating?: string;
  declare private detail?: DirectoryEntry;
  declare initialId?: string;

  constructor() {
    super();
    this.kind = "project";
    this.busy = false;
    this.error =
      this.query =
      this.typeFilter =
      this.tag =
      this.editorError =
        "";
    this.archives = false;
  }

  protected firstUpdated() {
    void this.perform(async () => {
      await this.refresh();
      if (this.initialId) await this.showDetail(this.initialId);
    });
  }

  private async call(input: DirectoryRequest) {
    const api = window.devhub;
    if (!api) throw new Error("无法连接 DevHub 本地服务。");
    const result = await api.directory(input);
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }

  private async perform(action: () => Promise<void>, inEditor = false) {
    if (this.busy) return;
    this.busy = true;
    this.error = this.editorError = "";
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : "操作失败。";
      if (inEditor && this.editor) this.editorError = message;
      else this.error = message;
    } finally {
      this.busy = false;
    }
  }

  private async refresh() {
    const entries = await this.call({ action: "list", kind: this.kind });
    if (!Array.isArray(entries)) throw new Error("无法读取登记列表。");
    this.entries = entries;
    if (this.detail)
      this.detail = entries.find((entry) => entry.id === this.detail?.id);
    if (!entries.some((entry) => entry.tags.includes(this.tag))) this.tag = "";
  }

  private async showDetail(id: string) {
    const entries = await this.call({ action: "detail", kind: this.kind, id });
    if (!Array.isArray(entries) || !entries[0])
      throw new Error("无法读取登记详情。");
    this.detail = entries[0];
  }

  private formatDate(value: string | null) {
    return value ? new Date(value).toLocaleString() : "暂无记录";
  }

  private async select() {
    const result = await this.call({ action: "select" });
    return result && !Array.isArray(result) ? result : null;
  }

  private showEditor(editor: Editor) {
    this.editor = editor;
    this.editorError = "";
    void this.updateComplete.then(() => {
      const dialog = this.renderRoot.querySelector("dialog");
      if (dialog?.isConnected && !dialog.open) dialog.showModal();
    });
  }

  private submit(event: SubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    let previewConfig: unknown;
    try {
      previewConfig = readPreviewFields(data);
    } catch {
      this.editorError = '参数须填写 JSON 字符串数组，例如 ["run", "dev"]。';
      return;
    }
    const fields = directoryFields.safeParse({
      name: data.get("name"),
      description: data.get("description"),
      projectType: data.get("projectType"),
      tags: String(data.get("tags") ?? "")
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      techStack: String(data.get("techStack") ?? "")
        .split(/[,，]/)
        .map((value) => value.trim())
        .filter(Boolean),
      sourceUrl:
        this.kind === "template"
          ? String(data.get("sourceUrl") ?? "")
          : undefined,
      previewConfig,
    });
    if (!fields.success) {
      this.editorError = fields.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("；");
      return;
    }
    const editor = this.editor;
    if (!editor) return;
    void this.perform(async () => {
      await this.call(
        "entry" in editor
          ? {
              action: "edit",
              kind: this.kind,
              id: editor.entry.id,
              fields: fields.data,
            }
          : {
              action: "add",
              kind: this.kind,
              selection: editor.choice.selection,
              fields: fields.data,
            },
      );
      this.renderRoot.querySelector("dialog")?.close();
      this.editor = undefined;
      await this.refresh();
    }, true);
  }

  private renderEditor(editor: Editor) {
    const entry = "entry" in editor ? editor.entry : undefined;
    const choice = "choice" in editor ? editor.choice : undefined;
    const values = entry ?? choice?.suggested;
    return html`<dialog
      aria-labelledby="editor-title"
      @cancel=${(event: Event) => {
        if (this.busy) event.preventDefault();
      }}
      @close=${() => {
        this.editor = undefined;
      }}
    >
      <form @submit=${this.submit}>
        <h2 id="editor-title">${entry ? "编辑登记" : "登记目录"}</h2>
        <p class="path"><code>${entry?.path ?? choice?.path}</code></p>
        <label
          >名称<input
            name="name"
            required
            maxlength="120"
            .value=${(values?.name ?? choice?.name ?? "").slice(0, 120)}
            autofocus
        /></label>
        <label
          >类型<select name="projectType">
            ${Object.entries(types).map(([id, name]) => html`<option value=${id} ?selected=${id === (values?.projectType ?? "other")}>${name}</option>`)}
          </select></label
        >
        <label
          >标签（逗号分隔）<input
            name="tags"
            .value=${values?.tags?.join(", ") ?? ""}
        /></label>
        <label
          >描述<textarea
            name="description"
            maxlength="2000"
            .value=${values?.description ?? ""}
          ></textarea>
        </label>
        <label
          >技术栈（逗号分隔）<input
            name="techStack"
            .value=${values?.techStack?.join(", ") ?? ""}
        /></label>
        ${this.kind === "template" ? html`<label>来源仓库地址<input name="sourceUrl" .value=${values?.sourceUrl ?? ""} placeholder="https://github.com/owner/repository.git" /></label>` : null}
        ${previewFields(values?.previewConfig)}
        ${this.editorError ? html`<p role="alert">${this.editorError}</p>` : null}
        <div class="actions">
          <button
            type="button"
            ?disabled=${this.busy}
            @click=${() => this.renderRoot.querySelector("dialog")?.close()}
          >
            取消
          </button>
          <button class="primary" type="submit" ?disabled=${this.busy}>
            保存
          </button>
        </div>
      </form>
    </dialog>`;
  }

  private renderEntry(entry: DirectoryEntry) {
    const target = { kind: this.kind, id: entry.id };
    return html`<li>
      <div class="summary">
        <h2>${entry.name}</h2>
        <span>${types[entry.projectType]}</span>
        ${entry.availability === "available" ? null : html`<span class="warning">${entry.availability === "missing" ? "路径失效" : "无法访问"}</span>`}
      </div>
      <p class="path"><code>${entry.path}</code></p>
      ${entry.description ? html`<p>${entry.description}</p>` : null}
      ${entry.tags.length ? html`<p class="tags">${entry.tags.map((tag) => html`<span>${tag}</span>`)}</p>` : null}
      <div class="actions">
        ${
          !this.detail
            ? html`<button
                ?disabled=${this.busy}
                @click=${() => this.perform(() => this.showDetail(entry.id))}
              >
                查看详情
              </button>`
            : null
        }
        ${
          this.kind === "template"
            ? html`<button
                ?disabled=${this.busy || entry.availability !== "available"}
                @click=${() => {
                  this.creating =
                    this.creating === entry.id ? undefined : entry.id;
                }}
              >
                从模板创建项目
              </button>`
            : null
        }
        <button
          ?disabled=${this.busy || entry.availability !== "available"}
          @click=${() =>
            this.perform(async () => {
              await this.call({ action: "open", ...target });
            })}
        >
          打开目录
        </button>
        <button
          ?disabled=${this.busy}
          @click=${() => this.showEditor({ entry })}
        >
          编辑
        </button>
        <button
          ?disabled=${this.busy}
          @click=${() =>
            this.perform(async () => {
              const selected = await this.select();
              if (
                !selected ||
                !window.confirm(
                  `${entry.name}\n${entry.path}\n改为\n${selected.path}`,
                )
              )
                return;
              await this.call({
                action: "relink",
                ...target,
                selection: selected.selection,
              });
              await this.refresh();
            })}
        >
          重新关联
        </button>
        ${
          this.kind === "project"
            ? html`<button
                ?disabled=${this.busy}
                @click=${() =>
                  this.perform(async () => {
                    await this.call({
                      action: "archive",
                      id: entry.id,
                      archived: !entry.archivedAt,
                    });
                    await this.refresh();
                  })}
              >
                ${entry.archivedAt ? "恢复" : "归档"}
              </button>`
            : null
        }
        <button
          ?disabled=${this.busy}
          @click=${() =>
            this.perform(async () => {
              if (
                !window.confirm(
                  `移除「${entry.name}」的登记记录？本地目录会保留。`,
                )
              )
                return;
              await this.call({ action: "remove", ...target });
              await this.refresh();
            })}
        >
          移除记录
        </button>
        <button
          class="danger"
          ?disabled=${this.busy || entry.availability !== "available"}
          @click=${() =>
            this.perform(async () => {
              await this.call({ action: "trash", ...target });
              await this.refresh();
            })}
        >
          目录移入回收站
        </button>
      </div>
      ${
        this.creating === entry.id
          ? html`<devhub-creation-panel
                .templateId=${entry.id}
              ></devhub-creation-panel>
              <p>创建进度可在 Projects 页面查看。</p>`
          : null
      }
    </li>`;
  }

  protected render() {
    if (this.detail)
      return html`
        <button
          @click=${() => {
            this.detail = undefined;
          }}
        >
          返回列表
        </button>
        <section class="detail">
          ${this.renderEntry(this.detail)}
          ${
            this.kind === "project"
              ? html`<div class="actions detail-tabs" aria-label="项目详情视图">
                    <button
                      aria-pressed=${this.detailTab === "preview"}
                      @click=${() => {
                        this.detailTab = "preview";
                        this.requestUpdate();
                      }}
                    >
                      Preview</button
                    ><button
                      aria-pressed=${this.detailTab === "git"}
                      @click=${() => {
                        this.detailTab = "git";
                        this.requestUpdate();
                      }}
                    >
                      Git
                    </button>
                  </div>
                  ${this.detailTab === "preview" ? keyed(this.detail.id, html`<devhub-preview-panel .entry=${this.detail}></devhub-preview-panel>`) : keyed(this.detail.id, html`<devhub-git-panel .projectId=${this.detail.id}></devhub-git-panel>`)}`
              : null
          }
          <details ?open=${this.kind === "template"}>
            <summary>登记资料与预览配置</summary>
            <dl>
              ${
                this.kind === "project"
                  ? html`<dt>来源模板</dt>
                      <dd>${this.detail.templateName ?? "直接导入"}</dd>`
                  : null
              }
              <dt>技术栈</dt>
              <dd>${this.detail.techStack.join("、") || "未填写"}</dd>
              ${
                this.kind === "template"
                  ? html`<dt>来源仓库</dt>
                      <dd>${this.detail.sourceUrl || "本地目录"}</dd>`
                  : null
              }
              <dt>创建时间</dt>
              <dd>${this.formatDate(this.detail.createdAt)}</dd>
              <dt>更新时间</dt>
              <dd>${this.formatDate(this.detail.updatedAt)}</dd>
              <dt>最近检查</dt>
              <dd>${this.formatDate(this.detail.lastCheckedAt)}</dd>
              <dt>最近打开</dt>
              <dd>${this.formatDate(this.detail.lastOpenedAt)}</dd>
              ${
                this.kind === "template"
                  ? html`<dt>最近使用</dt>
                      <dd>${this.formatDate(this.detail.lastUsedAt)}</dd>`
                  : null
              }
              <dt>预览配置</dt>
              <dd>
                ${
                  this.detail.previewConfig
                    ? html`<div class="preview-summary">
                        <code
                          >${this.detail.previewConfig.command}
                          ${this.detail.previewConfig.args.map((arg) => JSON.stringify(arg)).join(" ")}</code
                        >
                        <p>工作目录 ${this.detail.previewConfig.cwd}</p>
                        ${this.detail.previewConfig.previewUrl ? html`<p>预览地址 ${this.detail.previewConfig.previewUrl}</p>` : null}
                        ${this.detail.previewConfig.port ? html`<p>端口 ${this.detail.previewConfig.port}</p>` : null}
                        ${this.detail.previewConfig.readyCheck ? html`<p>就绪检测 ${this.detail.previewConfig.readyCheck.type.toUpperCase()}，超时 ${this.detail.previewConfig.readyCheck.timeoutMs / 1000} 秒</p>` : html`<p>就绪检测未配置</p>`}
                      </div>`
                    : "未配置"
                }
              </dd>
            </dl>
          </details>
        </section>
        ${this.error ? html`<p role="alert">${this.error}</p>` : null}
        ${this.editor ? keyed(this.editor, this.renderEditor(this.editor)) : null}
      `;
    const active = (this.entries ?? []).filter(
      (entry) => Boolean(entry.archivedAt) === this.archives,
    );
    const tags = [...new Set(active.flatMap((entry) => entry.tags))].sort(
      (a, b) => a.localeCompare(b),
    );
    const query = this.query.trim().toLocaleLowerCase();
    const visible = active.filter(
      (entry) =>
        (!this.typeFilter || entry.projectType === this.typeFilter) &&
        (!this.tag || entry.tags.includes(this.tag)) &&
        entry.name.toLocaleLowerCase().includes(query),
    );
    return html`
      <div class="toolbar">
        <input
          type="search"
          placeholder="搜索名称"
          aria-label="搜索名称"
          @input=${(event: InputEvent) => {
            this.query = (event.target as HTMLInputElement).value;
          }}
        />
        <select
          aria-label="项目类型"
          @change=${(event: Event) => {
            this.typeFilter = (event.target as HTMLSelectElement).value;
          }}
        >
          <option value="">全部类型</option>
          ${Object.entries(types).map(([id, name]) => html`<option value=${id}>${name}</option>`)}
        </select>
        <select
          aria-label="标签"
          .value=${this.tag}
          @change=${(event: Event) => {
            this.tag = (event.target as HTMLSelectElement).value;
          }}
        >
          <option value="">全部标签</option>
          ${tags.map((tag) => html`<option value=${tag} ?selected=${tag === this.tag}>${tag}</option>`)}
        </select>
        ${
          this.kind === "project"
            ? html`<label class="archive"
                ><input
                  type="checkbox"
                  @change=${(e: Event) => {
                    this.archives = (e.target as HTMLInputElement).checked;
                    this.tag = "";
                  }}
                />归档</label
              >`
            : null
        }
        <button
          ?disabled=${this.busy}
          @click=${() => this.perform(() => this.refresh())}
        >
          刷新
        </button>
        <button
          class="primary"
          ?disabled=${this.busy}
          @click=${() =>
            this.perform(async () => {
              const choice = await this.select();
              if (choice) this.showEditor({ choice });
            })}
        >
          ${this.kind === "template" ? "导入模板" : "导入项目"}
        </button>
      </div>
      ${this.error ? html`<p class="warning" role="alert">${this.error}</p>` : null}
      ${
        visible.length
          ? html`<ul>
              ${visible.map((entry) => keyed(entry.id, this.renderEntry(entry)))}
            </ul>`
          : html`<p class="empty">
              ${!this.entries ? (this.error ? "列表不可用。" : "正在读取登记…") : active.length ? "没有符合条件的登记。" : "暂无登记。"}
            </p>`
      }
      ${this.editor ? keyed(this.editor, this.renderEditor(this.editor)) : null}
      ${
        this.kind === "project"
          ? html`<devhub-creation-panel
              @projects-changed=${() => {
                void this.perform(() => this.refresh());
              }}
            ></devhub-creation-panel>`
          : null
      }
    `;
  }

  static styles = css`
    .detail-tabs {
      margin-top: 1rem;
      margin-bottom: 0.6rem;
    }
    .detail-tabs [aria-pressed="true"] {
      background: #356c82;
      color: white;
    }
    details {
      margin-top: 1rem;
    }
    summary {
      cursor: pointer;
      font-weight: 600;
      padding: 0.4rem 0;
    }
    summary:focus-visible {
      outline: 2px solid #356c82;
      outline-offset: 2px;
    }
    .detail {
      background: white;
      border: 1px solid #dce2e8;
      padding: 1rem;
      margin-top: 1rem;
    }
    .detail li {
      list-style: none;
      border: 0;
      padding: 0;
    }
    dl {
      display: grid;
      grid-template-columns: 7rem minmax(0, 1fr);
      gap: 0.6rem;
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    dt {
      color: #4d5c68;
    }
    fieldset {
      display: grid;
      gap: 0.5rem;
      border: 1px solid #dce2e8;
    }
    dialog {
      max-height: 85vh;
      overflow: auto;
    }
    .danger {
      color: #93451b;
    }
    .toolbar,
    .actions,
    .summary,
    .tags {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.45rem;
    }
    .toolbar {
      margin-bottom: 1rem;
    }
    button,
    input,
    select,
    textarea {
      font: inherit;
      color: inherit;
      border: 1px solid #a8b7c2;
      border-radius: 4px;
      padding: 0.36rem 0.62rem;
      background: #fff;
    }
    button {
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.55;
      cursor: default;
    }
    :is(button, input, select, textarea):focus-visible {
      outline: 2px solid #356c82;
      outline-offset: 2px;
    }
    .primary {
      background: #356c82;
      color: #fff;
      border-color: #356c82;
    }
    .archive {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0;
      border-top: 1px solid #dce2e8;
    }
    li,
    .empty {
      padding: 0.8rem 1rem;
      background: #fff;
      border: 1px solid #dce2e8;
    }
    li {
      border-top: 0;
    }
    p,
    h2 {
      margin: 0;
    }
    h2 {
      font-size: 1rem;
    }
    p {
      margin-block: 0.25rem;
    }
    .path {
      overflow-wrap: anywhere;
      color: #4d5c68;
    }
    .tags span {
      background: #e9f0f4;
      padding: 0.1rem 0.42rem;
      border-radius: 3px;
    }
    .warning,
    [role="alert"] {
      color: #93451b;
    }
    li .actions {
      margin-top: 0.55rem;
    }
    dialog {
      width: min(30rem, 80vw);
      border: 1px solid #a8b7c2;
      border-radius: 6px;
      color: #1d2935;
      background: #fff;
      padding: 1.25rem;
    }
    dialog::backdrop {
      background: #18263080;
    }
    form,
    form label {
      display: grid;
      gap: 0.3rem;
    }
    form {
      gap: 0.75rem;
    }
    form .actions {
      justify-content: flex-end;
    }
  `;
}

customElements.define("devhub-directory-page", DirectoryPage);
