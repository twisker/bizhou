/**
 * 云端根目录下的**保留名**：引擎自用，不属于用户的文件树，各后端的 `listDir` 必须过滤掉。
 *
 * 单独成文件的原因：保留名同时被 backend（过滤）与 vault/cloud（写读保险库）使用，
 * 若放在任一侧都会造成 backend ↔ vault 的循环依赖。
 */

/** 回收站根目录名（LocalBackend 用真实目录实现；BaiduBackend 见 baidu.ts）。 */
export const TRASH_DIR = ".trash";

/**
 * 云端保险库的文件名（E-4「不透明命名」）。
 *
 * ⚠️ **这不是安全边界。** 引擎开源，这个常量对任何人可读，命名规则毫无秘密可言。
 * 不透明命名只做一件事：让"扫目录找 `vault.json` 这类显眼名字"的朴素模式匹配失效，
 * 降低被平台侧特征识别的概率。真正的保密性只来自内容——vault 本身就是密文信封，
 * 其强度由 scrypt 参数（`DEFAULT_SCRYPT`）与用户主密码强度决定，与文件名无关。
 *
 * ⚠️ **这个值一旦发布就不可再改。** 换机恢复靠"到固定路径去取"来发现保险库；
 * 改名等于让所有存量用户的云端保险库变成找不到的孤儿文件。
 */
export const CLOUD_VAULT_NAME = ".9c1f4a2e.dat";

/** 根目录下必须对用户隐藏的名字（无论它在云端是文件还是目录）。 */
export const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set([TRASH_DIR, CLOUD_VAULT_NAME]);
