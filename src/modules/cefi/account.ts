// Account numbers and PINs: pure helpers, no I/O.

import { createHmac } from "node:crypto";
import { CEFI } from "../../config/cefi";

// --- account numbers -------------------------------------------------------
//
// Crockford base32 (no I, L, O, U), 16 characters = 80 random bits: easy to
// read out and type, impossible to guess. Stored canonical (uppercase, no
// separators) as the Better Auth username; shown grouped: K7Q2-9XMR-4TDA-WZ3P.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ACCOUNT_RE = new RegExp(`^[${ALPHABET}]{${CEFI.accountNumberLength}}$`);

export function generateAccountNumber(): string {
  // 256 is a multiple of 32, so `byte & 31` is uniform.
  const bytes = crypto.getRandomValues(new Uint8Array(CEFI.accountNumberLength));
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

// Accept what people type: any case, spaces/dashes, and the usual Crockford
// look-alikes (I/L → 1, O → 0).
export function normalizeAccountNumber(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export function isAccountNumber(canonical: string): boolean {
  return ACCOUNT_RE.test(canonical);
}

export function formatAccountNumber(canonical: string): string {
  return canonical.match(/.{1,4}/g)?.join("-") ?? canonical;
}

// Better Auth's user table requires an email; CeFi has none. A per-account
// placeholder under the reserved .invalid TLD (RFC 2606) can never receive mail.
export function placeholderEmail(canonical: string): string {
  return `${canonical.toLowerCase()}@account.cefi.invalid`;
}

// --- PINs ------------------------------------------------------------------

const PIN_RE = new RegExp(`^\\d{${CEFI.pinLength}}$`);

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_RE.test(pin);
}

// A 6-digit PIN has only a million values, and people reuse their bank PIN.
// HMAC it with a server-side pepper before the slow hash, so a leaked database
// alone can't be brute-forced offline. Changing the pepper invalidates every
// PIN, so it must stay stable (it lives in the GitHub environment).
function peppered(pin: string, pepper: string): string {
  return createHmac("sha256", pepper).update(pin).digest("base64");
}

// OWASP's argon2id baseline (19 MiB, 2 passes). Bun's default uses 64 MiB per
// hash, which a burst of sign-ins could turn into memory pressure inside the
// 512 MB container. verify() reads the parameters back from the hash.
const ARGON2 = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;

export function hashPin(pin: string, pepper: string): Promise<string> {
  return Bun.password.hash(peppered(pin, pepper), ARGON2);
}

export function verifyPin(pin: string, hash: string, pepper: string): Promise<boolean> {
  return Bun.password.verify(peppered(pin, pepper), hash);
}
