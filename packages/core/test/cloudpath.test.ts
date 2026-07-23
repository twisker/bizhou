import { describe, expect, test } from "bun:test";
import {
  assertNameSegment,
  cloudBasename,
  cloudDirname,
  defaultUploadCloudDir,
  downloadLocalPath,
  joinCloudPath,
  normalizeCloudPath,
  splitCloudPath,
} from "../src/cloudpath/index.ts";
import { InvalidArgError } from "../src/errors.ts";
import { join, sep } from "node:path";

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

describe("上传/下载映射", () => {
  const fr = join(sep, "home", "u", "Downloads"); // 跨平台绝对根
  test("defaultUploadCloudDir：来源在文件根下→镜像父目录", () => {
    expect(defaultUploadCloudDir(join(fr, "工作", "报告.pdf"), fr)).toBe("/工作");
    expect(defaultUploadCloudDir(join(fr, "报告.pdf"), fr)).toBe("/"); // 直接在根下
    expect(defaultUploadCloudDir(join(fr, "工作", "2026", "a.bin"), fr)).toBe("/工作/2026");
  });
  test("defaultUploadCloudDir：来源在文件根外→云端根", () => {
    expect(defaultUploadCloudDir(join(sep, "tmp", "foo.pdf"), fr)).toBe("/");
  });
  test("downloadLocalPath：文件根 + 云端相对 + 名", () => {
    expect(downloadLocalPath(fr, "/工作/2026", "报告.pdf")).toBe(
      join(fr, "工作", "2026", "报告.pdf"),
    );
    expect(downloadLocalPath(fr, "/", "a.bin")).toBe(join(fr, "a.bin"));
  });
  test("downloadLocalPath：净化 name，防含 ../ 或分隔符的原文件名逃逸文件根", () => {
    expect(downloadLocalPath(fr, "/工作", "../../etc/passwd")).toBe(join(fr, "工作", "passwd"));
    expect(downloadLocalPath(fr, "/", "a\\b\\evil.bin")).toBe(join(fr, "evil.bin"));
  });
});

describe("assertNameSegment", () => {
  test("合法单段文件名不抛出", () => {
    expect(() => assertNameSegment("ok.bin")).not.toThrow();
    expect(() => assertNameSegment("a2")).not.toThrow();
  });

  test("非法名称抛出 InvalidArgError：路径穿越、分隔符、空", () => {
    expect(() => assertNameSegment("../x")).toThrow(InvalidArgError);
    expect(() => assertNameSegment("a/b")).toThrow(InvalidArgError);
    expect(() => assertNameSegment("a\\b")).toThrow(InvalidArgError);
    expect(() => assertNameSegment("..")).toThrow(InvalidArgError);
    expect(() => assertNameSegment("")).toThrow(InvalidArgError);
  });
});
