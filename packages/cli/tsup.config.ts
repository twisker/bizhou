import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node20",
  outDir: "dist",
  // 自包含：把 @bizhou/core 打进产物，便于 Homebrew/Scoop 单文件分发、node 直接运行。
  noExternal: ["@bizhou/core"],
});
