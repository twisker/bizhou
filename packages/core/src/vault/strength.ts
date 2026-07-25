/**
 * 主密码强度评估（纯函数，供 CLI 与 GUI 共用同一把尺子）。
 *
 * 为什么引擎里要有这个：v1.1.0 起 vault 会被加密上云，云服务商直接持有这份密文，
 * 可以离线、无频率限制地爆破。此时**主密码强度就是唯一的安全边界**——文件名不是，
 * 传输加密不是，产品闭源与否也不是。所以"够不够强"必须是上云路径上的硬关卡，
 * 而不是一句黄色小提示；把这把尺子放在引擎里，CLI 与自珍 GUI 才不会各判各的。
 *
 * 这不是 zxcvbn。本项目对加密路径要求零新增运行时依赖，因此这里是一个**保守的**
 * 估算器：它会低估某些强密码（可接受：用户加长即可），但对几类真正危险的模式
 * （重复、纯数字、常见弱口令基底、键盘序列）必须给出低分。宁可误杀，不可放行。
 */

/** 上云所需的最短长度。长度是唯一对用户可解释、且无法用花招绕开的下限。 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * 上云所需的最低估算熵（bit）。
 *
 * 定价依据：配合 `DEFAULT_SCRYPT`（N=2^17，128 MiB，内存硬），即便攻击者以专用硬件
 * 达到 10^4 次猜测/秒，60 bit 也意味着约 10^18 次猜测 ≈ 10^14 秒的期望代价。留足余量。
 */
export const MIN_PASSWORD_BITS = 60;

export interface PasswordStrength {
  /** 是否达到"可以把保险库放到别人机器上"的门槛。 */
  readonly ok: boolean;
  /** 保守的熵估算（bit）。仅供展示与判定，不是精确度量。 */
  readonly bits: number;
  /** 未达标的具体、可执行的原因；达标时为空数组。绝不回显密码本身。 */
  readonly reasons: readonly string[];
}

/**
 * 常见弱口令基底。命中判定要求"密码几乎就是这个词"（额外字符不超过 8 个），
 * 以免把恰好包含某个常见词的长口令误杀。
 */
const WEAK_BASES = [
  "password",
  "passwd",
  "qwerty",
  "qwertyuiop",
  "asdfgh",
  "zxcvbn",
  "123456",
  "12345678",
  "123123",
  "111111",
  "000000",
  "666666",
  "888888",
  "abc123",
  "iloveyou",
  "admin",
  "letmein",
  "welcome",
  "monkey",
  "dragon",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "master",
  "login",
  "freedom",
  "trustno1",
  "starwars",
  "woaini",
  "baidu",
  "wangpan",
  // 产品自身的名字是攻击者最先试的一批词
  "bizhou",
  "zizhen",
  "敝帚",
  "自珍",
];

/** 键盘序列与字母/数字顺序：出现长度 ≥4 的连续段就按"这段几乎没有熵"处理。 */
const SEQUENCES = [
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
];

function charPoolSize(chars: string[]): number {
  let pool = 0;
  if (chars.some((c) => c >= "a" && c <= "z")) pool += 26;
  if (chars.some((c) => c >= "A" && c <= "Z")) pool += 26;
  if (chars.some((c) => c >= "0" && c <= "9")) pool += 10;
  if (chars.some((c) => /[ -/:-@[-`{-~]/.test(c))) pool += 33; // ASCII 可打印符号与空格
  // 非 ASCII（中日韩等）：保守按 800 常用字计，约 9.6 bit/字。
  if (chars.some((c) => c.codePointAt(0)! > 127)) pool += 800;
  return pool;
}

/** 折叠连续重复字符（aaaa→a），并按"不重复字符占比"给一个上限，压掉低多样性口令。 */
function effectiveLength(chars: string[]): number {
  const squashed = chars.filter((c, i) => c !== chars[i - 1]).length;
  const unique = new Set(chars).size;
  return Math.min(squashed, unique * 2);
}

/** 连续序列（1234 / abcd / qwer）中超出 3 个字符的部分基本不贡献熵，予以扣减。 */
function sequencePenalty(lower: string): number {
  let penalty = 0;
  for (const seq of SEQUENCES) {
    const both = [seq, [...seq].reverse().join("")];
    for (const s of both) {
      for (let start = 0; start + 4 <= s.length; start++) {
        for (let len = s.length - start; len >= 4; len--) {
          if (lower.includes(s.slice(start, start + len))) {
            penalty += len - 3;
            start += len; // 同一段不重复计分
            break;
          }
        }
      }
    }
  }
  return penalty;
}

function hasWeakBase(lower: string): boolean {
  return WEAK_BASES.some((b) => lower.includes(b) && [...lower].length - [...b].length <= 8);
}

/**
 * 评估主密码强度。纯函数、无副作用、不记录也不回显密码。
 *
 * 注意：`bits` 是保守估算，不代表真实熵。判定以 `ok` 为准；`reasons` 直接面向用户展示。
 */
export function assessPasswordStrength(password: string): PasswordStrength {
  const chars = [...password];
  const lower = password.toLowerCase();
  const reasons: string[] = [];

  if (chars.length === 0) {
    return { ok: false, bits: 0, reasons: ["主密码不能为空"] };
  }
  if (chars.length < MIN_PASSWORD_LENGTH) {
    reasons.push(`太短：至少需要 ${MIN_PASSWORD_LENGTH} 个字符（当前 ${chars.length} 个）`);
  }

  const weakBase = hasWeakBase(lower);
  if (weakBase) {
    reasons.push("包含常见弱口令或与本产品相关的词，几乎必然出现在攻击者的字典里");
  }

  const pool = charPoolSize(chars);
  const effLen = Math.max(1, effectiveLength(chars) - sequencePenalty(lower));
  let bits = Math.round(effLen * Math.log2(pool));
  if (weakBase) bits = Math.min(bits, 20); // 命中字典 → 熵估算失去意义，直接压低

  if (bits < MIN_PASSWORD_BITS && !weakBase) {
    if (new Set(chars).size * 2 < chars.length) {
      reasons.push("重复字符太多，实际可猜空间远小于长度看上去的样子");
    }
    if (pool <= 10) {
      reasons.push("只有数字：请混入字母或符号，或改用更长的多词短语");
    }
    if (sequencePenalty(lower) > 0) {
      reasons.push("包含连续的键盘序列或字母/数字顺序（如 1234、abcd、qwer）");
    }
    reasons.push(
      `强度不足（估算约 ${bits} bit，需 ≥ ${MIN_PASSWORD_BITS} bit）：` +
        "推荐用四五个不相干的词组成的长短语，比塞满符号的短密码更强也更好记",
    );
  }

  return { ok: reasons.length === 0, bits, reasons };
}
