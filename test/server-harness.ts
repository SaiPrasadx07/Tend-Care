import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/http/app.ts";
import { Auth } from "../src/http/auth.ts";
import { CareAgent } from "../src/agent/agent.ts";
import type { BedrockEngine } from "../src/agent/bedrock.ts";
import type { Config } from "../src/config.ts";
import { Clock, TZ, makeCare, seedBasic } from "./helpers.ts";

export interface Harness {
  base: string;
  mcpUrl: string;
  tokens: { priya: string; arjun: string; maria: string };
  clock: Clock;
  auth: Auth;
  close(): Promise<void>;
}

/** Boot the real Express app on a free loopback port with an in-memory DB. */
export async function startHarness(opts: { bedrock?: BedrockEngine; clockAt?: [string, string] } = {}): Promise<Harness> {
  const clock = new Clock(...(opts.clockAt ?? ["2026-10-21", "08:10"]));
  const care = makeCare(clock);
  seedBasic(care, clock);
  const tok = () => randomBytes(24).toString("base64url");
  const tokens = { priya: tok(), arjun: tok(), maria: tok() };
  // Reserve a port first so Host/Origin checks know it.
  const probe = (await import("node:net")).createServer();
  const port = await new Promise<number>((r) => probe.listen(0, "127.0.0.1", () => r((probe.address() as AddressInfo).port)));
  await new Promise((r) => probe.close(r));
  const config: Config = {
    host: "127.0.0.1",
    port,
    dbPath: ":memory:",
    timezone: TZ,
    caregivers: [
      { id: "priya", name: "Priya", role: "caregiver", token: tokens.priya },
      { id: "arjun", name: "Arjun", role: "caregiver", token: tokens.arjun },
      { id: "maria", name: "Nurse Maria", role: "viewer", token: tokens.maria },
    ],
    caregiversGenerated: false,
    sessionSecret: randomBytes(32).toString("base64url"),
    allowedOrigins: [],
    demoMode: true,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    engine: opts.bedrock ? "bedrock" : "offline",
    awsRegion: "us-east-1",
    bedrockModelId: "test-model",
  };
  const auth = new Auth(config.caregivers, config.sessionSecret);
  const agent = new CareAgent({ mcpUrl: config.mcpUrl, timezone: TZ, engine: config.engine, bedrock: opts.bedrock, now: clock.now });
  const app = createApp({ config, care, auth, agent });
  const server: Server = await new Promise((r) => {
    const s = app.listen(port, "127.0.0.1", () => r(s));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    mcpUrl: config.mcpUrl,
    tokens,
    clock,
    auth,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
