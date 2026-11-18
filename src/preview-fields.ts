import { html } from "lit";
import type { PreviewConfig } from "../shared/preview-config";

export function previewFields(config: PreviewConfig | null | undefined) {
  return html`<fieldset>
    <legend>预览配置</legend>
    <label
      >可执行文件<input
        name="command"
        placeholder="npm.cmd"
        .value=${config?.command ?? ""}
    /></label>
    <label
      >参数（JSON 数组）<input
        name="args"
        placeholder='["run", "dev"]'
        .value=${JSON.stringify(config?.args ?? [])}
    /></label>
    <label>相对工作目录<input name="cwd" .value=${config?.cwd ?? "."} /></label>
    <label
      >预览地址<input
        name="previewUrl"
        type="url"
        placeholder="http://localhost:5173"
        .value=${config?.previewUrl ?? ""}
    /></label>
    <label
      >端口<input
        name="port"
        type="number"
        min="1"
        max="65535"
        .value=${config?.port?.toString() ?? ""}
    /></label>
    <label
      >就绪检测<select name="readyType">
        <option value="" ?selected=${!config?.readyCheck}>不检测</option>
        <option value="http" ?selected=${config?.readyCheck?.type === "http"}>
          HTTP
        </option>
        <option value="tcp" ?selected=${config?.readyCheck?.type === "tcp"}>
          TCP
        </option>
      </select></label
    >
    <label
      >检测地址或 TCP 端口<input
        name="readyTarget"
        .value=${config?.readyCheck?.type === "http" ? config.readyCheck.url : (config?.readyCheck?.port?.toString() ?? "")}
    /></label>
    <label
      >超时（毫秒）<input
        name="timeout"
        type="number"
        min="100"
        max="600000"
        .value=${String(config?.readyCheck?.timeoutMs ?? 30000)}
    /></label>
    <p>清空可执行文件可移除配置。创建项目时会复制模板的预览配置。</p>
  </fieldset>`;
}

export function readPreviewFields(form: FormData): unknown {
  const command = String(form.get("command") ?? "").trim();
  if (!command) return null;
  const readyType = form.get("readyType");
  let readyCheck;
  if (readyType === "http")
    readyCheck = {
      type: "http",
      url: form.get("readyTarget"),
      timeoutMs: Number(form.get("timeout")),
    };
  if (readyType === "tcp")
    readyCheck = {
      type: "tcp",
      port: Number(form.get("readyTarget")),
      timeoutMs: Number(form.get("timeout")),
    };
  return {
    adapter: "web-command",
    command,
    args: JSON.parse(String(form.get("args") || "[]")),
    cwd: form.get("cwd"),
    ...(form.get("port") ? { port: Number(form.get("port")) } : {}),
    ...(form.get("previewUrl") ? { previewUrl: form.get("previewUrl") } : {}),
    ...(readyCheck ? { readyCheck } : {}),
  };
}
