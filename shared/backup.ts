import { z } from "zod";
export const backupRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("export") }),
  z.object({ action: z.literal("prepare") }),
  z.object({ action: z.literal("restore"), token: z.uuid() }),
  z.object({ action: z.literal("status") }),
]);
export type BackupRequest = z.infer<typeof backupRequest>;
export interface BackupPreview {
  token: string;
  createdAt: string;
  schemaVersion: number;
  templates: number;
  projects: number;
  missingPaths: number;
  secretReferences: number;
}
export type BackupResult =
  | {
      ok: true;
      data: {
        path?: string;
        preview?: BackupPreview;
        message?: string;
        restarting?: boolean;
      };
    }
  | { ok: false; error: { message: string } };
