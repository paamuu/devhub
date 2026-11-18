import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, createConnection } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessManager } from "../electron/main/process-manager.ts";
import { PreviewJournal } from "../electron/main/preview-log.ts";
import { prepareWebCommand } from "../electron/main/web-command-adapter.ts";

const windows = { skip: process.platform !== "win32", timeout: 30000 };
const host = resolve("dist/native/preview-host.exe"),
  launcher = resolve("dist/electron/preview-launcher.cjs"),
  serverFile = resolve("tests/fixtures/preview-server.cjs");
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
    socket.setTimeout(200, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
async function until(
  predicate: () => boolean | Promise<boolean>,
  message = "condition timed out",
) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail(message);
}
async function setup(t: { after: (action: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "devhub-preview-"));
  const journal = new PreviewJournal(join(directory, "logs"));
  const manager = new ProcessManager({
    host,
    launcher,
    executable: process.execPath,
    journal,
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const plan = async (
    mode: string,
    port: number,
    ready: "http" | "tcp" | "none" = "http",
    timeoutMs = 5000,
  ) =>
    prepareWebCommand(directory, {
      adapter: "web-command",
      command: process.execPath,
      args: [serverFile, mode, String(port), join(directory, `${port}.pid`)],
      cwd: ".",
      port,
      readyCheck:
        ready === "none"
          ? undefined
          : ready === "http"
            ? { type: "http", url: `http://127.0.0.1:${port}/`, timeoutMs }
            : { type: "tcp", port, timeoutMs },
    });
  return { directory, manager, journal, plan };
}
test(
  "Windows preview reaches HTTP/TCP readiness, redacts streamed secrets and stops separate project trees",
  windows,
  async (t) => {
    const { manager, directory, journal, plan } = await setup(t);
    const first = await freePort(),
      second = await freePort();
    const secret = "split-secret-" + Date.now();
    await manager.start(
      "first",
      await plan("server", first),
      { TEST_SECRET: secret },
      [secret],
    );
    await until(
      () => manager.get("first")?.ready === "ready",
      JSON.stringify(manager.get("first")),
    );
    await manager.start("second", await plan("server", second, "tcp"), {}, []);
    await until(() => manager.get("second")?.ready === "ready");
    await until(() =>
      manager
        .get("first")!
        .logs.some((entry) => entry.text.includes("[REDACTED]")),
    );
    assert.ok(!JSON.stringify(manager.list()).includes(secret));
    await journal.flush();
    assert.ok(
      !(await readFile(join(directory, "logs/preview.log"), "utf8")).includes(
        secret,
      ),
    );
    await assert.rejects(
      manager.start("first", await plan("server", first), {}, []),
      /已有运行/,
    );
    await manager.stop("first");
    assert.equal(manager.get("first")?.state, "stopped");
    assert.equal(await listening(first), false);
    assert.equal(await listening(second), true);
    await manager.shutdown();
    assert.equal(await listening(second), false);
  },
);
test(
  "port conflicts never terminate an existing service, readiness timeout cleans up, and missing commands fail",
  windows,
  async (t) => {
    const { manager, plan } = await setup(t);
    const port = await freePort();
    const external = createServer();
    await new Promise<void>((resolve) =>
      external.listen(port, "127.0.0.1", resolve),
    );
    try {
      await assert.rejects(
        manager.start("conflict", await plan("server", port), {}, []),
        /端口.*占用/,
      );
      assert.equal(await listening(port), true);
      assert.equal(manager.get("conflict"), null);
    } finally {
      await new Promise<void>((resolve) => external.close(() => resolve()));
    }
    await manager.start(
      "timeout",
      await plan("unready", port, "http", 700),
      {},
      [],
    );
    await until(() => manager.get("timeout")?.active === false);
    assert.equal(manager.get("timeout")?.state, "failed");
    assert.match(manager.get("timeout")!.message, /超时/);
    assert.equal(await listening(port), false);
    const missing = await plan("server", port);
    missing.command = "devhub-nonexistent-command-123456.exe";
    await manager.start("missing", missing, {}, []);
    await until(() => manager.get("missing")?.active === false);
    assert.equal(manager.get("missing")?.state, "failed");
  },
);
test(
  "unconfigured readiness stays distinct and an exiting launcher cannot leave an orphan server",
  windows,
  async (t) => {
    const { manager, plan } = await setup(t);
    const port = await freePort();
    await manager.start("plain", await plan("server", port, "none"), {}, []);
    await until(() => listening(port));
    assert.equal(manager.get("plain")?.ready, "unconfigured");
    await manager.stop("plain");
    await manager.start("orphan", await plan("orphan", port, "none"), {}, []);
    await until(() => manager.get("orphan")?.active === false);
    assert.equal(manager.get("orphan")?.state, "failed");
    assert.equal(await listening(port), false);
  },
);
test(
  "crashing the owning process closes its Job Object tree without using historical PIDs",
  windows,
  async () => {
    const port = await freePort();
    const owner = spawn(
      process.execPath,
      [
        resolve("tests/fixtures/preview-owner.cjs"),
        host,
        launcher,
        serverFile,
        String(port),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    try {
      await until(() => listening(port));
      owner.kill();
      await until(
        async () => !(await listening(port)),
        "preview survived owner crash",
      );
    } finally {
      owner.kill();
    }
  },
);
