    }
  };
  await walk(absDir);
  return result;
}

/** `push -r`：把本地目录树逐文件复用 `pushOneFile` 打包上传到镜像的云端子目录树下（去重/续传/锁与单文件 push 一致）。 */
async function cmdPushRecursive(
  rt: Runtime,
  dirPath: string,
  opts: CommonOpts & {
    chunk?: string;
    compress?: boolean;
    noSplit?: boolean;
    to?: string;
    force?: boolean;
    concurrency?: number;
  },
): Promise<string> {
  const mk = await rt.resolveMk(opts);
  const contentKey = deriveContentKey(mk);
  const absDir = resolve(dirPath);
  // 目录本身的缺省镜像位置：取"目录当作一个条目"时的父级镜像，再把目录名接回去。
  const baseCloud = opts.to
    ? normalizeCloudPath(opts.to)
    : defaultUploadCloudDir(absDir + sep, rt.fileRoot);
  const rootCloud = joinCloudPath(baseCloud, basename(absDir));
  const backend = await makeBackend(rt, opts.local, resolveUploadConcurrency(rt, opts.concurrency));
  if (rootCloud !== "/") await backend.mkdir(rootCloud);

  const files = await walkLocalFiles(absDir);
  if (files.length === 0) {
    info(`（空目录，无文件可上传）：${absDir}`);
    return rootCloud;
  }

  let uploaded = 0;
  let skipped = 0;
  for (const abs of files) {
    const rel = relative(absDir, abs);
    const relDir = dirname(rel);
    const cloudDir = relDir === "." ? rootCloud : joinCloudPath(rootCloud, relDir);
    info(`加密上传：${abs} → ${cloudDir}/${basename(abs)}`);
    const r = await pushOneFile(rt, backend, mk, contentKey, abs, cloudDir, opts);
    if (r.status === "skipped-dup") skipped++;
    else if (r.status === "locked") {
      /* 跳过，不计入上传 */
    } else uploaded++;
    if (r.status === "uploaded" || r.status === "resumed") ok(`已上传：${rel} → ${r.bundleId}`);
  }
  ok(
    `整树完成：上传 ${uploaded}，跳过（已存在）${skipped}，共 ${files.length} 个文件 → ${rootCloud}`,
  );
  return rootCloud;
}

