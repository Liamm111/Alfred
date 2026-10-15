import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError } from "../../src/auth/errors.js";
import { challengeS256, generateVerifier, isValidVerifier, verifyPkce } from "../../src/auth/pkce.js";
import { isAcceptableRedirectUri } from "../../src/auth/product-auth.js";
import { CLIENT, REDIRECT, login, mkEnv, type Env } from "./env.js";

let env: Env;
beforeAll(async () => (env = await mkEnv()));
afterAll(() => env.db.end());

const code = (e: unknown) => (e as AuthError).code;
async function rejects(p: Promise<unknown>) {
  try { await p; } catch (e) { return e as AuthError; }
  throw new Error("expected rejection");
}
async function issue(ownerId: string, verifier = generateVerifier(), redirectUri = REDIRECT) {
  const c = await env.auth.issueCode({ ownerId, clientId: CLIENT, redirectUri, codeChallenge: challengeS256(verifier), codeChallengeMethod: "S256" });
  return { c, verifier };
}

describe("PKCE primitives", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(challengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("generates valid, unique verifiers; rejects short/odd ones", () => {
    const a = generateVerifier(), b = generateVerifier();
    expect(a).not.toBe(b);
    expect(isValidVerifier(a)).toBe(true);
    for (const bad of ["short", "a".repeat(129), "has space " + "a".repeat(40), 5, null, undefined]) expect(isValidVerifier(bad)).toBe(false);
    expect(verifyPkce("short", challengeS256(a))).toBe(false);
  });
  it("redirect URI policy: https, loopback IP, reverse-DNS scheme only", () => {
    for (const ok of ["https://app.example.com/cb", "http://127.0.0.1:5000/cb", "http://[::1]:5000/cb", "com.alfred.app:/cb"]) expect(isAcceptableRedirectUri(ok), ok).toBe(true);
    for (const bad of ["http://evil.example.com/cb", "http://localhost/cb", "javascript:alert(1)", "alfred:/cb", "https://a.com/cb#frag", "not a url"]) expect(isAcceptableRedirectUri(bad), bad).toBe(false);
  });
});

