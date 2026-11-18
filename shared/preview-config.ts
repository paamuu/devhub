import { z } from "zod";

const webUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, "请输入不含凭据的 HTTP 或 HTTPS 地址。");

export const previewConfigSchema = z.object({
  adapter: z.literal("web-command"),
  command: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .refine((value) => !/[\r\n\0]/.test(value)),
  args: z
    .array(
      z
        .string()
        .max(4000)
        .refine((value) => !value.includes("\0")),
    )
    .max(100),
  cwd: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .refine(
      (value) =>
        !/^(?:[a-z]:|[\\/])/i.test(value) &&
        !value.split(/[\\/]/).includes("..") &&
        !value.includes("\0"),
      "工作目录必须是项目内的相对路径。",
    ),
  port: z.number().int().min(1).max(65535).optional(),
  previewUrl: webUrl.optional(),
  readyCheck: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("http"),
        url: webUrl.refine((value) =>
          ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname),
        ),
        timeoutMs: z.number().int().min(100).max(600000),
      }),
      z.object({
        type: z.literal("tcp"),
        port: z.number().int().min(1).max(65535),
        timeoutMs: z.number().int().min(100).max(600000),
      }),
    ])
    .optional(),
});
export type PreviewConfig = z.infer<typeof previewConfigSchema>;

export const sourceUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    if (!value) return true;
    if (/^git@[a-z0-9.-]+:[\w./-]+$/i.test(value)) return true;
    try {
      const url = new URL(value);
      return (
        ["https:", "ssh:"].includes(url.protocol) &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (!url.username || (url.protocol === "ssh:" && url.username === "git"))
      );
    } catch {
      return false;
    }
  }, "来源地址支持无凭据的 HTTPS 或 Git SSH URL。");
