import {
  app,
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  net,
  protocol,
  shell,
  safeStorage,
} from "electron";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  workspaceStatusChannel,
  previewEventChannel,
} from "../../shared/channels";
import type { WorkspaceStatus } from "../../shared/contracts";
import { openDatabase } from "./database";
import { registerDirectoryHandler } from "./directory-ipc";
import { DirectoryStore, resolveDirectory } from "./directory-store";
import { ProjectCreation } from "./project-creation";
import { registerCreationHandler } from "./creation-ipc";
import { recycleDirectory } from "./directory-trash";
import { EnvironmentStore } from "./environment-store";
import { PreviewJournal } from "./preview-log";
import { ProcessManager } from "./process-manager";
import { RuntimeService } from "./runtime-service";
import { registerRuntimeHandler, runtimeDialogs } from "./runtime-ipc";
import { smokeRuntime } from "./runtime-smoke";
import { GitService } from "./git-service";
import { gitDialogs, registerGitHandler } from "./git-ipc";
import { smokeGit } from "./git-smoke";
import { BackupStore } from "./backup-store";
import { registerBackupHandler } from "./backup-ipc";
import { maintenance } from "./maintenance";

const scheme = "devhub";
const entryUrl = `${scheme}://app/index.html`;
const isSmokeTest = process.argv.includes("--devhub-smoke-test");
const isolatedRoot = isSmokeTest
  ? process.env.DEVHUB_SMOKE_DIRECTORY
  : undefined;
let workspace: ReturnType<typeof openDatabase> | undefined;
let creation: ProjectCreation | undefined;
let manager: ProcessManager | undefined;
let runtime: RuntimeService | undefined;
let gitService: GitService | undefined;
let environment: EnvironmentStore | undefined;
let finishBackup: (() => Promise<void>) | undefined;
let shuttingDown = false;

if (isolatedRoot) app.setPath("userData", join(isolatedRoot, "electron-data"));

