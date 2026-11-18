import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "win32")
  throw new Error("DevHub's preview host targets Windows.");
mkdirSync("dist/native", { recursive: true });
const compiler = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe",
);
execFileSync(
  compiler,
  [
    "/nologo",
    "/target:exe",
    "/optimize+",
    `/out:${resolve("dist/native/preview-host.exe")}`,
    resolve("electron/native/PreviewHost.cs"),
  ],
  { stdio: "inherit", windowsHide: true },
);
