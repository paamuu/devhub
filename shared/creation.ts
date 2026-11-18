import { z } from "zod";

export const folderName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (name) =>
      !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
      !/[. ]$/.test(name) &&
      name !== "." &&
      name !== ".." &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name),
    "请输入有效的 Windows 文件夹名称。",
  );
export const creationRequest = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    templateId: z.uuid(),
    name: folderName,
    initializeGit: z.boolean(),
  }),
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("cancel"), id: z.uuid() }),
  z.object({ action: z.literal("resume"), id: z.uuid() }),
]);
export type CreationRequest = z.infer<typeof creationRequest>;
export type CreationState =
  | "copying"
  | "publishing"
  | "registering"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";
export interface CreationOperation {
  id: string;
  name: string;
  target: string;
  temporary: string;
  state: CreationState;
  message: string;
  copied: number;
}
export type CreationResult =
  | { ok: true; data: CreationOperation[] }
  | { ok: false; error: { message: string } };

export const excludedNames = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
];
export const environmentExamples = [
  ".env.example",
  ".env.sample",
  ".env.template",
];
