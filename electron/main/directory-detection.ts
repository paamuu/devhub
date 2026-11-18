import { open } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import type { DirectoryFields } from "../../shared/contracts";
import { sourceUrlSchema } from "../../shared/preview-config.ts";
import { resolveDirectory } from "./directory-store.ts";

export async function detectDirectory(
  path: string,
): Promise<Partial<DirectoryFields>> {
  const suggested: Partial<DirectoryFields> = {};
  try {
    const file = await open(join(path, "package.json"), "r");
    try {
      if ((await file.stat()).size <= 256 * 1024) {
        const value: unknown = JSON.parse(await file.readFile("utf8"));
        if (value && typeof value === "object") {
          const pkg = value as Record<string, unknown>;
          if (typeof pkg.name === "string" && pkg.name.trim().length <= 120)
            suggested.name = pkg.name.trim();
          if (typeof pkg.description === "string")
            suggested.description = pkg.description.slice(0, 2000);
          const deps = {
            ...Object(pkg.dependencies),
            ...Object(pkg.devDependencies),
          };
          suggested.techStack = [
            "lit",
            "react",
            "vue",
            "vite",
            "typescript",
            "next",
            "express",
            "fastify",
          ].filter((name) => name in deps);
          suggested.projectType = ["lit", "react", "vue", "vite", "next"].some(
            (name) => name in deps,
          )
            ? "web"
            : "backend";
        }
      }
    } finally {
      await file.close();
    }
  } catch {
    /* Feature detection is optional for directories without package metadata. */
  }
  try {
    const git = simpleGit(path, { timeout: { block: 2000 } });
    const root = await resolveDirectory(
      (await git.revparse(["--show-toplevel"])).trim(),
    );
    if (root.key !== (await resolveDirectory(path)).key) return suggested;
    const remote = (await git.getRemotes(true)).find(
      (remote) => remote.name === "origin",
    );
    const url = sourceUrlSchema.safeParse(remote?.refs.fetch);
    if (url.success) suggested.sourceUrl = url.data;
  } catch {
    /* Import remains available when Git is absent. */
  }
  return suggested;
}
