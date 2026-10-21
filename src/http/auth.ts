// Bearer-token auth for the MCP endpoint and agent API.
// - Static per-caregiver tokens (TEND_CAREGIVERS) for external MCP clients.
// - Short-lived HMAC-signed session tokens for the browser simulator, so a
//   long-lived secret never reaches frontend code.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Actor } from "../domain/care.ts";
import type { CaregiverConfig } from "../config.ts";

const SESSION_PREFIX = "tend_s";

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

export class Auth {
  private readonly caregivers: CaregiverConfig[];
  private readonly secret: string;
  private readonly now: () => number;

  constructor(caregivers: CaregiverConfig[], secret: string, now: () => number = Date.now) {
    this.caregivers = caregivers;
    this.secret = secret;
    this.now = now;
  }

  listActors(): Actor[] {
    return this.caregivers.map(({ id, name, role }) => ({ id, name, role }));
  }

  actorById(id: string): Actor | undefined {
    return this.listActors().find((a) => a.id === id);
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  issueSessionToken(actorId: string, ttlSeconds = 3600): { token: string; expiresAt: string } {
    if (!this.actorById(actorId)) throw new Error("unknown caregiver");
    const exp = Math.floor(this.now() / 1000) + ttlSeconds;
    const payload = b64url(JSON.stringify({ sub: actorId, exp }));
    return { token: `${SESSION_PREFIX}.${payload}.${this.sign(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** Resolve a bearer token to an actor, or undefined. Constant-time comparisons throughout. */
  verify(token: string | undefined): Actor | undefined {
    if (!token || token.length > 512) return undefined;
    if (token.startsWith(`${SESSION_PREFIX}.`)) {
      const [, payload, sig] = token.split(".");
      if (!payload || !sig) return undefined;
      const expected = this.sign(payload);
      if (!timingSafeEqual(digest(sig), digest(expected))) return undefined;
      try {
        const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub: string; exp: number };
        if (typeof exp !== "number" || exp * 1000 < this.now()) return undefined;
        return this.actorById(sub);
      } catch {
        return undefined;
      }
    }
    const d = digest(token);
    let match: CaregiverConfig | undefined;
    for (const c of this.caregivers) {
      // Check every entry so timing doesn't reveal which caregiver matched.
      if (timingSafeEqual(d, digest(c.token))) match = c;
    }
    return match ? { id: match.id, name: match.name, role: match.role } : undefined;
  }
}

export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1];
}
