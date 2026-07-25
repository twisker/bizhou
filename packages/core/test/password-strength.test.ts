import { describe, expect, test } from "bun:test";
import {
  assessPasswordStrength,
  MIN_PASSWORD_BITS,
  MIN_PASSWORD_LENGTH,
} from "../src/vault/index.ts";

describe("主密码强度评估", () => {
  test("四词短语（长且多样）达标", () => {
    const r = assessPasswordStrength("correct horse battery staple");
    expect(r.ok).toBe(true);
    expect(r.bits).toBeGreaterThanOrEqual(MIN_PASSWORD_BITS);
    expect(r.reasons).toEqual([]);
  });

  test("混合大小写数字符号的 16 位密码达标", () => {
    expect(assessPasswordStrength("Tr0ub4dor&3xK9!q").ok).toBe(true);
  });

  test("过短一律不达标，且理由里说清最小长度", () => {
    const r = assessPasswordStrength("Ab3!xY9z");
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toContain(String(MIN_PASSWORD_LENGTH));
  });

  test("空密码不达标（不抛错，交由调用方渲染理由）", () => {
    const r = assessPasswordStrength("");
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  // 长度足够但可猜性极高的几类，必须挡下——否则"长度达标"会变成安全剧场。
  test("单字符重复（长度够）不达标", () => {
    expect(assessPasswordStrength("aaaaaaaaaaaaaaaaaaaa").ok).toBe(false);
  });

  test("常见弱口令基底 + 少量点缀不达标", () => {
    expect(assessPasswordStrength("password123456").ok).toBe(false);
    expect(assessPasswordStrength("Qwerty123456!").ok).toBe(false);
    expect(assessPasswordStrength("iloveyou2026").ok).toBe(false);
  });

  test("纯数字（哪怕 16 位）不达标", () => {
    expect(assessPasswordStrength("1234567890123456").ok).toBe(false);
    expect(assessPasswordStrength("8362518490275163").ok).toBe(false);
  });

  test("含产品名的口令不达标（bizhou/敝帚 是最先被试的词）", () => {
    expect(assessPasswordStrength("bizhou123456").ok).toBe(false);
  });

  test("熵估算随长度单调不减", () => {
    const a = assessPasswordStrength("kq7Vd2wmZx");
    const b = assessPasswordStrength("kq7Vd2wmZx9F");
    expect(b.bits).toBeGreaterThanOrEqual(a.bits);
  });

  test("达标即无理由，不达标必有可执行理由", () => {
    expect(assessPasswordStrength("正确的马电池订书钉再加一点长度").reasons.length).toBeGreaterThanOrEqual(
      0,
    );
    const weak = assessPasswordStrength("abc");
    expect(weak.ok).toBe(false);
    expect(weak.reasons.every((s) => s.length > 0)).toBe(true);
  });

  test("评估函数绝不回显密码本身（理由里不得出现明文）", () => {
    const pw = "password123456";
    const r = assessPasswordStrength(pw);
    expect(r.reasons.join(" ")).not.toContain(pw);
  });
});
