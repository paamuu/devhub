import { LitElement, css, html } from "lit";
import { keyed } from "lit/directives/keyed.js";
import "./directory-page";
import "./dashboard-page";
import "./ide-settings";
import "./backup-settings";
import {
  type DevHubAPI,
  type WorkspaceStatus,
  workspaceStatusSchema,
} from "../shared/contracts";

declare global {
  interface Window {
    devhub?: DevHubAPI;
  }
}

const pages = ["Dashboard", "Templates", "Projects", "Settings"] as const;
type Page = (typeof pages)[number];

class DevHubApp extends LitElement {
  static properties = {
    page: { state: true },
    workspace: { state: true },
    navigationRevision: { state: true },
  };

  declare private page: Page;
  declare private workspace: WorkspaceStatus | undefined;
  private initialId?: string;
  declare private navigationRevision: number;

  constructor() {
    super();
    this.page = "Dashboard";
    this.navigationRevision = 0;
  }

  protected firstUpdated() {
    void this.loadWorkspace();
  }

  private async loadWorkspace() {
    try {
      const status = await window.devhub?.workspaceStatus();
      this.workspace = workspaceStatusSchema.parse(status);
    } catch {
      this.workspace = {
        ok: false,
        error: { code: "DATABASE_ERROR", message: "无法读取工作区状态。" },
      };
    }
  }

  private renderPage() {
    switch (this.page) {
      case "Dashboard":
        return html`<devhub-dashboard
          @directory-navigate=${(
            event: CustomEvent<{ kind: string; id?: string }>,
          ) => {
            this.initialId = event.detail.id;
            this.page =
              event.detail.kind === "template" ? "Templates" : "Projects";
          }}
        ></devhub-dashboard>`;
      case "Templates":
      case "Projects":
        return keyed(
          `${this.page}-${this.navigationRevision}`,
          html`<devhub-directory-page
            .kind=${this.page === "Templates" ? "template" : "project"}
            .initialId=${this.initialId}
          ></devhub-directory-page>`,
        );
      case "Settings":
        return html`
          <section aria-labelledby="storage">
            <h2 id="storage">本地存储</h2>
            ${
              this.workspace?.ok
                ? html`<dl>
                    <dt>数据库位置</dt>
                    <dd><code>${this.workspace.data.databasePath}</code></dd>
                    <dt>数据库版本</dt>
                    <dd>${this.workspace.data.schemaVersion}</dd>
                  </dl>`
                : html`<p>
                    ${this.workspace?.error.message ?? "正在读取数据库状态…"}
                  </p>`
            }
          </section>
          <devhub-ide-settings></devhub-ide-settings>
          <devhub-backup-settings></devhub-backup-settings>
          <devhub-git-tools></devhub-git-tools>
        `;
    }
  }

  protected render() {
    const status = this.workspace;
    return html`
      <aside>
        <div class="brand"><span aria-hidden="true">&gt;_</span>DevHub</div>
        <nav aria-label="工作台导航">
          ${pages.map(
            (page) => html`
              <button
                aria-current=${page === this.page ? "page" : "false"}
                @click=${() => {
                  this.page = page;
                  this.initialId = undefined;
                  this.navigationRevision++;
                }}
              >
                ${page}
              </button>
            `,
          )}
        </nav>
        <div
          class="local-status"
          role="status"
          ?data-workspace-ready=${status?.ok === true}
        >
          ${status?.ok ? "数据库已就绪" : (status?.error.message ?? "正在打开数据库…")}
        </div>
      </aside>
      <main>
        <header><h1>${this.page}</h1></header>
        ${this.renderPage()}
      </main>
    `;
  }

  static styles = css`
    :host {
      display: grid;
      grid-template-columns: 13rem minmax(0, 1fr);
      min-height: 100vh;
      color: #1d2935;
    }
    aside {
      display: flex;
      flex-direction: column;
      background: #182630;
      color: #d5e1e7;
      padding: 1.5rem 1rem;
    }
    .brand {
      display: flex;
      gap: 0.65rem;
      align-items: center;
      padding: 0 0.75rem 2rem;
      font-size: 1.22rem;
      font-weight: 650;
    }
    .brand span {
      color: #8ecbd1;
      font-family: ui-monospace, monospace;
    }
    nav {
      display: grid;
      gap: 0.25rem;
    }
    button {
      background: transparent;
      color: inherit;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 0.65rem 0.75rem;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    button:hover {
      background: #233944;
    }
    button[aria-current="page"] {
      background: #2c4754;
      border-color: #4c6a77;
      color: white;
    }
    button:focus-visible {
      outline: 2px solid #9be0e6;
      outline-offset: 2px;
    }
    .local-status {
      margin-top: auto;
      padding: 1rem 0.75rem 0;
      font-size: 0.82rem;
      line-height: 1.5;
    }
    .local-status[data-workspace-ready] {
      color: #a7ddd2;
    }
    main {
      padding: 2rem clamp(1.75rem, 4vw, 4rem);
    }
    header {
      border-bottom: 1px solid #cdd6dc;
      padding-bottom: 1rem;
      margin-bottom: 1.5rem;
    }
    h1,
    h2,
    p {
      margin: 0;
    }
    h1 {
      font-size: 1.72rem;
      font-weight: 650;
      letter-spacing: -0.02em;
    }
    section {
      padding: 1.1rem 1.25rem;
      margin-block: 0 0.7rem;
      background: #fff;
      border: 1px solid #dce2e8;
      border-radius: 4px;
    }
    h2 {
      font-size: 0.98rem;
      margin-bottom: 0.65rem;
    }
    p,
    dt {
      color: #4d5c68;
    }
    dl {
      display: grid;
      gap: 0.5rem;
      margin-bottom: 0;
    }
    dd {
      margin: 0 0 0.5rem;
      overflow-wrap: anywhere;
    }
  `;
}

customElements.define("devhub-app", DevHubApp);
