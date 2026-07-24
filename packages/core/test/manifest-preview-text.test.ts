import { describe, expect, test } from "bun:test";
import { parseManifest, serializeManifest, type Manifest } from "../src/bundle/index.ts";

function baseManifest(previewKind: string): Manifest {
  return {
    version: 1,
    bundleId: "abcd",
    createdAt: "2026-07-24T00:00:00Z",
    cipher: "AES-256-GCM",
    compression: "none",
    chunkSize: 100,
    wrappedKey: "wk",
    chunks: [],
    preview: { file: "preview.part", kind: previewKind as never, iv: "iv", tag: "tag" },
    encMeta: "em",
  };
}

describe("manifest preview kind=text", () => {
  test("kind:text 往返合法", () => {
    const json = serializeManifest(baseManifest("text"));
    const m = parseManifest(json);
    expect(m.preview?.kind).toBe("text");
  });

  test("非法 kind 仍抛", () => {
    expect(() => parseManifest(serializeManifest(baseManifest("bogus")))).toThrow();
  });
});
