// Account numbers, PINs and the PIN lockout (pure / in-memory).

import { describe, expect, test } from "bun:test";
import { CEFI } from "../../config/cefi";
import {
  formatAccountNumber,
  generateAccountNumber,
  hashPin,
  isAccountNumber,
  isValidPin,
  normalizeAccountNumber,
  verifyPin,
} from "../../modules/cefi/account";
import { PinLockout } from "../../modules/cefi/lockout";
import { MemoryStorage } from "../../modules/cefi/storage";

describe("account numbers", () => {
  test("16 Crockford base32 characters, all distinct across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const n = generateAccountNumber();
      expect(isAccountNumber(n)).toBe(true);
      expect(n).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
      seen.add(n);
    }
    expect(seen.size).toBe(2000);
  });

  test("typed input normalizes: case, spaces, dashes, I/L→1, O→0", () => {
    expect(normalizeAccountNumber("k7q2-9xmr 4tda-wz3p")).toBe("K7Q29XMR4TDAWZ3P");
    expect(normalizeAccountNumber("iL0o-0000-0000-0000")).toBe("1100000000000000");
    expect(isAccountNumber(normalizeAccountNumber("K7Q2-9XMR-4TDA-WZ3P"))).toBe(true);
    expect(isAccountNumber("K7Q29XMR4TDAWZ3")).toBe(false); // 15 chars
    expect(isAccountNumber("K7Q29XMR4TDAWZ3U")).toBe(false); // U isn't Crockford
  });

  test("formats in groups of four", () => {
    expect(formatAccountNumber("K7Q29XMR4TDAWZ3P")).toBe("K7Q2-9XMR-4TDA-WZ3P");
  });
});

describe("PINs", () => {
  test("exactly six digits", () => {
    expect(isValidPin("123456")).toBe(true);
    for (const bad of ["12345", "1234567", "12345a", " 123456", "１２３４５６", 123456, null]) {
      expect(isValidPin(bad)).toBe(false);
    }
  });

  test("argon2id over a peppered HMAC: the right pepper is required", async () => {
    const hash = await hashPin("123456", "pepper-a");
    expect(hash).toStartWith("$argon2id$");
    expect(hash).not.toContain("123456");
    expect(await verifyPin("123456", hash, "pepper-a")).toBe(true);
    expect(await verifyPin("654321", hash, "pepper-a")).toBe(false);
    expect(await verifyPin("123456", hash, "pepper-b")).toBe(false);
  });
});

describe("PinLockout", () => {
  test("locks after maxFailures, doubles each lock, success clears", async () => {
    const lockout = new PinLockout(new MemoryStorage());
    const fail = async (n: number) => {
      for (let i = 0; i < n; i++) await lockout.recordFailure("A");
    };

    await fail(CEFI.lockout.maxFailures - 1);
    expect(await lockout.lockedFor("A")).toBe(0);
    await fail(1);
    const first = await lockout.lockedFor("A");
    expect(first).toBeGreaterThan(CEFI.lockout.lockSeconds - 5);
    expect(first).toBeLessThanOrEqual(CEFI.lockout.lockSeconds);
    expect(await lockout.lockedFor("B")).toBe(0); // per account

    await fail(CEFI.lockout.maxFailures);
    expect(await lockout.lockedFor("A")).toBeGreaterThan(2 * CEFI.lockout.lockSeconds - 5);

    await lockout.recordSuccess("A");
    await fail(CEFI.lockout.maxFailures);
    // counters reset by the success: back to the first lock length
    expect(await lockout.lockedFor("A")).toBeLessThanOrEqual(CEFI.lockout.lockSeconds);
  });
});
