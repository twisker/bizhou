import { describe, expect, test } from "bun:test";
import {
  cloudBasename,
  cloudDirname,
  joinCloudPath,
  normalizeCloudPath,
  splitCloudPath,
} from "../src/cloudpath/index.ts";

describe("normalizeCloudPath", () => {
  test("加前导斜杠、折叠、去尾", () => {
    expect(normalizeCloudPath("工作/2026/")).toBe("/工作/2026");
    expect(normalizeCloudPath("/a//b/")).toBe("/a/b");
    expect(normalizeCloudPath("")).toBe("/");
    expect(normalizeCloudPath("/")).toBe("/");
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
