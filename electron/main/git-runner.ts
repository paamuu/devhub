import { simpleGit } from "simple-git";

export class GitServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export type GitRunner = (
  cwd: string,
  args: string[],
  signal: AbortSignal,
  emptyAllowed?: boolean,
) => Promise<string>;
export function createGitRunner(
  options: {
    binary?: string | [string, string];
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): GitRunner {
  return async (cwd, args, signal, emptyAllowed = false) => {
    if (signal.aborted)
      throw new GitServiceError(
        "CANCELLED",
        "Git 操作已取消，请刷新确认仓库当前状态。",
      );
    const controller = new AbortController();
    let tooLarge = false,
      timedOut = false,
      exitCode: number | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? 10000);
    const combined = AbortSignal.any([signal, controller.signal]);
    const allowed = [
      "PATH",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "TEMP",
      "TMP",
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "APPDATA",
      "LOCALAPPDATA",
      "PROGRAMFILES",
      "PROGRAMFILES(X86)",
    ];
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        allowed.includes(key.toUpperCase()),
      ),
    );
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
      LANG: "C",
    });
    let bytes = 0;
    try {
      const git = simpleGit(cwd, {
        binary: options.binary ?? "git",
        abort: combined,
        trimmed: false,
        strict: true,
        maxConcurrentProcesses: 1,
        config: ["core.fsmonitor=false"],
        allowConfig: ["core.fsmonitor"],
        allowEnvironment: ["GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS"],
        errors: (error, result) => {
          exitCode = result.exitCode;
          return error;
        },
      }).env(env);
      git.outputHandler((_command, stdout, stderr) => {
        for (const stream of [stdout, stderr])
          stream.on("data", (buffer: Buffer) => {
            bytes += buffer.length;
            if (bytes > (options.maxBytes ?? 2 * 1024 * 1024)) {
              tooLarge = true;
              controller.abort();
            }
          });
      });
      return await git.raw(["--no-pager", ...args]);
    } catch (error) {
      if (signal.aborted)
        throw new GitServiceError(
          "CANCELLED",
          "Git 操作已取消。如写入已开始，请刷新确认仓库当前状态。",
        );
      if (tooLarge)
        throw new GitServiceError(
          "OUTPUT_LIMIT",
          "Git 输出超过 2 MiB，请在外部检查大型工作树后重试。",
        );
      if (timedOut)
        throw new GitServiceError(
          "TIMEOUT",
          "Git 操作超时，已终止本次命令，请检查仓库后重试。",
        );
      if (emptyAllowed && exitCode === 1) return "";
      const message = error instanceof Error ? error.message : "";
      if (/ENOENT|not recognized|cannot find.*git/i.test(message))
        throw new GitServiceError(
          "GIT_MISSING",
          "未找到 Git，请安装 Git for Windows 并将其加入 PATH，然后重启 DevHub。",
        );
      if (/not a git repository/i.test(message))
        throw new GitServiceError(
          "NOT_REPOSITORY",
          "此目录尚未初始化 Git，请在外部初始化后重新检测。",
        );
      if (/dubious ownership|unsafe repository/i.test(message))
        throw new GitServiceError(
          "OWNERSHIP",
          "Git 拒绝访问此仓库，请在外部确认目录所有权和信任设置。",
        );
      if (/\.lock|another git process/i.test(message))
        throw new GitServiceError(
          "LOCKED",
          "Git 配置或索引正被其他进程锁定，请等待其结束后刷新。",
        );
      throw new GitServiceError(
        "GIT_FAILED",
        "Git 操作失败，请检查仓库权限与 Git 配置，刷新后重试。",
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
