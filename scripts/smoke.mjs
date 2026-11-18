import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packagedExecutable = process.argv[2];
const executable = packagedExecutable
  ? resolve(packagedExecutable)
  : (await import("electron")).default;
const args = packagedExecutable ? [] : ["."];
const directory = await mkdtemp(join(tmpdir(), "devhub-smoke-"));
try {
  const child = spawn(executable, [...args, "--devhub-smoke-test"], {
    env: {
      ...process.env,
      DEVHUB_SMOKE_DIRECTORY: directory,
      DEVHUB_SMOKE_VITE: resolve("node_modules/vite/bin/vite.js"),
      DEVHUB_SMOKE_NODE: process.execPath,
    },
    stdio: "inherit",
    windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0)
      throw new Error(
        `DevHub smoke process exited with ${code ?? "a signal"}.`,
      );
    const port = JSON.parse(
      await readFile(join(directory, "preview-port.json"), "utf8"),
    );
    const alive = await new Promise((resolve) => {
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
    if (alive) throw new Error("Preview survived application shutdown");
    console.log("DevHub M3 application shutdown cleanup passed.");
  } finally {
    clearTimeout(timer);
  }
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
