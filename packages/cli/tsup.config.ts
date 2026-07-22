import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// 构建期从根 VERSION 注入版本号（发布产物无根 VERSION 文件可读）。
const here = dirname(fileURLToPath(import.meta.url));
const version = readFileSync(join(here, "..", "..", "VERSION"), "utf8").trim();

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node20",
  outDir: "dist",
  define: { __BZ_VERSION__: JSON.stringify(version) },
  // 自包含：把 @bizhou/core 打进产物，便于 Homebrew/Scoop 单文件分发、node 直接运行。
  noExternal: ["@bizhou/core"],
});
