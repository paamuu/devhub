import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createConnection, createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import {
  previewConfigSchema,
  type PreviewConfig,
} from "../../shared/preview-config.ts";

export interface LaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  config: PreviewConfig;
}
export class PreviewError extends Error {}
export async function prepareWebCommand(
  projectPath: string,
  input: unknown,
): Promise<LaunchPlan> {
  const parsed = previewConfigSchema.safeParse(input);
  if (!parsed.success)
    throw new PreviewError("请先在项目资料中填写有效的预览配置。");
  const config = parsed.data;
  try {
    const root = await realpath(projectPath);
    const cwd = await realpath(resolve(root, config.cwd));
    const child = relative(root, cwd);
    if (
      child.startsWith("..") ||
      isAbsolute(child) ||
      !(await stat(cwd)).isDirectory()
    )
      throw new Error();
    return { command: config.command, args: config.args, cwd, config };
  } catch {
    throw new PreviewError("预览工作目录不可用，或位于项目目录之外。");
  }
}
async function canBind(port: number, host: string) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL"),
    );
    server.listen({ port, host, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}
export async function assertPortsAvailable(config: PreviewConfig) {
  const ports = new Set<number>();
  if (config.port) ports.add(config.port);
  if (config.readyCheck?.type === "tcp") ports.add(config.readyCheck.port);
  if (config.readyCheck?.type === "http") {
    const url = new URL(config.readyCheck.url);
    ports.add(Number(url.port || (url.protocol === "https:" ? 443 : 80)));
  }
  for (const port of ports) {
    if (!(await canBind(port, "127.0.0.1")) || !(await canBind(port, "::1")))
      throw new PreviewError(
        `端口 ${port} 已被占用，请调整配置或自行停止占用它的服务。`,
      );
  }
}
function tcpReady(port: number, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port, signal });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}
function httpReady(url: string, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    const request = (url.startsWith("https:") ? httpsRequest : httpRequest)(
      url,
      { method: "GET", signal },
      (response) => {
        const ok = Boolean(
          response.statusCode &&
          response.statusCode >= 200 &&
          response.statusCode < 300,
        );
        response.destroy();
        resolve(ok);
      },
    );
    request.once("error", () => resolve(false));
    request.setTimeout(1000, () => request.destroy());
    request.end();
  });
}
export async function waitUntilReady(
  check: NonNullable<PreviewConfig["readyCheck"]>,
  signal: AbortSignal,
) {
  const timeout = AbortSignal.timeout(check.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  while (!combined.aborted) {
    if (
      await (check.type === "http"
        ? httpReady(check.url, combined)
        : tcpReady(check.port, combined))
    )
      return true;
    await delay(150, undefined, { signal: combined }).catch(() => {});
  }
  return false;
}