protocol.registerSchemesAsPrivileged([
  {
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

function registerRendererProtocol() {
  const root = resolve(__dirname, "../renderer");
  protocol.handle(scheme, async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.hostname !== "app") {
      return new Response(null, { status: 403 });
    }
    try {
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (
        !path.startsWith(`${root}${sep}`) ||
        ![".html", ".js", ".css"].includes(extname(path))
      ) {
        return new Response(null, { status: 404 });
      }
      const response = await net.fetch(pathToFileURL(path).href);
      if (path === join(root, "index.html")) {
        const headers = new Headers(response.headers);
        headers.set(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        );
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      }
      return response;
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

async function start() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing?.isMinimized()) existing.restore();
    existing?.focus();
  });
  if (isSmokeTest && !isolatedRoot) {
    throw new Error("Run the smoke test using scripts/smoke.mjs.");
  }
  registerRendererProtocol();
  const directory = join(isolatedRoot ?? homedir(), ".devhub");
  const backups = new BackupStore(directory);
  let startupMessage = "";
  try {
    startupMessage = (await backups.recover()) ?? (await backups.lastResult());
    workspace = openDatabase(directory);
    if (isSmokeTest) {
      const fixture = await resolveDirectory(directory);
      new DirectoryStore(workspace.database).add("project", fixture, {
        name: "DevHub smoke fixture",
        description: "",
        projectType: "web",
        tags: ["Smoke"],
      });
      workspace.database.close();
      workspace = undefined;
      workspace = openDatabase(directory);
    }
  } catch (error) {
    console.error("DevHub database initialization failed", error);
    if (isSmokeTest) throw error;
  }

  const window = new BrowserWindow({
    title: "DevHub",
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: "#f3f5f7",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: !isSmokeTest,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const trusted = (event: IpcMainInvokeEvent) =>
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame?.url === entryUrl;
  const isDirectoryMutation = registerDirectoryHandler(
    window,
    trusted,
    workspace && new DirectoryStore(workspace.database),
    [directory, app.getPath("userData"), app.getAppPath()],
    () => creation?.active ?? false,
    (id) => Boolean(manager?.busy(id) || gitService?.busy(id)),
    async (id) => {
      await runtime?.removeProject(id);
    },
  );
  creation = workspace && new ProjectCreation(workspace.database, directory);
  registerCreationHandler(window, trusted, creation, isDirectoryMutation);
  if (workspace) {
    try {
      const host = app.isPackaged
        ? join(process.resourcesPath, "preview-host.exe")
        : join(__dirname, "../native/preview-host.exe");
      const launcher = app.isPackaged
        ? join(process.resourcesPath, "preview-launcher.cjs")
        : join(__dirname, "preview-launcher.cjs");
      await promisify(execFile)(host, ["--protect-directory", directory], {
        windowsHide: true,
      });
      environment = new EnvironmentStore(directory, {
        encrypt: async (value) => {
          if (!(await safeStorage.isAsyncEncryptionAvailable()))
            throw new Error("Encryption unavailable");
          return safeStorage.encryptStringAsync(value);
        },
        decrypt: async (value) =>
          (await safeStorage.decryptStringAsync(value)).result,
      });
      await environment.prune(
        workspace.database
          .prepare("SELECT id FROM projects")
          .all()
          .map((row) => String(row.id)),
      );
      manager = new ProcessManager({
        host,
        launcher,
        executable: process.execPath,
        journal: new PreviewJournal(join(app.getPath("userData"), "logs")),
        notify: (session) => {
          if (!window.isDestroyed())
            window.webContents.send(previewEventChannel, session);
        },
      });
      runtime = new RuntimeService({
        database: workspace.database,
        store: new DirectoryStore(workspace.database),
        environment,
        manager,
        ...runtimeDialogs(window),
        ...(isSmokeTest
          ? {
              confirm: async (plan: { cwd: string }) =>
                Boolean(
                  isolatedRoot && plan.cwd.startsWith(isolatedRoot + sep),
                ),
            }
          : {}),
        directoryBusy: isDirectoryMutation,
      });
    } catch {
      console.error(
        "DevHub runtime initialization failed. Check local data permissions and system encryption.",
      );
      if (isSmokeTest) throw new Error("Runtime initialization failed");
    }
  }
  registerRuntimeHandler(trusted, runtime);
  if (workspace)
    gitService = new GitService({
      store: new DirectoryStore(workspace.database),
      ...gitDialogs(window),
      ...(isSmokeTest
        ? {
            confirm: async (plan: { root: string }) =>
              Boolean(isolatedRoot && plan.root.startsWith(isolatedRoot + sep)),
          }
        : {}),
      directoryBusy: isDirectoryMutation,
    });
  registerGitHandler(trusted, gitService);
  finishBackup = registerBackupHandler({
    window,
    trusted,
    store: backups,
    database: () => workspace?.database,
    environment: () => environment,
    creationActive: () => creation?.active ?? false,
    startupMessage,
    appVersion: app.getVersion(),
    close: async () => {
      await Promise.all([
        creation?.shutdown(),
        manager?.shutdown(),
        gitService?.shutdown(),
      ]);
      maintenance.seal();
      workspace?.database.close();
      workspace = undefined;
    },
    restart: () => {
      app.relaunch();
      app.quit();
    },
  });
  if (isSmokeTest && isolatedRoot && workspace && creation) {
    const fixture = join(isolatedRoot, "template-fixture");
    const parent = join(isolatedRoot, "projects-fixture");
    await mkdir(fixture);
    await mkdir(parent);
    await writeFile(join(fixture, "index.html"), "DevHub creation fixture");
    const template = new DirectoryStore(workspace.database).add(
      "template",
      await resolveDirectory(fixture),
      {
        name: "Smoke template",
        description: "",
        projectType: "web",
        tags: [],
        techStack: ["Lit", "TypeScript"],
        sourceUrl: "https://github.com/example/template.git",
        previewConfig: {
          adapter: "web-command",
          command: "npm.cmd",
          args: ["run", "dev"],
          cwd: ".",
        },
      },
    );
    const operation = creation.start(
      await creation.prepare(template, "Created smoke project", parent, true),
    );
    await creation.wait(operation);
    const result = creation.list().find((item) => item.id === operation);
    if (result?.state !== "completed")
      throw new Error(`Packaged project creation failed: ${result?.message}`);
    const recycleFixture = join(isolatedRoot, "recycle-fixture");
    await mkdir(recycleFixture);
    await writeFile(
      join(recycleFixture, "test.txt"),
      "DevHub disposable recycle test",
    );
    const store = new DirectoryStore(workspace.database);
    const recycleId = store.add(
      "project",
      await resolveDirectory(recycleFixture),
      {
        name: "Recycled smoke fixture",
        description: "",
        projectType: "other",
        tags: [],
      },
    );
    await recycleDirectory({
      store,
      kind: "project",
      id: recycleId,
      protectedPaths: [directory],
      confirm: async () => true,
      trash: (path) => shell.trashItem(path),
    });
    if (
      (await store.list("project")).find((entry) => entry.id === recycleId)
        ?.availability !== "missing"
    )
      throw new Error("Recycle test did not preserve a missing-path record.");
  }
  ipcMain.handle(workspaceStatusChannel, (event): WorkspaceStatus => {
    if (!trusted(event)) {
      return {
        ok: false,
        error: { code: "PERMISSION_DENIED", message: "请求来源无效。" },
      };
    }
    if (!workspace) {
      return {
        ok: false,
        error: {
          code: "DATABASE_ERROR",
          message: "无法打开 DevHub 数据库。请检查用户数据目录。",
        },
      };
    }
    return {
      ok: true,
      data: {
        databasePath: workspace.path,
        schemaVersion: workspace.schemaVersion,
      },
    };
  });

  await window.loadURL(entryUrl);
  if (isSmokeTest) {
    // Drive the rendered UI so the check crosses the sandboxed preload boundary.
    const rendered = await window.webContents.executeJavaScript(`
      (async () => {
        const deadline = Date.now() + 5000;
        let opened = false;
        while (Date.now() < deadline) {
          const app = document.querySelector('devhub-app');
          const status = app?.shadowRoot?.querySelector('[data-workspace-ready]');
          if (!opened && status?.textContent.includes('数据库已就绪')) {
            const projects = [...app.shadowRoot.querySelectorAll('nav button')].find(button => button.textContent.trim() === 'Projects');
            projects?.click();
            opened = true;
          }
          const library = app?.shadowRoot?.querySelector('devhub-directory-page');
          if (library?.shadowRoot?.textContent.includes('Created smoke project')) {
            const row = [...library.shadowRoot.querySelectorAll('li')].find(row => row.textContent.includes('Created smoke project'));
            const detail = [...(row?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === '查看详情');
            detail?.click();
            while (Date.now() < deadline) {
              const overview = library.shadowRoot.querySelector('.detail');
              if (overview?.textContent.includes('Smoke template') && overview.textContent.includes('npm.cmd')) return true;
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
      })()
    `);
    if (!rendered)
      throw new Error(
        "The renderer did not receive the database status and project listing through IPC.",
      );
    const edited = await window.webContents.executeJavaScript(`
      (async () => {
        const app = document.querySelector('devhub-app');
        const page = app.shadowRoot.querySelector('devhub-directory-page');
        const edit = [...page.shadowRoot.querySelectorAll('button')].find(button => button.textContent.trim() === '编辑');
        edit.click();
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const form = page.shadowRoot.querySelector('dialog[open] form');
          if (form) {
            form.querySelector('[name="description"]').value = 'Edited through Lit form';
            form.requestSubmit();
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        while (Date.now() < deadline) {
          if (!page.shadowRoot.querySelector('dialog') && page.shadowRoot.querySelector('.detail')?.textContent.includes('Edited through Lit form')) return true;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
      })()
    `);
    if (!edited)
      throw new Error(
        "The metadata editor did not persist its form through IPC.",
      );
    if (process.env.DEVHUB_SMOKE_SCREENSHOT) {
      await writeFile(
        process.env.DEVHUB_SMOKE_SCREENSHOT,
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    const dashboard = await window.webContents.executeJavaScript(`
      (async () => {
        const app = document.querySelector('devhub-app');
        [...app.shadowRoot.querySelectorAll('nav button')].find(button => button.textContent.trim() === 'Dashboard').click();
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const dashboard = app.shadowRoot.querySelector('devhub-dashboard');
          if (dashboard?.shadowRoot?.textContent.includes('Created smoke project') && dashboard.shadowRoot.textContent.includes('Smoke template')) return true;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
      })()
    `);
    if (!dashboard)
      throw new Error(
        "Dashboard did not show the recently opened project and used template.",
      );
    console.log(
      "DevHub M2 smoke check passed: copy, Git isolation, metadata detail, preview inheritance, Windows recycle bin, preload and SQLite reopen.",
    );
    if (!manager || !workspace || !isolatedRoot)
      throw new Error("Runtime was not initialized for smoke testing");
    await smokeRuntime(
      window,
      new DirectoryStore(workspace.database),
      manager,
      isolatedRoot,
    );
    await smokeGit(window, new DirectoryStore(workspace.database));
    if (!environment) throw new Error("Backup smoke environment unavailable");
    await window.webContents.executeJavaScript(
      `document.querySelector('devhub-app').shadowRoot.querySelectorAll('nav button')[3].click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const backupUI = await window.webContents.executeJavaScript(
      `document.querySelector('devhub-app').shadowRoot.querySelector('devhub-backup-settings')?.shadowRoot.textContent.includes('导出备份')`,
    );
    if (!backupUI) throw new Error("Backup settings did not render");
    if (process.env.DEVHUB_BACKUP_SMOKE_SCREENSHOT) {
      window.setContentSize(1000, 1200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(
        process.env.DEVHUB_BACKUP_SMOKE_SCREENSHOT,
        (
          await window.webContents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: true,
          })
        ).toPNG(),
      );
    }
    const backupPath = join(isolatedRoot, "smoke.devhub-backup");
    await backups.export(
      workspace.database,
      await environment.snapshot(),
      backupPath,
    );
    const prepared = await backups.prepare(backupPath);
    workspace.database
      .prepare("INSERT INTO app_settings VALUES('restore-smoke','true','now')")
      .run();
    await backups.restore(
      prepared,
      workspace.database,
      await environment.snapshot(),
      async () => {
        await Promise.all([
          creation?.shutdown(),
          manager?.shutdown(),
          gitService?.shutdown(),
        ]);
        workspace!.database.close();
        workspace = undefined;
      },
    );
    workspace = openDatabase(directory);
    if (
      workspace.database
        .prepare("SELECT key FROM app_settings WHERE key='restore-smoke'")
        .get()
    )
      throw new Error("Backup failed to replace metadata");
    if (
      !(await new DirectoryStore(workspace.database).list("project")).some(
        (entry) => entry.name === "Created smoke project",
      )
    )
      throw new Error("Restored project missing");
    await backups.discard(prepared);
    console.log(
      "DevHub M5 smoke passed: backup UI, SQLite snapshot, validated restore, stopped previews and reopened restored database.",
    );
    window.destroy();
    app.quit();
  } else {
    window.show();
  }
}

app.on("window-all-closed", () => {
  if (!isSmokeTest) app.quit();
});
app.on("will-quit", () => workspace?.database.close());
app.on("before-quit", (event) => {
  if (shuttingDown || (!creation && !manager && !gitService)) return;
  event.preventDefault();
  shuttingDown = true;
  void Promise.allSettled([
    finishBackup?.(),
    creation?.shutdown(),
    manager?.shutdown(),
    gitService?.shutdown(),
  ]).finally(() => app.quit());
});

void app
  .whenReady()
  .then(start)
  .catch((error) => {
    console.error(error);
    workspace?.database.close();
    app.exit(1);
  });
