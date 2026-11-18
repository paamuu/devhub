import { build } from "vite";
import { isBuiltin } from "node:module";

for (const [entry, fileName] of [
  ["electron/main/index.ts", "main.cjs"],
  ["electron/preload/index.ts", "preload.cjs"],
  ["electron/main/preview-launcher.ts", "preview-launcher.cjs"],
]) {
  await build({
    configFile: false,
    resolve: { conditions: ["node"], mainFields: ["module", "main"] },
    build: {
      outDir: "dist/electron",
      emptyOutDir: fileName === "main.cjs",
      lib: { entry, formats: ["cjs"], fileName: () => fileName },
      rolldownOptions: {
        external: (id) => id === "electron" || isBuiltin(id),
      },
    },
  });
}
