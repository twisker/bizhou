import { describe, expect, test } from "bun:test";
import {
  cloudBasename,
  cloudDirname,
  joinCloudPath,
  normalizeCloudPath,
  splitCloudPath,
} from "../src/cloudpath/index.ts";
import { InvalidArgError } from "../src/errors.ts";

describe("normalizeCloudPath", () => {
  test("加前导斜杠、折叠、去尾", () => {
    expect(normalizeCloudPath("工作/2026/")).toBe("/工作/2026");
    expect(normalizeCloudPath("/a//b/")).toBe("/a/b");
    expect(normalizeCloudPath("")).toBe("/");
    expect(normalizeCloudPath("/")).toBe("/");
  });

  test("拒绝 '..' 段，杜绝路径穿越", () => {
    expect(() => normalizeCloudPath("/a/../b")).toThrow(InvalidArgError);
    expect(() => normalizeCloudPath("/工作/../../..")).toThrow(InvalidArgError);
    expect(() => joinCloudPath("/a", "..", "b")).toThrow(InvalidArgError);
  });

  test("反斜杠也按分隔符处理，防 Windows `\\..\\` 绕过", () => {
    expect(() => normalizeCloudPath("/a\\..\\etc")).toThrow(InvalidArgError);
    expect(normalizeCloudPath("/a\\b")).toBe("/a/b");
  });

  test("丢弃 '.' 段（当前目录，无害）", () => {
    expect(normalizeCloudPath("/a/./b")).toBe("/a/b");
  });
});

describe("join/dirname/basename/split", () => {
  test("join", () => {
    expect(joinCloudPath("/工作", "2026", "报告.pdf")).toBe("/工作/2026/报告.pdf");
    expect(joinCloudPath("/", "a")).toBe("/a");
  });
  test("dirname/basename", () => {
    expect(cloudDirname("/工作/2026/报告.pdf")).toBe("/工作/2026");
    expect(cloudBasename("/工作/2026/报告.pdf")).toBe("报告.pdf");
    expect(cloudDirname("/a")).toBe("/");
    expect(cloudBasename("/")).toBe("");
  });
  test("split", () => {
    expect(splitCloudPath("/工作/报告.pdf")).toEqual({ dir: "/工作", base: "报告.pdf" });
  });
});
