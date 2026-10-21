import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth, bearerFrom } from "../src/http/auth.ts";
import { loadConfig, parseCaregivers } from "../src/config.ts";

const T1 = "a".repeat(32);
const T2 = "b".repeat(32);
const cgs = [
  { id: "priya", name: "Priya", role: "caregiver" as const, token: T1 },
  { id: "maria", name: "Maria", role: "viewer" as const, token: T2 },
];

test("static tokens resolve to their caregiver; unknown tokens don't", () => {
  const auth = new Auth(cgs, "s".repeat(32));
  assert.equal(auth.verify(T1)?.id, "priya");
  assert.equal(auth.verify(T2)?.role, "viewer");
  assert.equal(auth.verify("c".repeat(32)), undefined);
  assert.equal(auth.verify(undefined), undefined);
  assert.equal(auth.verify("x".repeat(600)), undefined);
});

test("session tokens are signed, expire, and can't be tampered with", () => {
  let now = Date.parse("2026-10-21T10:00:00Z");
  const auth = new Auth(cgs, "s".repeat(32), () => now);
  const { token } = auth.issueSessionToken("maria", 60);
  assert.equal(auth.verify(token)?.id, "maria");
  const [p, payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "priya", exp: 9_999_999_999 })).toString("base64url");
  assert.equal(auth.verify(`${p}.${forged}.${sig}`), undefined, "payload swap rejected");
  assert.equal(new Auth(cgs, "z".repeat(32), () => now).verify(token), undefined, "other secret rejected");
  assert.equal(auth.verify(`${p}.${payload}.`), undefined);
  now += 61_000;
  assert.equal(auth.verify(token), undefined, "expired");
});

test("bearer parsing and caregiver config validation", () => {
  assert.equal(bearerFrom("Bearer abc"), "abc");
  assert.equal(bearerFrom("bearer abc"), "abc");
  assert.equal(bearerFrom("Basic abc"), undefined);
  assert.equal(parseCaregivers(`priya|Priya|caregiver|${T1}`)[0]!.name, "Priya");
  assert.throws(() => parseCaregivers("priya|Priya|admin|" + T1), /role/);
  assert.throws(() => parseCaregivers("priya|Priya|caregiver|short"), /24 characters/);
  assert.throws(() => parseCaregivers(`Bad Id|X|viewer|${T1}`), /invalid id/);
});

test("loadConfig defaults: loopback + demo mode, Nova Pro on Bedrock, generated tokens", () => {
  const c = loadConfig({ TEND_TIMEZONE: "America/Los_Angeles" } as NodeJS.ProcessEnv);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.demoMode, true);
  assert.equal(c.caregiversGenerated, true);
  assert.ok(c.caregivers.every((x) => x.token.length >= 24));
  assert.equal(c.bedrockModelId, "us.amazon.nova-pro-v1:0");
  const pub = loadConfig({ HOST: "0.0.0.0", TEND_TIMEZONE: "UTC" } as NodeJS.ProcessEnv);
  assert.equal(pub.demoMode, false, "demo endpoints are off when bound publicly");
  assert.throws(() => loadConfig({ TEND_TIMEZONE: "Mars/Olympus" } as NodeJS.ProcessEnv), /timezone/);
});
