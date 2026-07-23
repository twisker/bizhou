import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  configPaths,
  defaultDownloadsDir,
  resolveFileRoot,
  resolveKeyRoot,
} from "../src/config/index.ts";

describe("密钥根 keyRoot", () => {
  test("BIZHOU_HOME 优先", () => {
    expect(resolveKeyRoot({ BIZHOU_HOME: "/x/y" }, "linux")).toBe("/x/y");
  });
  test("BIZHOU_CONFIG_DIR 弃用别名兜底", () => {
    expect(resolveKeyRoot({ BIZHOU_CONFIG_DIR: "/legacy" }, "linux")).toBe("/legacy");
  });
  test("默认 <home>/.bizhou（三平台一致）", () => {
    expect(resolveKeyRoot({ HOME: "/home/u" }, "linux")).toBe("/home/u/.bizhou");
    expect(resolveKeyRoot({ HOME: "/Users/u" }, "darwin")).toBe("/Users/u/.bizhou");
    // win32：断言用 join 计算，避免宿主机(POSIX)分隔符差异
    expect(resolveKeyRoot({ USERPROFILE: "C:\\Users\\u" }, "win32")).toBe(
      join("C:\\Users\\u", ".bizhou"),
    );
  });
});

describe("文件根 fileRoot", () => {
  test("默认 = 下载目录", () => {
    expect(defaultDownloadsDir({ HOME: "/home/u" }, "linux")).toBe("/home/u/Downloads");
    expect(defaultDownloadsDir({ USERPROFILE: "C:\\Users\\u" }, "win32")).toBe(
      join("C:\\Users\\u", "Downloads"),
    );
  });
  test("优先级 env > config.json > 默认", () => {
    expect(resolveFileRoot({ BIZHOU_FILE_ROOT: "/env", HOME: "/home/u" }, "linux", "/cfg")).toBe(
      "/env",
    );
    expect(resolveFileRoot({ HOME: "/home/u" }, "linux", "/cfg")).toBe("/cfg");
    expect(resolveFileRoot({ HOME: "/home/u" }, "linux", undefined)).toBe("/home/u/Downloads");
  });
});

describe("configPaths", () => {
  test("基于密钥根，含 config.json", () => {
    const p = configPaths({ BIZHOU_HOME: "/root" }, "linux");
    expect(p.dir).toBe("/root");
    expect(p.vault).toBe("/root/vault.json");
    expect(p.config).toBe("/root/config.json");
  });
});
