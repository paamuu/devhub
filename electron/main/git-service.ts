import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  githubUrl,
  validRemoteUrl,
  remoteName,
  type GitData,
  type GitRepository,
  type GitRequest,
} from "../../shared/git.ts";
import { DirectoryStore, resolveDirectory } from "./directory-store.ts";
import {
  createGitRunner,
  GitServiceError,
  type GitRunner,
} from "./git-runner.ts";
import { parseGitStatus } from "./git-status.ts";

interface RawRemote {
  name: string;
  fetch: string[];
  push: string[];
}
interface Inspection {
  dto: GitRepository;
  identity: string;
  common: string;
  raw: RawRemote[];
}
export interface GitConfirmation {
  action: "add" | "update" | "remove";
  root: string;
  name: string;
  target?: "fetch" | "push";
  before: string[];
  url?: string;
}
interface Options {
  store: DirectoryStore;
  confirm(plan: GitConfirmation): Promise<boolean>;
  openBrowser(url: string): Promise<void>;
  directoryBusy(): boolean;
  runner?: GitRunner;
}
const safeUrl = (url: string) =>
  validRemoteUrl(url) ? url : "[地址已隐藏：含凭据或不支持的格式]";
const pathKey = (path: string) =>
  process.platform === "win32" ? path.toLowerCase() : path;
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return !path || (!path.startsWith("..") && !isAbsolute(path));
};
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    throw new GitServiceError("CANCELLED", "Git 操作已取消。");
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(
        new GitServiceError(
          "CANCELLED",
          "Git 操作已取消。如写入已开始，请刷新确认仓库当前状态。",
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class GitService {
  private readonly options: Options;
  private readonly run: GitRunner;
  private readonly jobs = new Map<
    string,
    {
      controller: AbortController;
      projectId?: string;
      paths: string[];
      done: Promise<void>;
    }
  >();
  private readonly locks = new Map<string, Promise<unknown>>();
  private closing = false;
  constructor(options: Options) {
    this.options = options;
    this.run = options.runner ?? createGitRunner();
  }
  busy(id: string) {
    const jobs = [...this.jobs.values()];
    if (jobs.some((job) => job.projectId === id)) return true;
    try {
      const path = this.options.store.require("project", id).path;
      return jobs.some((job) =>
        job.paths.some((target) => inside(path, target)),
      );
    } catch {
      return false;
    }
  }
  private async project(id: string) {
    const registered = this.options.store.require("project", id);
    const actual = await resolveDirectory(registered.path);
    if (registered.key !== actual.key)
      throw new GitServiceError(
        "PATH_CHANGED",
        "项目目录已发生变化，请重新关联后检查 Git。",
      );
    return actual;
  }
  private async inspect(
    path: string,
    signal: AbortSignal,
  ): Promise<Inspection> {
    const empty = (kind: "none" | "bare"): Inspection => ({
      identity: "",
      common: "",
      raw: [],
      dto: {
        kind,
        root: null,
        writable: false,
        revision: "0".repeat(64),
        remotes: [],
        status: null,
        checkedAt: new Date().toISOString(),
      },
    });
    try {
      if (
        (
          await this.run(path, ["rev-parse", "--is-bare-repository"], signal)
        ).trim() === "true"
      )
        return empty("bare");
    } catch (error) {
      if (error instanceof GitServiceError && error.code === "NOT_REPOSITORY")
        return empty("none");
      throw error;
    }
    const root = (
      await resolveDirectory(
        (await this.run(path, ["rev-parse", "--show-toplevel"], signal)).trim(),
      )
    ).path;
    const gitdir = await realpath(
      (
        await this.run(root, ["rev-parse", "--absolute-git-dir"], signal)
      ).trim(),
    );
    const common = await realpath(
      resolve(
        root,
        (
          await this.run(root, ["rev-parse", "--git-common-dir"], signal)
        ).trim(),
      ),
    );
    const identities = await Promise.all(
      [root, gitdir, common].map(async (path) => {
        const info = await stat(path);
        return [pathKey(path), info.dev, info.ino, info.birthtimeMs];
      }),
    );
    const identity = JSON.stringify(identities);
    const config = await this.run(
      root,
      ["config", "--null", "--get-regexp", "^remote\\."],
      signal,
      true,
    );
    const map = new Map<string, RawRemote>();
    for (const record of config.split("\0")) {
      const newline = record.indexOf("\n");
      if (newline < 0) continue;
      const match = /^remote\.(.+)\.(url|pushurl|fetch)$/.exec(
        record.slice(0, newline),
      );
      if (!match) continue;
      const remote = map.get(match[1]) ?? {
        name: match[1],
        fetch: [],
        push: [],
      };
      if (match[2] === "url") remote.fetch.push(record.slice(newline + 1));
      if (match[2] === "pushurl") remote.push.push(record.slice(newline + 1));
      map.set(remote.name, remote);
    }
    if (map.size > 100)
      throw new GitServiceError(
        "REMOTE_LIMIT",
        "仓库 Remote 超过 100 个，请在外部管理后重试。",
      );
    const raw = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    const revision = createHash("sha256")
      .update(identity + "\0" + config)
      .digest("hex");
    const status = parseGitStatus(
      await this.run(
        root,
        [
          "status",
          "--porcelain=v2",
          "--branch",
          "-z",
          "--untracked-files=normal",
          "--ignore-submodules=dirty",
        ],
        signal,
      ),
    );
    const writable = pathKey(root) === pathKey(path);
    return {
      identity,
      common,
      raw,
      dto: {
        kind: writable ? "repository" : "nested",
        root,
        writable,
        revision,
        status,
        checkedAt: new Date().toISOString(),
        remotes: raw.map((remote) => ({
          name: remote.name,
          fetch: remote.fetch.map(safeUrl),
          push: (remote.push.length ? remote.push : remote.fetch).map(safeUrl),
          explicitPush: remote.push.length > 0,
          editable: remoteName.safeParse(remote.name).success,
          browserUrl: githubUrl(remote.fetch[0] ?? ""),
        })),
      },
    };
  }
  private async locked<T>(
    key: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let started = false;
    const task = previous
      .catch(() => {})
      .then(async () => {
        if (signal.aborted)
          throw new GitServiceError("CANCELLED", "Git 操作已取消。");
        started = true;
        return work();
      });
    this.locks.set(key, task);
    void task
      .finally(() => {
        if (this.locks.get(key) === task) this.locks.delete(key);
      })
      .catch(() => {});
    try {
      return await abortable(task, signal);
    } catch (error) {
      // A cancellation must keep the directory busy until an already-running
      // Git process has closed. Queued commands have no process to await.
      if (started) await task.catch(() => {});
      throw error;
    }
  }
  async execute(request: GitRequest): Promise<GitData> {
    if (request.action === "cancel") {
      this.jobs.get(request.requestId)?.controller.abort();
      return { cancelled: true };
    }
    if (this.closing) throw new GitServiceError("CLOSING", "DevHub 正在退出。");
    if (this.jobs.has(request.requestId))
      throw new GitServiceError("DUPLICATE", "该 Git 请求正在执行。");
    if (this.jobs.size >= 16)
      throw new GitServiceError("BUSY", "Git 请求过多，请等待当前操作结束。");
    const controller = new AbortController();
    const signal = controller.signal;
    let finish!: () => void;
    const job = {
      controller,
      projectId: "projectId" in request ? request.projectId : undefined,
      paths: [] as string[],
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    this.jobs.set(request.requestId, job);
    try {
      if (request.action === "tools")
        return {
          version: (
            await this.run(process.cwd(), ["--version"], signal)
          ).trim(),
        };
      if (this.options.directoryBusy())
        throw new GitServiceError(
          "DIRECTORY_BUSY",
          "目录操作正在进行，请稍后重试。",
        );
      const project = await this.project(request.projectId);
      job.paths.push(project.path);
      const first = await this.inspect(project.path, signal);
      if (request.action === "inspect") return { repository: first.dto };
      if (!first.dto.root)
        throw new GitServiceError(
          "NOT_WORKTREE",
          "请在外部初始化 Git 工作树后重新检测。",
        );
      job.paths.push(first.common, first.dto.root);
      return await this.locked(pathKey(first.common), signal, async () => {
        const current = await this.inspect(
          (await this.project(request.projectId)).path,
          signal,
        );
        const verify = (value: Inspection) => {
          if (
            value.identity !== first.identity ||
            value.dto.revision !== request.revision
          )
            throw new GitServiceError(
              "STALE",
              "仓库或 Remote 已在外部发生变化，请刷新后重新操作。",
            );
        };
        verify(current);
        const remote = current.raw.find((item) => item.name === request.name);
        if (request.action === "open") {
          const url = githubUrl(remote?.fetch[0] ?? "");
          if (!url)
            throw new GitServiceError(
              "UNSUPPORTED_URL",
              "此 Remote 没有可安全打开的 GitHub.com 地址。",
            );
          await this.options.openBrowser(url);
          return { repository: current.dto };
        }
        if (!current.dto.writable)
          throw new GitServiceError(
            "NESTED_WORKTREE",
            "登记目录属于上级工作树，请登记实际工作树根目录后修改 Remote。",
          );
        if (request.action === "add" && remote)
          throw new GitServiceError(
            "REMOTE_EXISTS",
            "该 Remote 名称已存在，请刷新或更换名称。",
          );
        if (request.action !== "add" && !remote)
          throw new GitServiceError(
            "REMOTE_MISSING",
            "此 Remote 已不存在，请刷新。",
          );
        const before = remote
          ? (request.action === "update" && request.target === "push"
              ? remote.push
              : remote.fetch
            ).map(safeUrl)
          : [];
        const confirmed = await abortable(
          this.options.confirm({
            action: request.action,
            root: current.dto.root!,
            name: request.name,
            before,
            ...(request.action === "update" ? { target: request.target } : {}),
            ...(request.action !== "remove" ? { url: request.url } : {}),
          }),
          signal,
        );
        if (signal.aborted)
          throw new GitServiceError("CANCELLED", "Git 操作已取消。");
        if (!confirmed) return { repository: current.dto, cancelled: true };
        if (this.options.directoryBusy())
          throw new GitServiceError(
            "DIRECTORY_BUSY",
            "目录操作正在进行，请稍后重试。",
          );
        const fresh = await this.inspect(
          (await this.project(request.projectId)).path,
          signal,
        );
        verify(fresh);
        const root = fresh.dto.root!;
        if (request.action === "add")
          await this.run(
            root,
            ["remote", "add", "--", request.name, request.url],
            signal,
          );
        if (request.action === "remove")
          await this.run(
            root,
            ["remote", "remove", "--", request.name],
            signal,
          );
        if (request.action === "update") {
          const values =
            request.target === "push" ? remote!.push : remote!.fetch;
          // Without an old-url pattern Git refuses multi-valued URL settings.
          // Never put a credential-bearing old URL into a command argument.
          if (
            values.length > 1 &&
            (!validRemoteUrl(values[0]) ||
              values.filter((value) => value === values[0]).length > 1)
          )
            throw new GitServiceError(
              "AMBIGUOUS_URL",
              "此 Remote 的首个地址含敏感信息或重复，请先在外部整理多地址配置。",
            );
          const previous =
            values.length > 1
              ? [`^${values[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`]
              : [];
          await this.run(
            root,
            [
              "remote",
              "set-url",
              ...(request.target === "push" ? ["--push"] : []),
              "--",
              request.name,
              request.url,
              ...previous,
            ],
            signal,
          );
        }
        return { repository: (await this.inspect(root, signal)).dto };
      });
    } finally {
      this.jobs.delete(request.requestId);
      finish();
    }
  }
  async shutdown() {
    this.closing = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map((job) => job.done));
  }
}
