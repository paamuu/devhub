import { z } from "zod";

export const remoteName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((name) => !name.includes("..") && !name.endsWith("."));
export function validRemoteUrl(value: string): boolean {
  if (!value || value.length > 2000 || /[\s\x00-\x1f\x7f]/.test(value))
    return false;
  if (/^git@[a-z0-9.-]+:[A-Za-z0-9_./~-]+$/i.test(value))
    return !value.split(":")[1].split("/").includes("..");
  try {
    const url = new URL(value);
    return (
      ["https:", "ssh:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!url.username || (url.protocol === "ssh:" && url.username === "git")) &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}
export const remoteUrl = z
  .string()
  .trim()
  .refine(
    validRemoteUrl,
    "请输入无凭据、查询参数或片段的 HTTPS / Git SSH 地址。",
  );
export function githubUrl(value: string): string | null {
  if (!validRemoteUrl(value)) return null;
  let path: string;
  if (value.startsWith("git@github.com:"))
    path = value.slice("git@github.com:".length);
  else {
    try {
      const url = new URL(value);
      if (url.hostname !== "github.com" || url.port) return null;
      path = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  const match = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
    path,
  );
  return match && ![".", ".."].includes(match[2])
    ? `https://github.com/${match[1]}/${match[2]}`
    : null;
}
const operation = { requestId: z.uuid(), projectId: z.uuid() };
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const gitRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tools"), requestId: z.uuid() }),
  z.object({ action: z.literal("inspect"), ...operation }),
  z.object({ action: z.literal("cancel"), requestId: z.uuid() }),
  z.object({
    action: z.literal("add"),
    ...operation,
    name: remoteName,
    url: remoteUrl,
    revision,
  }),
  z.object({
    action: z.literal("update"),
    ...operation,
    name: remoteName,
    url: remoteUrl,
    target: z.enum(["fetch", "push"]),
    revision,
  }),
  z.object({
    action: z.literal("remove"),
    ...operation,
    name: remoteName,
    revision,
  }),
  z.object({
    action: z.literal("open"),
    ...operation,
    name: z.string().min(1).max(200),
    revision,
  }),
]);
export type GitRequest = z.infer<typeof gitRequest>;
export interface GitRemote {
  name: string;
  fetch: string[];
  push: string[];
  explicitPush: boolean;
  editable: boolean;
  browserUrl: string | null;
}
export interface GitFile {
  path: string;
  originalPath?: string;
  index: string;
  worktree: string;
  conflict: boolean;
}
export interface GitStatus {
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  total: number;
  files: GitFile[];
  truncated: boolean;
}
export interface GitRepository {
  kind: "repository" | "nested" | "none" | "bare";
  root: string | null;
  writable: boolean;
  revision: string;
  remotes: GitRemote[];
  status: GitStatus | null;
  checkedAt: string;
}
export interface GitData {
  repository?: GitRepository;
  version?: string;
  cancelled?: boolean;
}
export type GitResult =
  | { ok: true; data: GitData }
  | { ok: false; error: { code: string; message: string } };
