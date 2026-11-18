import { LitElement, css, html } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { runtimeStyles } from "./runtime-styles";
import {
  remoteName,
  remoteUrl,
  type GitRequest,
  type GitRepository,
  type GitRemote,
} from "../shared/git";

type Editor =
  | { action: "add"; name: string; url: string }
  | { action: "update"; name: string; url: string; target: "fetch" | "push" };
class GitPanel extends LitElement {
  static properties = {
    projectId: {},
    repository: { state: true },
    busy: { state: true },
    message: { state: true },
    error: { state: true },
    editor: { state: true },
    stale: { state: true },
  };
  declare projectId: string;
  declare private repository?: GitRepository;
  declare private busy: boolean;
  declare private message: string;
  declare private error: string;
  declare private editor?: Editor;
  declare private stale: boolean;
  private requestId?: string;
  private generation = 0;
  private readonly onWindowFocus = () => {
    if (!this.busy && !this.editor) void this.refresh();
  };
  constructor() {
    super();
    this.busy = false;
    this.message = "";
    this.error = "";
    this.stale = false;
  }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("focus", this.onWindowFocus);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("focus", this.onWindowFocus);
    this.generation++;
    void this.cancel();
  }
  protected firstUpdated() {
    void this.refresh();
  }
  private async cancel() {
    if (this.requestId)
      await window.devhub?.git({ action: "cancel", requestId: this.requestId });
  }
  private async run(request: GitRequest) {
    const generation = ++this.generation;
    this.requestId = request.requestId;
    this.busy = true;
    this.error = "";
    this.message = "";
    try {
      const result = await window.devhub?.git(request);
      if (generation !== this.generation) return;
      if (!result?.ok)
        throw new Error(
          result && !result.ok ? result.error.message : "Git 服务不可用。",
        );
      if (result.data.repository) this.repository = result.data.repository;
      this.stale = false;
      if (request.action !== "inspect" && request.action !== "open") {
        this.message = result.data.cancelled
          ? "操作已取消，仓库未由本次操作修改。"
          : "Remote 已更新，已重新读取本地仓库。";
        if (!result.data.cancelled) this.editor = undefined;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error = error instanceof Error ? error.message : "Git 操作失败。";
        this.stale = true;
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.requestId = undefined;
      }
    }
  }
  private refresh() {
    return this.run({
      action: "inspect",
      projectId: this.projectId,
      requestId: crypto.randomUUID(),
    });
  }
  private edit(remote: GitRemote, target: "fetch" | "push") {
    const value = (target === "fetch" ? remote.fetch : remote.push)[0] ?? "";
    this.editor = {
      action: "update",
      name: remote.name,
      target,
      url: value.startsWith("[") ? "" : value,
    };
  }
  private submit(event: SubmitEvent) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget as HTMLFormElement);
    const name = remoteName.safeParse(fields.get("name"));
    const url = remoteUrl.safeParse(fields.get("url"));
    if (!name.success || !url.success) {
      this.error = "请填写有效名称与无凭据的 HTTPS / Git SSH 地址。";
      return;
    }
    if (!this.editor || !this.repository) return;
    void this.run({
      ...this.editor,
      name: name.data,
      url: url.data,
      projectId: this.projectId,
      requestId: crypto.randomUUID(),
      revision: this.repository.revision,
    });
  }
  protected render() {
    const repo = this.repository,
      status = repo?.status;
    const writable = repo?.writable && !this.busy && !this.stale;
    return html`<section aria-label="Git 仓库">
      <div class="actions">
        <h2>Git</h2>
        <button ?disabled=${this.busy} @click=${this.refresh}>重新检测</button
        >${this.busy ? html`<span role="status">正在查询 Git…</span><button @click=${this.cancel}>取消操作</button>` : null}
      </div>
      ${this.error ? html`<p role="alert">${this.error}</p>` : null}${this.message ? html`<p role="status">${this.message}</p>` : null}
      ${this.stale ? html`<p>下面是上次读取的数据，请重新检测后再修改。</p>` : null}
      ${repo?.kind === "none" ? html`<p>此目录尚未初始化 Git。请在 IDE 或终端初始化后重新检测。</p>` : null}
      ${repo?.kind === "bare" ? html`<p>此目录是裸仓库，没有工作树。请登记带工作目录的项目。</p>` : null}
      ${repo?.kind === "nested" ? html`<p role="alert">此项目属于上级工作树，Remote 修改已禁用。请登记实际工作树根目录。</p>` : null}
      ${repo?.root ? html`<p class="path">工作树 <code>${repo.root}</code></p>` : null}
      ${
        status
          ? html`
              <div class="branch">
                <strong
                  >${status.detached ? "Detached HEAD" : (status.branch ?? "未知分支")}</strong
                >${status.unborn ? html`<span>尚无提交</span>` : html`<code>${status.oid?.slice(0, 10)}</code>`}
              </div>
              <div class="counts">
                <span>已暂存 <b>${status.staged}</b></span
                ><span>未暂存 <b>${status.modified}</b></span
                ><span>未跟踪 <b>${status.untracked}</b></span
                ><span>冲突 <b>${status.conflicted}</b></span>
              </div>
              <p>
                ${status.total === 0 ? "工作区干净。" : `${status.total} 个变更条目。`}
                ${status.upstream ? `上游 ${status.upstream} · 领先 ${status.ahead ?? "未知"} / 落后 ${status.behind ?? "未知"}` : "未设置上游分支。"}
              </p>
              <small
                >基于本地跟踪引用，检测不会连接远端。目录中的外部修改可通过重新检测读取。</small
              >
              ${
                status.files.length
                  ? html`<details>
                      <summary>
                        查看变更路径${status.truncated ? "（仅显示前 200 条）" : ""}
                      </summary>
                      <ul class="files">
                        ${status.files.map((file) => html`<li><code>${file.index}${file.worktree}</code><span>${file.originalPath ? `${file.originalPath} → ` : ""}${file.path}${file.conflict ? " · 冲突" : ""}</span></li>`)}
                      </ul>
                      <small
                        >状态列依次为暂存区 / 工作区，? 表示未跟踪，.
                        表示未修改。</small
                      >
                    </details>`
                  : null
              }
              <div class="remote-heading actions">
                <h2>Remotes</h2>
                <button
                  ?disabled=${!writable}
                  @click=${() => {
                    this.editor = { action: "add", name: "origin", url: "" };
                  }}
                >
                  添加 Remote
                </button>
              </div>
              ${
                repo!.remotes.length
                  ? html`<ul class="remotes">
                      ${repo!.remotes.map(
                        (remote) =>
                          html`<li>
                            <div class="actions">
                              <strong>${remote.name}</strong
                              ><button
                                ?disabled=${this.busy || this.stale || !remote.browserUrl}
                                @click=${() => this.run({ action: "open", projectId: this.projectId, requestId: crypto.randomUUID(), name: remote.name, revision: repo!.revision })}
                              >
                                打开 GitHub</button
                              ><button
                                ?disabled=${!writable || !remote.editable}
                                @click=${() => this.edit(remote, "fetch")}
                              >
                                修改 Fetch</button
                              ><button
                                ?disabled=${!writable || !remote.editable}
                                @click=${() => this.edit(remote, "push")}
                              >
                                修改 Push</button
                              ><button
                                class="danger"
                                ?disabled=${!writable || !remote.editable}
                                @click=${() => this.run({ action: "remove", projectId: this.projectId, requestId: crypto.randomUUID(), name: remote.name, revision: repo!.revision })}
                              >
                                删除 Remote
                              </button>
                            </div>
                            <dl>
                              <dt>Fetch</dt>
                              <dd>
                                ${remote.fetch.length ? remote.fetch.map((url) => html`<code>${url}</code>`) : "未配置"}
                              </dd>
                              <dt>
                                Push${remote.explicitPush ? "" : "（沿用 Fetch）"}
                              </dt>
                              <dd>
                                ${remote.push.length ? remote.push.map((url) => html`<code>${url}</code>`) : "未配置"}
                              </dd>
                            </dl>
                          </li>`,
                      )}
                    </ul>`
                  : html`<p>尚未配置 Remote，可以关联已有远程仓库。</p>`
              }
              ${
                this.editor
                  ? keyed(
                      this.editor,
                      html`<form @submit=${this.submit}>
                        <h2>
                          ${this.editor.action === "add" ? "添加 Remote" : `修改 ${this.editor.target === "fetch" ? "Fetch" : "Push"} 地址`}
                        </h2>
                        <label
                          >名称<input
                            name="name"
                            required
                            maxlength="100"
                            ?readonly=${this.editor.action === "update"}
                            .value=${this.editor.name} /></label
                        ><label
                          >远程地址<input
                            name="url"
                            type="text"
                            required
                            maxlength="2000"
                            .value=${this.editor.url}
                            placeholder="https://github.com/owner/repository.git"
                            autocomplete="off" /></label
                        ><small
                          >支持 HTTPS、git@host:path 与
                          ssh://git@host/path。凭据由系统 Git
                          管理。修改仅替换第一个地址。</small
                        >
                        <div class="actions">
                          <button class="primary" ?disabled=${!writable}>
                            检查并确认</button
                          ><button
                            type="button"
                            ?disabled=${this.busy}
                            @click=${() => {
                              this.editor = undefined;
                            }}
                          >
                            关闭
                          </button>
                        </div>
                      </form>`,
                    )
                  : null
              }
            `
          : null
      }
      ${repo ? html`<p class="checked">最近检测 ${new Date(repo.checkedAt).toLocaleString()}</p>` : !this.busy && !this.error ? html`<p>请选择重新检测读取仓库。</p>` : null}
    </section>`;
  }
  static styles = [
    runtimeStyles,
    css`
      section {
        margin-top: 0;
      }
      h2 {
        margin: 0;
      }
      .branch {
        display: flex;
        gap: 0.7rem;
        margin-top: 1rem;
      }
      .counts {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-top: 0.7rem;
      }
      .counts span {
        background: #eef3f5;
        padding: 0.4rem 0.6rem;
        border-radius: 3px;
      }
      .remote-heading {
        margin-top: 1.3rem;
      }
      .remotes {
        list-style: none;
        padding: 0;
      }
      .remotes > li {
        border-top: 1px solid #dce2e8;
        padding: 0.8rem 0;
      }
      dl {
        display: grid;
        grid-template-columns: 9rem minmax(0, 1fr);
        gap: 0.5rem;
      }
      dt {
        color: #4d5c68;
      }
      dd {
        margin: 0;
      }
      dd code {
        display: block;
        overflow-wrap: anywhere;
      }
      .files {
        list-style: none;
        padding: 0;
        max-height: 15rem;
        overflow: auto;
      }
      .files li {
        display: grid;
        grid-template-columns: 2.5rem 1fr;
        padding: 0.2rem 0;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      .danger {
        color: #93451b;
      }
      .checked {
        font-size: 0.8rem;
      }
      form {
        border-top: 1px solid #dce2e8;
        padding-top: 1rem;
      }
    `,
  ];
}
customElements.define("devhub-git-panel", GitPanel);

