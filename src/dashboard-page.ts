import { LitElement, css, html } from "lit";
import type { DirectoryEntry, DirectoryKind } from "../shared/contracts";
import { RuntimeController, sessionLabel } from "./runtime-controller";

class DashboardPage extends LitElement {
  private readonly runtime = new RuntimeController(this);
  static properties = {
    templates: { state: true },
    projects: { state: true },
    error: { state: true },
    loading: { state: true },
  };
  declare private templates: DirectoryEntry[];
  declare private projects: DirectoryEntry[];
  declare private error: string;
  declare private loading: boolean;
  constructor() {
    super();
    this.templates = [];
    this.projects = [];
    this.error = "";
    this.loading = true;
  }
  protected firstUpdated() {
    void this.refresh();
  }
  private async refresh() {
    this.loading = true;
    this.error = "";
    try {
      const results = await Promise.all(
        ["template", "project"].map((kind) =>
          window.devhub?.directory({
            action: "list",
            kind: kind as DirectoryKind,
          }),
        ),
      );
      const lists = results.map((result) => {
        if (!result?.ok || !Array.isArray(result.data))
          throw new Error(
            result && !result.ok ? result.error.message : "无法读取工作区。",
          );
        return result.data;
      });
      [this.templates, this.projects] = lists;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "无法读取工作区。";
    } finally {
      this.loading = false;
    }
  }
  private open(kind: DirectoryKind, id?: string) {
    this.dispatchEvent(
      new CustomEvent("directory-navigate", {
        bubbles: true,
        composed: true,
        detail: { kind, id },
      }),
    );
  }
  private row(kind: DirectoryKind, entry: DirectoryEntry) {
    return html`<li>
      <button @click=${() => this.open(kind, entry.id)}>${entry.name}</button
      ><code>${entry.path}</code>
    </li>`;
  }
  protected render() {
    const recentProjects = this.projects
      .filter((entry) => !entry.archivedAt && entry.lastOpenedAt)
      .sort((a, b) => b.lastOpenedAt!.localeCompare(a.lastOpenedAt!))
      .slice(0, 6);
    const recentTemplates = this.templates
      .filter((entry) => entry.lastUsedAt)
      .sort((a, b) => b.lastUsedAt!.localeCompare(a.lastUsedAt!))
      .slice(0, 6);
    const missing = [
      ...this.templates.map((entry) => ({ kind: "template" as const, entry })),
      ...this.projects.map((entry) => ({ kind: "project" as const, entry })),
    ].filter(({ entry }) => entry.availability !== "available");
    return html`<div class="actions">
        <button @click=${() => this.open("template")}>
          管理模板 / 创建项目</button
        ><button @click=${() => this.open("project")}>管理项目</button
        ><button ?disabled=${this.loading} @click=${this.refresh}>刷新</button>
      </div>
      ${this.error ? html`<p role="alert">${this.error}</p>` : null}
      <section>
        <h2>运行中的预览</h2>
        ${
          [...this.runtime.sessions.values()].some((session) => session.active)
            ? html`<ul>
                ${[...this.runtime.sessions.values()].filter((session) => session.active).map((session) => html`<li><button @click=${() => this.open("project", session.projectId)}>${this.projects.find((project) => project.id === session.projectId)?.name ?? "查看项目"}</button><span>${sessionLabel(session)}</span></li>`)}
              </ul>`
            : html`<p>${this.runtime.error || "暂无运行中的预览。"}</p>`
        }
      </section>
      ${
        this.loading
          ? html`<p role="status">正在检查工作区…</p>`
          : html`
              <section>
                <h2>最近项目</h2>
                ${
                  recentProjects.length
                    ? html`<ul>
                        ${recentProjects.map((entry) => this.row("project", entry))}
                      </ul>`
                    : html`<p>暂无最近打开的项目。</p>`
                }
              </section>
              <section>
                <h2>最近使用的模板</h2>
                ${
                  recentTemplates.length
                    ? html`<ul>
                        ${recentTemplates.map((entry) => this.row("template", entry))}
                      </ul>`
                    : html`<p>暂无最近使用的模板。</p>`
                }
              </section>
              ${
                missing.length
                  ? html`<section>
                      <h2>需要检查的目录</h2>
                      <ul>
                        ${missing.map(({ kind, entry }) => this.row(kind, entry))}
                      </ul>
                    </section>`
                  : null
              }
            `
      }`;
  }
  static styles = css`
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    button {
      font: inherit;
      border: 1px solid #a8b7c2;
      padding: 0.4rem 0.65rem;
      border-radius: 4px;
      background: #fff;
      color: #285970;
      cursor: pointer;
    }
    button:focus-visible {
      outline: 2px solid #356c82;
      outline-offset: 2px;
    }
    button:disabled {
      opacity: 0.5;
    }
    section {
      padding: 1.1rem 1.25rem;
      background: #fff;
      border: 1px solid #dce2e8;
      border-radius: 4px;
      margin-bottom: 0.7rem;
    }
    h2 {
      margin: 0 0 0.6rem;
      font-size: 1rem;
    }
    p {
      margin: 0;
      color: #4d5c68;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    li {
      display: grid;
      grid-template-columns: minmax(8rem, 1fr) 3fr;
      align-items: center;
      gap: 1rem;
      padding: 0.5rem 0;
    }
    code {
      overflow-wrap: anywhere;
      color: #4d5c68;
    }
    [role="alert"] {
      color: #93451b;
      margin-bottom: 1rem;
    }
  `;
}
customElements.define("devhub-dashboard", DashboardPage);
