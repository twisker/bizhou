import { describe, expect, test } from "bun:test";
import { generateKey } from "../src/crypto/index.ts";
import { AuthError, ManifestError } from "../src/errors.ts";
import {
  bundleDirName,
  chunkAad,
  chunkFileName,
  generateBundleId,
  type Manifest,
  openMeta,
  parseManifest,
  sealMeta,
  serializeManifest,
} from "../src/bundle/index.ts";

function sampleManifest(overrides: Partial<Manifest> = {}): Manifest {
  const dek = generateKey();
  return {
    version: 1,
    bundleId: "abc123",
    createdAt: "2026-07-23T00:00:00.000Z",
    cipher: "AES-256-GCM",
    compression: "none",
    chunkSize: 104857600,
    wrappedKey: "d3JhcHBlZA==",
    chunks: [
      {
        seq: 0,
        file: "000.part",
        plainSize: 100,
        encSize: 128,
        iv: "aXY=",
        tag: "dGFn",
        sha256: "ab".repeat(32),
      },
    ],
    encMeta: sealMeta(dek, { name: "secret.pdf", size: 100 }),
    ...overrides,
  };
}

describe("bundle 命名", () => {
  test("bundleId 不透明、16 字节 hex、每次不同", () => {
    const a = generateBundleId();
    const b = generateBundleId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  test("bundleDirName / chunkFileName", () => {
    expect(bundleDirName("xyz")).toBe("xyz.bz");
    expect(chunkFileName(0)).toBe("000.part");
    expect(chunkFileName(42)).toBe("042.part");
    expect(chunkFileName(1234)).toBe("1234.part");
  });

  test("chunkAad 绑定 bundleId+seq", () => {
    expect(chunkAad("bid", 3).toString()).toBe("bid:3");
    expect(chunkAad("bid", 3).equals(chunkAad("bid", 4))).toBe(false);
  });
});

describe("encMeta（DEK 加密元数据）", () => {
  test("seal→open 往返，明文不含原文件名", () => {
    const dek = generateKey();
    const meta = { name: "私密报告.pdf", size: 2048, contentType: "application/pdf" };
    const encMeta = sealMeta(dek, meta);
    expect(encMeta).not.toContain("私密");
    expect(Buffer.from(encMeta, "base64").toString("utf8")).not.toContain("pdf");
    const back = openMeta(dek, encMeta);
    expect(back.name).toBe("私密报告.pdf");
    expect(back.size).toBe(2048);
  });

  test("错误 DEK 解 encMeta → AuthError", () => {
    const encMeta = sealMeta(generateKey(), { name: "x", size: 1 });
    expect(() => openMeta(generateKey(), encMeta)).toThrow(AuthError);
  });
});

describe("manifest 序列化/解析/校验", () => {
  test("serialize→parse 往返一致", () => {
    const m = sampleManifest();
    const back = parseManifest(serializeManifest(m));
    expect(back).toEqual(m);
  });

  test("带 preview 往返", () => {
    const m = sampleManifest({
      preview: { file: "preview.part", kind: "video", iv: "aXY=", tag: "dGFn" },
    });
    const back = parseManifest(serializeManifest(m));
    expect(back.preview?.kind).toBe("video");
  });

  test("非法 JSON → ManifestError", () => {
    expect(() => parseManifest("{not json")).toThrow(ManifestError);
  });

  test("错误 version → ManifestError", () => {
    const bad = serializeManifest(sampleManifest()).replace('"version": 1', '"version": 2');
    expect(() => parseManifest(bad)).toThrow(ManifestError);
  });

  test("不支持的 cipher → ManifestError", () => {
    const raw = JSON.parse(serializeManifest(sampleManifest()));
    raw.cipher = "AES-128-CBC";
    expect(() => parseManifest(JSON.stringify(raw))).toThrow(ManifestError);
  });

  test("缺少必需字段 → ManifestError", () => {
    const raw = JSON.parse(serializeManifest(sampleManifest()));
    delete raw.wrappedKey;
    expect(() => parseManifest(JSON.stringify(raw))).toThrow(ManifestError);
  });

  test("chunks seq 不连续 → ManifestError", () => {
    const raw = JSON.parse(serializeManifest(sampleManifest()));
    raw.chunks[0].seq = 5;
    expect(() => parseManifest(JSON.stringify(raw))).toThrow(ManifestError);
  });

  test("非法 preview.kind → ManifestError", () => {
    const raw = JSON.parse(serializeManifest(sampleManifest()));
    raw.preview = { file: "p", kind: "pdf", iv: "a", tag: "b" };
    expect(() => parseManifest(JSON.stringify(raw))).toThrow(ManifestError);
  });
});
