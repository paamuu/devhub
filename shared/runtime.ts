import { z } from "zod";

export const environmentName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(128)
  .refine(
    (value) =>
      !["__PROTO__", "CONSTRUCTOR", "PROTOTYPE"].includes(
        value.toUpperCase(),
      ) &&
      !value.toUpperCase().startsWith("DEVHUB_") &&
      value.toUpperCase() !== "ELECTRON_RUN_AS_NODE",
  );
export const plainEnvironment = z
  .record(
    environmentName,
    z
      .string()
      .max(16000)
      .refine((value) => !value.includes("\0")),
  )
  .refine((value) => Object.keys(value).length <= 100);
export const ideConfigSchema = z
  .object({
    command: z.string().trim().min(1).max(1000),
    args: z.array(z.string().max(2000)).max(30),
  })
  .refine(
    (value) =>
      ![value.command, ...value.args].some((item) => /[\0\r\n]/.test(item)),
  );
const projectId = z.uuid();
export const runtimeRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), projectId }),
  z.object({ action: z.literal("sessions") }),
  z.object({ action: z.literal("start"), projectId }),
  z.object({ action: z.literal("stop"), projectId }),
  z.object({ action: z.literal("restart"), projectId }),
  z.object({ action: z.literal("browser"), projectId }),
  z.object({ action: z.literal("environment"), projectId }),
  z.object({
    action: z.literal("save-environment"),
    projectId,
    values: plainEnvironment,
  }),
  z.object({
    action: z.literal("set-secret"),
    projectId,
    name: environmentName,
    value: z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => !value.includes("\0")),
  }),
  z.object({
    action: z.literal("remove-secret"),
    projectId,
    name: environmentName,
  }),
  z.object({
    action: z.literal("ide-config"),
    projectId: projectId.optional(),
  }),
  z.object({
    action: z.literal("save-ide"),
    projectId: projectId.optional(),
    config: ideConfigSchema.nullable(),
  }),
  z.object({ action: z.literal("select-ide") }),
  z.object({ action: z.literal("open-ide"), projectId }),
]);
export type RuntimeRequest = z.infer<typeof runtimeRequest>;
export type IdeConfig = z.infer<typeof ideConfigSchema>;
export interface PreviewLog {
  sequence: number;
  time: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
}
export interface PreviewSession {
  id: string;
  projectId: string;
  revision: number;
  state: "starting" | "running" | "stopping" | "stopped" | "failed";
  ready: "unconfigured" | "checking" | "ready" | "failed";
  active: boolean;
  message: string;
  exitCode: number | null;
  startedAt: string;
  logs: PreviewLog[];
}
export interface EnvironmentView {
  values: Record<string, string>;
  secrets: { name: string; configured: boolean }[];
}
export interface RuntimeData {
  session?: PreviewSession | null;
  sessions?: PreviewSession[];
  environment?: EnvironmentView;
  ide?: IdeConfig | null;
  inherited?: boolean;
  executable?: string | null;
}
export type RuntimeResult =
  { ok: true; data: RuntimeData } | { ok: false; error: { message: string } };
