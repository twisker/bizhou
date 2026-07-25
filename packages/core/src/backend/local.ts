import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BUNDLE_SUFFIX } from "../bundle/index.ts";
import { assertNameSegment, cloudBasename, normalizeCloudPath } from "../cloudpath/index.ts";
import { LocalBundleStore } from "../store/index.ts";
import type { Backend, DirListing, TrashEntry } from "./index.ts";

/** 回收站根目录名（位于 baseDir 下，listDir 须忽略）。 */
const TRASH_DIR = ".trash";

/** 本地目录后端：baseDir 下用真实子目录还原云端树；bundle 为 <id>.bz 目录。 */
export class LocalBackend implements Backend {
  constructor(private readonly baseDir: string) {}

  private abs(cloudDir: string): string {
    const n = normalizeCloudPath(cloudDir);
    return n === "/" ? this.baseDir : join(this.baseDir, ...n.split("/").filter(Boolean));
  }

  private get trashRoot(): string {
    return join(this.baseDir, TRASH_DIR);
  }

  private trashMetaPath(entryId: string): string {
    assertNameSegment(entryId); // 防 entryId 含 ../ 逃逸 .trash（如 `bz trash rm ../../x`）
    return join(this.trashRoot, `${entryId}.json`);
  }

  private trashItemDir(entryId: string): string {
    assertNameSegment(entryId);
    return join(this.trashRoot, entryId);
  }

  private async readTrashEntry(entryId: string): Promise<TrashEntry> {
    const raw = await readFile(this.trashMetaPath(entryId), "utf8");
    return JSON.parse(raw) as TrashEntry;
  }

  async mkdir(cloudDir: string): Promise<void> {
    await mkdir(this.abs(cloudDir), { recursive: true });
  }

  async listDir(cloudDir: string): Promise<DirListing> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.abs(cloudDir), { withFileTypes: true });
    } catch {
      return { dirs: [], bundles: [] };
    }
    const dir = normalizeCloudPath(cloudDir);
    const dirs: string[] = [];
    const bundles: { id: string; dir: string }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === TRASH_DIR) continue;
      if (e.name.endsWith(BUNDLE_SUFFIX)) {
        bundles.push({ id: e.name.slice(0, -BUNDLE_SUFFIX.length), dir });
      } else {
        dirs.push(e.name);
      }
    }
    return { dirs, bundles };
  }

  bundleStore(bundleId: string, cloudDir: string): LocalBundleStore {
    return new LocalBundleStore(this.abs(cloudDir), bundleId);
  }

  async move(srcCloudPath: string, dstDir: string): Promise<void> {
    const base = cloudBasename(normalizeCloudPath(srcCloudPath));
    await mkdir(this.abs(dstDir), { recursive: true });
    await rename(this.abs(srcCloudPath), join(this.abs(dstDir), base));
  }

  async copy(srcCloudPath: string, dstDir: string): Promise<void> {
    const base = cloudBasename(normalizeCloudPath(srcCloudPath));
    await mkdir(this.abs(dstDir), { recursive: true });
    await cp(this.abs(srcCloudPath), join(this.abs(dstDir), base), { recursive: true });
  }

  async rename(srcCloudPath: string, newName: string): Promise<void> {
    assertNameSegment(newName);
    const absSrc = this.abs(srcCloudPath);
    await rename(absSrc, join(dirname(absSrc), newName));
  }

  async trashPath(cloudPath: string, deletedAt: string): Promise<void> {
    const originalPath = normalizeCloudPath(cloudPath);
    const name = cloudBasename(originalPath);
    const entryId = randomBytes(8).toString("hex");

    await mkdir(this.trashItemDir(entryId), { recursive: true });
    await rename(this.abs(originalPath), join(this.trashItemDir(entryId), name));

    const entry: TrashEntry = { entryId, name, originalPath, deletedAt };
    await writeFile(this.trashMetaPath(entryId), JSON.stringify(entry), "utf8");
  }

  async listTrash(): Promise<TrashEntry[]> {
    let files: string[];
    try {
      files = await readdir(this.trashRoot);
    } catch {
      return [];
    }
    const entries: TrashEntry[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      entries.push(await this.readTrashEntry(f.slice(0, -".json".length)));
    }
    return entries;
  }

  async restoreTrash(entryId: string): Promise<void> {
    const entry = await this.readTrashEntry(entryId);
    const absTarget = this.abs(entry.originalPath);
    await mkdir(dirname(absTarget), { recursive: true });
    await rename(join(this.trashItemDir(entryId), entry.name), absTarget);
    await rm(this.trashItemDir(entryId), { recursive: true, force: true });
    await rm(this.trashMetaPath(entryId), { force: true });
  }

  async deleteTrash(entryId: string): Promise<void> {
    await rm(this.trashItemDir(entryId), { recursive: true, force: true });
    await rm(this.trashMetaPath(entryId), { force: true });
  }

  async clearTrash(): Promise<void> {
    await rm(this.trashRoot, { recursive: true, force: true });
  }

  async putBlob(cloudPath: string, data: Buffer): Promise<void> {
    const abs = this.abs(cloudPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }

  async getBlob(cloudPath: string): Promise<Buffer | null> {
    try {
      return await readFile(this.abs(cloudPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err; // 其余（权限等）视为真实 IO 失败，如实抛出
    }
  }

  async removeBlob(cloudPath: string): Promise<void> {
    await rm(this.abs(cloudPath), { force: true }); // force：目标不存在时不抛错，幂等
  }
}
