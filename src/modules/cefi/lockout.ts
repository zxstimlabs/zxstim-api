// Per-account PIN lockout. Better Auth's rate limiter is per IP + path only; a
// 6-digit PIN also needs a cap per account, whatever IPs the guesses come from.
//
// After CEFI.lockout.maxFailures wrong PINs within the failure window, PIN
// sign-in for that account is locked for lockSeconds, doubling with each
// further lock (up to maxLockSeconds). A correct PIN clears the counters.
// Passkey sign-in is unaffected. Unknown account numbers are counted the same
// way, so responses don't reveal whether an account exists.

import { CEFI } from "../../config/cefi";
import type { CefiStorage } from "./storage";

type LockoutConfig = typeof CEFI.lockout;

export class PinLockout {
  constructor(
    private readonly storage: CefiStorage,
    private readonly cfg: LockoutConfig = CEFI.lockout,
  ) {}

  // Seconds until PIN sign-in unlocks for this account (0 = not locked).
  async lockedFor(account: string): Promise<number> {
    const until = Number(await this.storage.get(`pin-lock:${account}`));
    const left = Math.ceil((until - Date.now()) / 1000);
    return Number.isFinite(left) && left > 0 ? left : 0;
  }

  async recordFailure(account: string): Promise<void> {
    const failures = await this.storage.increment(`pin-fails:${account}`, this.cfg.failureWindowSeconds);
    if (failures < this.cfg.maxFailures) return;
    const locks = await this.storage.increment(`pin-locks:${account}`, this.cfg.maxLockSeconds);
    const seconds = Math.min(this.cfg.lockSeconds * 2 ** (locks - 1), this.cfg.maxLockSeconds);
    await this.storage.set(`pin-lock:${account}`, String(Date.now() + seconds * 1000), seconds);
    await this.storage.delete(`pin-fails:${account}`);
  }

  async recordSuccess(account: string): Promise<void> {
    await this.storage.delete(`pin-fails:${account}`);
    await this.storage.delete(`pin-locks:${account}`);
  }
}