describe("authorization code + PKCE", () => {
  it("happy path: code -> tokens -> authenticate", async () => {
    const owner = await env.auth.resolveUser("idp", "alice");
    const { c, verifier } = await issue(owner);
    const t = await env.auth.exchangeCode({ code: c, codeVerifier: verifier, clientId: CLIENT, redirectUri: REDIRECT });
    expect(t.token_type).toBe("Bearer");
    expect(t.expires_in).toBe(600);
    const p = await env.auth.authenticate(t.access_token);
    expect(p.ownerId).toBe(owner);
  });

  it("refuses PKCE `plain`, bad challenge, unknown client, unregistered redirect", async () => {
    const owner = await env.auth.resolveUser("idp", "bob");
    const ch = challengeS256(generateVerifier());
    expect(code(await rejects(env.auth.issueCode({ ownerId: owner, clientId: CLIENT, redirectUri: REDIRECT, codeChallenge: ch, codeChallengeMethod: "plain" })))).toBe("invalid_request");
    expect(code(await rejects(env.auth.issueCode({ ownerId: owner, clientId: CLIENT, redirectUri: REDIRECT, codeChallenge: "short", codeChallengeMethod: "S256" })))).toBe("invalid_request");
    expect(code(await rejects(env.auth.issueCode({ ownerId: owner, clientId: "nope", redirectUri: REDIRECT, codeChallenge: ch, codeChallengeMethod: "S256" })))).toBe("invalid_client");
    expect(code(await rejects(env.auth.issueCode({ ownerId: owner, clientId: CLIENT, redirectUri: "https://evil.example/cb", codeChallenge: ch, codeChallengeMethod: "S256" })))).toBe("invalid_request");
  });

  it("an intercepted code is useless without the verifier, and a wrong guess burns it", async () => {
    const owner = await env.auth.resolveUser("idp", "carol");
    const { c, verifier } = await issue(owner);
    const attacker = generateVerifier();
    expect(code(await rejects(env.auth.exchangeCode({ code: c, codeVerifier: attacker, clientId: CLIENT, redirectUri: REDIRECT })))).toBe("invalid_grant");
    // even the legitimate client can not use it any more: the code was burnt
    expect(code(await rejects(env.auth.exchangeCode({ code: c, codeVerifier: verifier, clientId: CLIENT, redirectUri: REDIRECT })))).toBe("invalid_grant");
  });

  it("code replay fails AND revokes the session created by the first exchange", async () => {
    const owner = await env.auth.resolveUser("idp", "dave");
    const { c, verifier } = await issue(owner);
    const t = await env.auth.exchangeCode({ code: c, codeVerifier: verifier, clientId: CLIENT, redirectUri: REDIRECT });
    await env.auth.authenticate(t.access_token);
    expect(code(await rejects(env.auth.exchangeCode({ code: c, codeVerifier: verifier, clientId: CLIENT, redirectUri: REDIRECT })))).toBe("invalid_grant");
    expect(code(await rejects(env.auth.authenticate(t.access_token)))).toBe("unauthorized");
    expect(code(await rejects(env.auth.refresh({ refreshToken: t.refresh_token, clientId: CLIENT })))).toBe("invalid_grant");
  });

  it("concurrent exchanges of one code: exactly one wins", async () => {
    const owner = await env.auth.resolveUser("idp", "erin");
    const { c, verifier } = await issue(owner);
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => env.auth.exchangeCode({ code: c, codeVerifier: verifier, clientId: CLIENT, redirectUri: REDIRECT })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });

  it("expired code, wrong redirect, wrong client are refused", async () => {
    const owner = await env.auth.resolveUser("idp", "frank");
    let { c, verifier } = await issue(owner);
    env.clock.advance(61_000);
    expect(code(await rejects(env.auth.exchangeCode({ code: c, codeVerifier: verifier, clientId: CLIENT, redirectUri: REDIRECT })))).toBe("invalid_grant");
    ({ c, verifier } = await issue(owner));
    expect(code(await rejects(env.auth.exchangeCode({ code: c, codeVerifier: verifier, clientId: CLIENT, redirectUri: "http://127.0.0.1:53682/cb" })))).toBe("invalid_grant");
    ({ c, verifier } = await issue(owner));
    expect(code(await rejects(env.auth.exchangeCode({ code: c, codeVerifier: verifier, clientId: "other", redirectUri: REDIRECT })))).toBe("invalid_grant");
    expect(code(await rejects(env.auth.exchangeCode({ code: "garbage", codeVerifier: verifier, clientId: CLIENT, redirectUri: REDIRECT })))).toBe("invalid_grant");
  });

  it("a user is created once per IdP subject, even under a creation race", async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => env.auth.resolveUser("idp", "race-subject")));
    expect(new Set(ids).size).toBe(1);
    expect((await env.db.query("select count(*)::int c from identities where subject='race-subject'")).rows[0].c).toBe(1);
  });
});

describe("storage hygiene", () => {
  it("no token, code or verifier is stored in clear", async () => {
    const { tokens } = await login(env);
    for (const table of ["access_tokens", "refresh_tokens", "auth_codes", "auth_sessions"]) {
      const dump = JSON.stringify((await env.db.query(`select * from ${table}`)).rows);
      expect(dump, table).not.toContain(tokens.access_token);
      expect(dump, table).not.toContain(tokens.refresh_token);
    }
  });
});

