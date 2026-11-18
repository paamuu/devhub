import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative } from "node:path";
import {
  DirectoryError,
  DirectoryStore,
  resolveDirectory,
} from "./directory-store.ts";
import type { DirectoryKind } from "../../shared/contracts";

function within(parent: string, child: string) {
  const part = relative(parent, child);
  return (
    part === "" ||
    (!isAbsolute(part) &&
      part !== ".." &&
      !part.startsWith("..\\") &&
      !part.startsWith("../"))
  );
}

function overlaps(left: string, right: string) {
  return within(left, right) || within(right, left);
}

export async function inspectTrashTarget(
  store: DirectoryStore,
  kind: DirectoryKind,
  id: string,
  protectedPaths: string[],
) {
  const recorded = store.require(kind, id);
  const info = await lstat(recorded.path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new DirectoryError("目录身份已变化，请重新关联后操作。");
  const actual = await resolveDirectory(recorded.path);
  if (actual.key !== recorded.key)
    throw new DirectoryError("目录身份已变化，请重新关联后操作。");
  const home = await realpath(homedir());
  if (relative(parse(actual.path).root, actual.path) === "")
    throw new DirectoryError("不能回收磁盘根目录。");
  if (within(actual.path, home)) {
    // Ancestors of the user's home are protected as well.
    throw new DirectoryError("不能回收用户主目录或其父目录。");
  }
  for (const protectedPath of protectedPaths) {
    if (overlaps(actual.path, protectedPath))
      throw new DirectoryError(
        "该目录涉及应用、安装目录或正在使用的数据目录。",
      );
  }
  for (const entry of store.registeredPaths()) {
    if (entry.id === id) continue;
    let path = entry.local_path;
    try {
      path = await realpath(path);
    } catch {
      /* Missing registrations still reserve their paths. */
    }
    if (overlaps(actual.path, path))
      throw new DirectoryError(
        "此目录与其他已登记目录存在包含关系，请先处理相关登记。",
      );
  }
  return {
    path: actual.path,
    identity: `${info.dev}:${info.ino}:${info.birthtimeMs}`,
  };
}

export async function recycleDirectory(options: {
  store: DirectoryStore;
  kind: DirectoryKind;
  id: string;
  protectedPaths: string[];
  confirm: (path: string) => Promise<boolean>;
  trash: (path: string) => Promise<void>;
}) {
  const before = await inspectTrashTarget(
    options.store,
    options.kind,
    options.id,
    options.protectedPaths,
  );
  if (!(await options.confirm(before.path))) return;
  const after = await inspectTrashTarget(
    options.store,
    options.kind,
    options.id,
    options.protectedPaths,
  );
  if (after.path !== before.path || after.identity !== before.identity)
    throw new DirectoryError("确认期间目录已变化，操作已取消。");
  try {
    await options.trash(after.path);
  } catch {
    throw new DirectoryError(
      "移入回收站失败，登记记录已保留。请检查目录占用和权限。",
    );
  }
}
