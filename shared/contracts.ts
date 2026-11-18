import { z } from "zod";
import type { CreationRequest, CreationResult } from "./creation";
import type { RuntimeRequest, RuntimeResult, PreviewSession } from "./runtime";
import type { GitRequest, GitResult } from "./git";
import type { BackupRequest, BackupResult } from "./backup";
import {
  previewConfigSchema,
  sourceUrlSchema,
  type PreviewConfig,
} from "./preview-config.ts";

export const workspaceStatusSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    data: z.object({
      databasePath: z.string(),
      schemaVersion: z.number().int().positive(),
    }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum(["DATABASE_ERROR", "PERMISSION_DENIED"]),
      message: z.string(),
    }),
  }),
]);

export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

export const directoryKind = z.enum(["template", "project"]);
export const projectType = z.enum(["web", "mini-program", "backend", "other"]);
export const directoryFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  projectType,
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  techStack: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  sourceUrl: sourceUrlSchema.optional(),
  previewConfig: previewConfigSchema.nullable().optional(),
});
const selection = z.uuid();
const target = { kind: directoryKind, id: z.uuid() };
export const directoryRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("select") }),
  z.object({ action: z.literal("list"), kind: directoryKind }),
  z.object({
    action: z.literal("add"),
    kind: directoryKind,
    selection,
    fields: directoryFields,
  }),
  z.object({ action: z.literal("edit"), ...target, fields: directoryFields }),
  z.object({ action: z.literal("relink"), ...target, selection }),
  z.object({ action: z.literal("remove"), ...target }),
  z.object({ action: z.literal("open"), ...target }),
  z.object({ action: z.literal("trash"), ...target }),
  z.object({ action: z.literal("detail"), ...target }),
  z.object({
    action: z.literal("archive"),
    id: z.uuid(),
    archived: z.boolean(),
  }),
]);
export type DirectoryRequest = z.infer<typeof directoryRequest>;
export type DirectoryFields = z.infer<typeof directoryFields>;
export type DirectoryKind = z.infer<typeof directoryKind>;
export type DirectoryEntry = DirectoryFields & {
  id: string;
  path: string;
  archivedAt: string | null;
  availability: "available" | "missing" | "unavailable";
  techStack: string[];
  sourceUrl: string;
  previewConfig: PreviewConfig | null;
  templateId: string | null;
  templateName: string | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastOpenedAt: string | null;
  lastUsedAt: string | null;
};
export type DirectoryResult =
  | {
      ok: true;
      data:
        | DirectoryEntry[]
        | {
            selection: string;
            path: string;
            name: string;
            suggested?: Partial<DirectoryFields>;
          }
        | null;
    }
  | { ok: false; error: { message: string } };

export interface DevHubAPI {
  backup(request: BackupRequest): Promise<BackupResult>;
  git(request: GitRequest): Promise<GitResult>;
  runtime(request: RuntimeRequest): Promise<RuntimeResult>;
  onPreview(callback: (session: PreviewSession) => void): () => void;
  creation(request: CreationRequest): Promise<CreationResult>;
  workspaceStatus(): Promise<WorkspaceStatus>;
  directory(request: DirectoryRequest): Promise<DirectoryResult>;
}