describe("renewable session", () => {
  it("access token expires; refresh rotates; old refresh token is dead", async () => {
    const { tokens } = await login(env);
    env.clock.advance(601_000);
    expect(code(await rejects(env.auth.authenticate(tokens.access_token)))).toBe("unauthorized");
    const t2 = await env.auth.refresh({ refreshToken: tokens.refresh_token, clientId: CLIENT });
    expect(t2.refresh_token).not.toBe(tokens.refresh_token);
    expect((await env.auth.authenticate(t2.access_token)).sessionId).toBe(tokens.session_id);
    expect(code(await rejects(env.auth.authenticate(tokens.access_token)))).toBe("unauthorized");
  });

  it("refresh token reuse (theft) revokes the whole session, including the legitimate new tokens", async () => {
    const { tokens } = await login(env);
    const t2 = await env.auth.refresh({ refreshToken: tokens.refresh_token, clientId: CLIENT });
    expect(code(await rejects(env.auth.refresh({ refreshToken: tokens.refresh_token, clientId: CLIENT })))).toBe("reuse_detected");
    expect(code(await rejects(env.auth.authenticate(t2.access_token)))).toBe("unauthorized");
    expect(code(await rejects(env.auth.refresh({ refreshToken: t2.refresh_token, clientId: CLIENT })))).toBe("invalid_grant");
  });

  it("concurrent refresh with the same token: one success, the others detect reuse and kill the session", async () => {
    const { tokens } = await login(env);
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => env.auth.refresh({ refreshToken: tokens.refresh_token, clientId: CLIENT })));
    const ok = r.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof env.auth.refresh>>> => x.status === "fulfilled");
    expect(ok).toHaveLength(1);
    const losers = r.filter((y) => y.status === "rejected").map((x) => code((x as PromiseRejectedResult).reason));
    expect(losers).toHaveLength(4);
    expect(losers).toContain("reuse_detected"); // the first loser trips the alarm and revokes the session...
    for (const c of losers) expect(["reuse_detected", "invalid_grant"]).toContain(c); // ...later ones find it already revoked
    expect(code(await rejects(env.auth.authenticate(ok[0]!.value.access_token)))).toBe("unauthorized");
  });

  it("serial refresh chain works for many rotations", async () => {
    let t = (await login(env)).tokens;
    for (let i = 0; i < 5; i++) t = await env.auth.refresh({ refreshToken: t.refresh_token, clientId: CLIENT });
    await env.auth.authenticate(t.access_token);
  });

  it("refresh token expires after 30 days; the login session after 90 days regardless of activity", async () => {
    let { tokens } = await login(env);
    env.clock.advance(31 * 24 * 3600_000);
    expect(code(await rejects(env.auth.refresh({ refreshToken: tokens.refresh_token, clientId: CLIENT })))).toBe("invalid_grant");
    ({ tokens } = await login(env));
    for (let i = 0; i < 4; i++) {
      env.clock.advance(25 * 24 * 3600_000);
      tokens = await env.auth.refresh({ refreshToken: tokens.refresh_token, clientId: CLIENT }).catch(() => tokens);
    }
    env.clock.advance(1000);
    expect(code(await rejects(env.auth.refresh({ refreshToken: tokens.refresh_token, clientId: CLIENT })))).toBe("invalid_grant");
  });

  it("refresh is bound to its client", async () => {
    const { tokens } = await login(env);
    expect(code(await rejects(env.auth.refresh({ refreshToken: tokens.refresh_token, clientId: "other" })))).toBe("invalid_grant");
  });
});

describe("logout", () => {
  it("logout kills access and refresh immediately; other sessions of the user survive; logoutAll kills all", async () => {
    const a = await login(env, "multi");
    const owner = a.ownerId;
    const v = generateVerifier();
    const c = await env.auth.issueCode({ ownerId: owner, clientId: CLIENT, redirectUri: REDIRECT, codeChallenge: challengeS256(v), codeChallengeMethod: "S256" });
    const b = await env.auth.exchangeCode({ code: c, codeVerifier: v, clientId: CLIENT, redirectUri: REDIRECT });
    await env.auth.logout(a.tokens.session_id);
    expect(code(await rejects(env.auth.authenticate(a.tokens.access_token)))).toBe("unauthorized");
    expect(code(await rejects(env.auth.refresh({ refreshToken: a.tokens.refresh_token, clientId: CLIENT })))).toBe("invalid_grant");
    await env.auth.authenticate(b.access_token);
    await env.auth.logoutAll(owner);
    expect(code(await rejects(env.auth.authenticate(b.access_token)))).toBe("unauthorized");
  });
  it("garbage / missing bearer is unauthorized", async () => {
    expect(code(await rejects(env.auth.authenticate(undefined)))).toBe("unauthorized");
    expect(code(await rejects(env.auth.authenticate(randomUUID())))).toBe("unauthorized");
  });
});
