// CeFi simulator (cefi.vn) accounts and auth. Server-side only.
//
// CeFi is separate from the DeFi app: its own API (api.cefi.vn, a second
// listener in this process), its own users, no wallets. An account is a
// server-generated account number; users sign in with that number + a 6-digit
// PIN, or with a passkey. No email anywhere.

export const CEFI = {
  // Production web origins. Credentialed CORS and Better Auth's origin checks
  // allow exactly these (plus CEFI_EXTRA_ORIGINS for local dev).
  origins: ["https://cefi.vn", "https://sim.cefi.vn"],
  // Public URL of this API. Cookies are set for this host (same site as the
  // origins above, so SameSite=Lax cookies work without third-party cookies).
  baseURL: "https://api.cefi.vn",
  // Passkeys are bound to this domain: one passkey works on cefi.vn and every
  // subdomain (sim.cefi.vn today, cefi.vn after the move).
  rpID: "cefi.vn",
  rpName: "CeFi Simulator",

  accountNumberLength: 16, // Crockford base32: 80 random bits
  pinLength: 6,

  // Per-account PIN lockout: after `maxFailures` wrong PINs within
  // `failureWindowSeconds`, PIN sign-in is locked for `lockSeconds`, doubling
  // with each further lock up to `maxLockSeconds`. Passkey sign-in still works.
  lockout: {
    maxFailures: 5,
    failureWindowSeconds: 60 * 60,
    lockSeconds: 15 * 60,
    maxLockSeconds: 24 * 60 * 60,
  },

  // New accounts per client IP (no email means accounts are free to make).
  signUpPerIp: { max: 5, windowSeconds: 60 * 60 },

  sessionExpiresInSeconds: 30 * 24 * 60 * 60,
} as const;
