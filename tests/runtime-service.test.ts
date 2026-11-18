import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../electron/main/database.ts";
import {
  DirectoryStore,
  resolveDirectory,
} from "../electron/main/directory-store.ts";
import { EnvironmentStore } from "../electron/main/environment-store.ts";
import { ProcessManager } from "../electron/main/process-manager.ts";
import { PreviewJournal } from "../electron/main/preview-log.ts";
import { RuntimeService, launchIde } from "../electron/main/runtime-service.ts";
import { prepareWebCommand } from "../electron/main/web-command-adapter.ts";
import { setTimeout as delay } from "node:timers/promises";

test(
  "runtime serializes consent, starts only confirmed current plans, inherits IDE settings and validates browser URLs",
  { skip: process.platform !== "win32", timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devhub-runtime-"));
    const project = join(root, "project with spaces");
    await mkdir(project);
    const workspace = openDatabase(join(root, "data"));
    const store = new DirectoryStore(workspace.database);
    const config = {
      adapter: "web-command" as const,
      command: process.execPath,
      args: [resolve("tests/fixtures/preview-server.cjs"), "idle"],
      cwd: ".",
      previewUrl: "http://127.0.0.1:5173/",
    };
    const id = store.add("project", await resolveDirectory(project), {
      name: "Runtime",
      description: "",
      projectType: "web",
      tags: [],
      previewConfig: config,
    });
    const environment = new EnvironmentStore(join(root, "data"), {
      encrypt: async (value) => Buffer.from(value),
      decrypt: async (value) => value.toString(),
    });
    const manager = new ProcessManager({
      host: resolve("dist/native/preview-host.exe"),
      launcher: resolve("dist/electron/preview-launcher.cjs"),
      executable: process.execPath,
      journal: new PreviewJournal(join(root, "logs")),
    });
    t.after(async () => {
      await manager.shutdown();
      workspace.database.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    let accepted = false,
      confirmations = 0,
      busy = false;
    let duringConfirm = async () => {};
    let browser = "",
      idePath = "";
    const service = new RuntimeService({
      database: workspace.database,
      store,
      environment,
      manager,
      directoryBusy: () => busy,
      confirm: async (plan) => {
        confirmations++;
        assert.equal(plan.cwd, project);
        await duringConfirm();
        return accepted;
      },
      openBrowser: async (url) => {
        browser = url;
      },
      selectIde: async () => null,
      openIde: async (_config, path) => {
        idePath = path;
      },
    });
    await service.execute({ action: "start", projectId: id });
    assert.equal(manager.get(id), null);
    assert.equal(confirmations, 1);
    accepted = true;
    const starts = await Promise.allSettled([
      service.execute({ action: "start", projectId: id }),
      service.execute({ action: "start", projectId: id }),
    ]);
    assert.equal(
      starts.filter((item) => item.status === "fulfilled").length,
      1,
    );
    assert.equal(confirmations, 2);
    const original = manager.get(id)!.id;
    accepted = false;
    await service.execute({ action: "restart", projectId: id });
    assert.equal(manager.get(id)!.id, original);
    assert.equal(manager.active(id), true);
    accepted = true;
    await service.execute({ action: "restart", projectId: id });
    assert.notEqual(manager.get(id)!.id, original);
    assert.equal(confirmations, 4);
    await service.execute({ action: "stop", projectId: id });
    const queued = await Promise.allSettled([
      service.execute({ action: "start", projectId: id }),
      service.execute({ action: "start", projectId: id }),
      service.execute({ action: "stop", projectId: id }),
    ]);
    assert.equal(queued[1].status, "rejected");
    assert.equal(queued[2].status, "fulfilled");
    assert.equal(manager.active(id), false);
    busy = true;
    await assert.rejects(
      service.execute({ action: "start", projectId: id }),
      /回收目录/,
    );
    busy = false;
    duringConfirm = async () => {
      workspace.database
        .prepare("UPDATE projects SET preview_config_json = ? WHERE id = ?")
        .run(
          JSON.stringify({ ...config, args: [...config.args, "changed"] }),
          id,
        );
    };
    await assert.rejects(
      service.execute({ action: "start", projectId: id }),
      /配置已改变/,
    );
    assert.equal(manager.active(id), false);
    await service.execute({
      action: "save-ide",
      config: { command: "global.exe", args: [] },
    });
    assert.deepEqual(
      await service.execute({ action: "ide-config", projectId: id }),
      { ide: { command: "global.exe", args: [] }, inherited: true },
    );
    await service.execute({
      action: "save-ide",
      projectId: id,
      config: { command: "override.exe", args: ["--window"] },
    });
    assert.equal(
      (await service.execute({ action: "ide-config", projectId: id })).ide
        ?.command,
      "override.exe",
    );
    await service.execute({ action: "open-ide", projectId: id });
    assert.equal(idePath, project);
    await service.execute({ action: "save-ide", projectId: id, config: null });
    assert.equal(
      (await service.execute({ action: "ide-config", projectId: id }))
        .inherited,
      true,
    );
    await service.execute({ action: "browser", projectId: id });
    assert.equal(browser, "http://127.0.0.1:5173/");
    for (const previewUrl of [
      "file:///C:/Windows/",
      "javascript:alert(1)",
      "https://user:pass@example.com",
    ]) {
      workspace.database
        .prepare("UPDATE projects SET preview_config_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...config, previewUrl }), id);
      await assert.rejects(
        service.execute({ action: "browser", projectId: id }),
      );
    }
    await assert.rejects(prepareWebCommand(project, { ...config, cwd: "../" }));
    const output = join(root, "ide-args.json"),
      script = join(root, "fake ide.cjs");
    await writeFile(
      script,
      `require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));`,
    );
    await launchIde(
      {
        command: process.execPath,
        args: [script, output, "--option with spaces"],
      },
      project,
    );
    for (let i = 0; i < 20; i++) {
      try {
        await readFile(output);
        break;
      } catch {
        await delay(50);
      }
    }
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), [
      "--option with spaces",
      project,
    ]);
  },
);
