import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserWindow } from "electron";
import { DirectoryStore } from "./directory-store";
import { ProcessManager } from "./process-manager";
import type { RuntimeRequest, RuntimeResult } from "../../shared/runtime";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function listening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
export async function smokeRuntime(
  window: BrowserWindow,
  store: DirectoryStore,
  manager: ProcessManager,
  root: string,
) {
  const entry = (await store.list("project")).find(
    (entry) => entry.name === "Created smoke project",
  )!;
  const vite = process.env.DEVHUB_SMOKE_VITE;
  const node = process.env.DEVHUB_SMOKE_NODE;
  if (!vite || !node)
    throw new Error("Smoke requires external Node and installed Vite paths");
  const port = await freePort();
  const secret = "devhub-smoke-secret-" + Date.now();
  await writeFile(
    join(entry.path, "package.json"),
    JSON.stringify({ scripts: { dev: `node "${vite}"` } }),
  );
  await writeFile(
    join(entry.path, "vite.config.mjs"),
    `if(process.env.SMOKE_ORDINARY !== 'injected') throw new Error('Environment injection failed'); console.log(process.env.SMOKE_SECRET); export default {plugins:[{name:'smoke-health',configureServer(server){server.middlewares.use('/devhub-missing-health',(_req,res)=>{res.statusCode=503;res.end('not ready')})}}]};`,
  );
  const config = {
    adapter: "web-command" as const,
    command: "npm.cmd",
    args: [
      "run",
      "dev",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    cwd: ".",
    port,
    previewUrl: `http://127.0.0.1:${port}`,
    readyCheck: {
      type: "http" as const,
      url: `http://127.0.0.1:${port}`,
      timeoutMs: 10000,
    },
  };
  store.edit("project", entry.id, { ...entry, previewConfig: config });
  const call = async (request: RuntimeRequest) => {
    const result = (await window.webContents.executeJavaScript(
      `window.devhub.runtime(${JSON.stringify(request)})`,
    )) as RuntimeResult;
    if (!result.ok) throw new Error(result.error.message);
    assert.ok(!JSON.stringify(result).includes(secret), "IPC leaked a secret");
    return result.data;
  };
  await call({
    action: "save-environment",
    projectId: entry.id,
    values: { SMOKE_ORDINARY: "injected" },
  });
  await call({
    action: "set-secret",
    projectId: entry.id,
    name: "SMOKE_SECRET",
    value: secret,
  });
  assert.equal(
    (await call({ action: "environment", projectId: entry.id })).environment
      ?.secrets[0].configured,
    true,
  );
  assert.ok(
    !(await readFile(join(root, ".devhub/env.json"), "utf8")).includes(secret),
  );
  assert.ok(
    !(await readFile(join(root, ".devhub/secrets.enc"), "utf8")).includes(
      secret,
    ),
  );
  // Reload the project detail through navigation so it receives the saved configuration.
  await window.webContents.executeJavaScript(
    `document.querySelector('devhub-app').shadowRoot.querySelectorAll('nav button')[2].click()`,
  );
  const openDeadline = Date.now() + 5000;
  while (Date.now() < openDeadline) {
    const opened = await window.webContents.executeJavaScript(
      `(() => { const page = document.querySelector('devhub-app').shadowRoot.querySelector('devhub-directory-page'); const row = [...(page?.shadowRoot.querySelectorAll('li') ?? [])].find(row => row.textContent.includes('Created smoke project')); const button = [...(row?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === '查看详情'); button?.click(); return !!button; })()`,
    );
    if (opened) break;
    await delay(50);
  }
  await delay(150);
  const clicked = await window.webContents.executeJavaScript(
    `(() => { const panel = document.querySelector('devhub-app').shadowRoot.querySelector('devhub-directory-page').shadowRoot.querySelector('devhub-preview-panel'); const button = [...(panel?.shadowRoot.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === '启动预览'); if (!button || button.disabled) return false; button.click(); return true; })()`,
  );
  assert.equal(clicked, true, "Preview UI start button was not available");
  const waitReady = async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const session = manager.get(entry.id);
      if (session?.ready === "ready") return;
      if (session?.state === "failed") throw new Error(JSON.stringify(session));
      await delay(50);
    }
    throw new Error("Vite readiness timed out");
  };
  await waitReady();
  await delay(200);
  const ui = await window.webContents.executeJavaScript(
    `document.querySelector('devhub-app').shadowRoot.querySelector('devhub-directory-page').shadowRoot.querySelector('devhub-preview-panel').shadowRoot.textContent`,
  );
  assert.ok(
    ui.includes("服务已就绪") &&
      ui.includes("[REDACTED]") &&
      !ui.includes(secret),
  );
  const original = manager.get(entry.id)!.id;
  await call({ action: "restart", projectId: entry.id });
  await waitReady();
  assert.notEqual(manager.get(entry.id)!.id, original);
  const blocked = await window.webContents.executeJavaScript(
    `window.devhub.directory({action:'remove',kind:'project',id:${JSON.stringify(entry.id)}})`,
  );
  assert.equal(blocked.ok, false, "Active project could be removed");
  if (process.env.DEVHUB_SMOKE_SCREENSHOT) {
    await window.webContents.executeJavaScript(
      `document.querySelector('devhub-app').shadowRoot.querySelector('devhub-directory-page').shadowRoot.querySelector('devhub-preview-panel').scrollIntoView({block:'start'})`,
    );
    await delay(100);
    await writeFile(
      process.env.DEVHUB_SMOKE_SCREENSHOT,
      (await window.webContents.capturePage()).toPNG(),
    );
  }
  await call({ action: "stop", projectId: entry.id });
  assert.equal(await listening(port), false);
  const journal = await readFile(
    join(root, "electron-data/logs/preview.log"),
    "utf8",
  );
  assert.ok(
    journal.includes("[REDACTED]") && !journal.includes(secret),
    "Packaged journal did not persist redacted logs",
  );
  const occupied = createServer();
  await new Promise<void>((resolve) =>
    occupied.listen(port, "127.0.0.1", resolve),
  );
  try {
    const conflict = await window.webContents.executeJavaScript(
      `window.devhub.runtime({action:'start',projectId:${JSON.stringify(entry.id)}})`,
    );
    assert.equal(conflict.ok, false);
    assert.match(conflict.error.message, /端口.*占用/);
    assert.equal(await listening(port), true);
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
  store.edit("project", entry.id, {
    ...entry,
    previewConfig: {
      ...config,
      readyCheck: {
        ...config.readyCheck,
        url: `${config.previewUrl}/devhub-missing-health`,
        timeoutMs: 1200,
      },
    },
  });
  await call({ action: "start", projectId: entry.id });
  const timeoutDeadline = Date.now() + 10000;
  while (manager.active(entry.id) && Date.now() < timeoutDeadline)
    await delay(50);
  assert.equal(manager.get(entry.id)?.state, "failed");
  assert.match(manager.get(entry.id)!.message, /超时/);
  assert.equal(await listening(port), false);
  const ideScript = join(root, "fake ide.cjs"),
    ideOutput = join(root, "ide-result.json");
  await writeFile(
    ideScript,
    `require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))`,
  );
  await call({
    action: "save-ide",
    config: { command: node, args: [ideScript, ideOutput, "--new window"] },
  });
  await call({ action: "open-ide", projectId: entry.id });
  assert.deepEqual(JSON.parse(await readFile(ideOutput, "utf8")), [
    "--new window",
    entry.path,
  ]);
  store.edit("project", entry.id, { ...entry, previewConfig: config });
  await call({ action: "start", projectId: entry.id });
  await waitReady();
  await writeFile(join(root, "preview-port.json"), JSON.stringify(port));
  console.log(
    "DevHub M3 runtime smoke passed: real Vite via npm.cmd, encrypted secrets, IPC/UI, restart, conflict, timeout and IDE arguments.",
  );
}
