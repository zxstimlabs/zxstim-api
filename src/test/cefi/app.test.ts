// The CeFi API end to end, in process: real Better Auth + real Elysia app,
// in-memory SQLite (with this repo's migrations) and in-memory storage.

import { describe, expect, test } from "bun:test";
import { openCefiDb } from "../../modules/cefi/db";
import { CEFI } from "../../config/cefi";
import { normalizeAccountNumber } from "../../modules/cefi/account";
import { createCefiApp } from "../../modules/cefi/app";
import { createCefiAuth } from "../../modules/cefi/auth";
import { MemoryStorage } from "../../modules/cefi/storage";

const ORIGIN = "https://cefi.vn";
const PIN = "135790";
let ipSeq = 0;

function setup() {
  const { db } = openCefiDb(":memory:");
  const storage = new MemoryStorage();
  const origins = [...CEFI.origins];
  const auth = createCefiAuth({
    db,
    storage,
    secret: "test-secret-test-secret-test-secret-0000",
    pinPepper: "test-pepper-test-pepper-test-pepper-0000",
    baseURL: CEFI.baseURL,
    rpID: CEFI.rpID,
    origins,
  });
  const app = createCefiApp({ auth, storage, origins, healthy: async () => true });

  // One "client": its own IP and cookie jar.
  const client = (ip = `198.51.100.${++ipSeq}`) => {
    const jar = new Map<string, string>();
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const h = new Headers({ origin: ORIGIN, "x-real-ip": ip, ...headers });
      if (body !== undefined) h.set("content-type", "application/json");
      if (jar.size) h.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      const res = await app.handle(
        new Request(`${CEFI.baseURL}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
      );
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const [k, ...v] = pair!.split("=");
        const value = v.join("=");
        if (value === "" || /max-age=0/i.test(c)) jar.delete(k!);
        else jar.set(k!, value);
      }
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, headers: res.headers, json };
    };
    return { call, jar };
  };

  return { app, client };
}

async function newAccount(c: ReturnType<ReturnType<typeof setup>["client"]>, pin = PIN) {
  const r = await c.call("POST", "/accounts", { pin });
  expect(r.status).toBe(201);
  return r.json.accountNumber as string;
}

describe("CeFi accounts and sessions", () => {
  test("create → signed in; the number signs back in with the PIN (any case, dashes)", async () => {
    const { client } = setup();
    const c = client();
    const created = await c.call("POST", "/accounts", { pin: PIN });
    expect(created.status).toBe(201);
    expect(created.json).toEqual({ accountNumber: expect.stringMatching(/^([0-9A-HJKMNP-TV-Z]{4}-){3}[0-9A-HJKMNP-TV-Z]{4}$/) });
    expect(created.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(created.headers.get("access-control-allow-credentials")).toBe("true");
    expect([...c.jar.keys()].some((k) => k.includes("cefi.session_token"))).toBe(true);
    const number = created.json.accountNumber as string;

    const session = await c.call("GET", "/auth/get-session");
    expect(session.status).toBe(200);
    expect(session.json.user.username).toBe(normalizeAccountNumber(number));

    expect((await c.call("POST", "/auth/sign-out", {})).status).toBe(200);
    expect((await c.call("GET", "/auth/get-session")).json).toBeNull();

    const signedIn = await c.call("POST", "/auth/sign-in/username", { username: number.toLowerCase(), password: PIN });
    expect(signedIn.status).toBe(200);
    expect((await c.call("GET", "/auth/get-session")).json.user.username).toBe(normalizeAccountNumber(number));
  });

  test("wrong PINs lock PIN sign-in for that account, even with the right PIN", async () => {
    const { client } = setup();
    const number = await newAccount(client());
    const attacker = client();
    for (let i = 0; i < CEFI.lockout.maxFailures; i++) {
      expect((await attacker.call("POST", "/auth/sign-in/username", { username: number, password: "000000" })).status).toBe(401);
    }
    // a different IP with the right PIN: still locked (the lock is per account)
    const locked = await client().call("POST", "/auth/sign-in/username", { username: number, password: PIN });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("PINs must be exactly 6 digits: create, sign in, change", async () => {
    const { client } = setup();
    const c = client();
    for (const pin of ["12345", "1234567", "12345a"]) {
      expect((await c.call("POST", "/accounts", { pin })).status).toBe(400);
    }
    const number = await newAccount(c);
    expect((await c.call("POST", "/auth/sign-in/username", { username: number, password: "12345a" })).status).toBe(400);
    expect((await c.call("POST", "/auth/change-password", { currentPassword: PIN, newPassword: "abcdef" })).status).toBe(400);

    expect((await c.call("POST", "/auth/change-password", { currentPassword: PIN, newPassword: "246802" })).status).toBe(200);
    const other = client();
    expect((await other.call("POST", "/auth/sign-in/username", { username: number, password: PIN })).status).toBe(401);
    expect((await other.call("POST", "/auth/sign-in/username", { username: number, password: "246802" })).status).toBe(200);
  });

  test("only allowlisted auth endpoints are reachable", async () => {
    const { client } = setup();
    const c = client();
    for (const path of ["/auth/sign-up/email", "/auth/sign-in/email", "/auth/request-password-reset", "/auth/update-user", "/auth/delete-user"]) {
      expect((await c.call("POST", path, { email: "x@y.z", password: PIN, name: "x" })).status).toBe(404);
    }
    expect((await c.call("GET", "/auth/ok")).status).toBe(404);
  });

  test("account creation needs a CeFi origin, and is limited per IP", async () => {
    const { client } = setup();
    expect((await client().call("POST", "/accounts", { pin: PIN }, { origin: "https://evil.example" })).status).toBe(403);

    const sameIp = client("203.0.113.9");
    for (let i = 0; i < CEFI.signUpPerIp.max; i++) await newAccount(sameIp);
    const blocked = await sameIp.call("POST", "/accounts", { pin: PIN });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe(String(CEFI.signUpPerIp.windowSeconds));
  });

  test("CORS: credentialed for CeFi origins only", async () => {
    const { app } = setup();
    const preflight = (origin: string) =>
      app.handle(new Request(`${CEFI.baseURL}/auth/sign-in/username`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      }));
    for (const origin of CEFI.origins) {
      const ok = await preflight(origin);
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-origin")).toBe(origin);
      expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    }
    expect((await preflight("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
  });

  test("passkey registration: discoverable, biometric, bound to cefi.vn", async () => {
    const { client } = setup();
    const c = client();
    await newAccount(c);
    const opts = await c.call("GET", "/auth/passkey/generate-register-options");
    expect(opts.status).toBe(200);
    expect(opts.json.rp.id).toBe("cefi.vn");
    expect(opts.json.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });

    // not signed in → no registration
    expect((await client().call("GET", "/auth/passkey/generate-register-options")).status).toBe(401);
  });

  test("health", async () => {
    const { client } = setup();
    expect((await client().call("GET", "/health")).status).toBe(200);
  });
});