class GitTools extends LitElement {
  static properties = { message: { state: true }, busy: { state: true } };
  declare private message: string;
  declare private busy: boolean;
  private requestId?: string;
  constructor() {
    super();
    this.message = "";
    this.busy = false;
  }
  protected firstUpdated() {
    void this.check();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.requestId)
      void window.devhub?.git({ action: "cancel", requestId: this.requestId });
  }
  private async check() {
    this.busy = true;
    this.requestId = crypto.randomUUID();
    try {
      const result = await window.devhub?.git({
        action: "tools",
        requestId: this.requestId,
      });
      this.message = result?.ok
        ? (result.data.version ?? "Git 已就绪")
        : (result?.error.message ?? "Git 服务不可用。");
    } catch {
      this.message = "Git 检测失败，请重试。";
    } finally {
      this.busy = false;
      this.requestId = undefined;
    }
  }
  protected render() {
    return html`<section>
      <h2>Git 工具</h2>
      <p role="status">${this.busy ? "正在检测系统 Git…" : this.message}</p>
      <button ?disabled=${this.busy} @click=${this.check}>检测 Git</button>
      <p>
        使用系统 PATH 中的 Git，认证由系统 Git Credential Manager 或 SSH Agent
        管理。
      </p>
    </section>`;
  }
  static styles = runtimeStyles;
}
customElements.define("devhub-git-tools", GitTools);
