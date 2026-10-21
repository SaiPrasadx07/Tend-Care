import { randomBytes } from "node:crypto";
import { isValidTimeZone } from "./domain/time.ts";
import type { Role } from "./domain/store.ts";

export interface CaregiverConfig {
  id: string;
  name: string;
  role: Role;
  token: string;
}

export type EngineChoice = "auto" | "bedrock" | "offline";

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  timezone: string;
  caregivers: CaregiverConfig[];
  caregiversGenerated: boolean;
  sessionSecret: string;
  allowedOrigins: string[];
  demoMode: boolean;
  mcpUrl: string;
  engine: EngineChoice;
  awsRegion: string;
  bedrockModelId: string;
  guardrail?: { id: string; version: string };
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** TEND_CAREGIVERS="priya|Priya|caregiver|<token>,maria|Maria|viewer|<token>" */
export function parseCaregivers(raw: string): CaregiverConfig[] {
  const out: CaregiverConfig[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [id, name, role, token] = entry.split("|").map((s) => s.trim());
    if (!id || !ID.test(id)) throw new Error(`TEND_CAREGIVERS: invalid id in entry "${id ?? ""}"`);
    if (!name) throw new Error(`TEND_CAREGIVERS: missing name for ${id}`);
    if (role !== "caregiver" && role !== "viewer") throw new Error(`TEND_CAREGIVERS: role for ${id} must be caregiver or viewer`);
    if (!token || token.length < 24) throw new Error(`TEND_CAREGIVERS: token for ${id} must be at least 24 characters`);
    if (out.some((c) => c.id === id)) throw new Error(`TEND_CAREGIVERS: duplicate id ${id}`);
    out.push({ id, name, role, token });
  }
  if (out.length === 0) throw new Error("TEND_CAREGIVERS is set but empty");
  return out;
}

function defaultCaregivers(): CaregiverConfig[] {
  const t = () => randomBytes(24).toString("base64url");
  return [
    { id: "priya", name: "Priya", role: "caregiver", token: t() },
    { id: "arjun", name: "Arjun", role: "caregiver", token: t() },
    { id: "maria", name: "Nurse Maria", role: "viewer", token: t() },
  ];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST ?? "127.0.0.1";
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be a valid port number");
  const timezone = env.TEND_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!isValidTimeZone(timezone)) throw new Error(`TEND_TIMEZONE "${timezone}" is not a valid IANA timezone`);
  const caregivers = env.TEND_CAREGIVERS ? parseCaregivers(env.TEND_CAREGIVERS) : defaultCaregivers();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const engine = (env.TEND_AGENT_ENGINE ?? "auto") as EngineChoice;
  if (!["auto", "bedrock", "offline"].includes(engine)) throw new Error("TEND_AGENT_ENGINE must be auto, bedrock or offline");
  const sessionSecret = env.TEND_SESSION_SECRET ?? randomBytes(32).toString("base64url");
  if (sessionSecret.length < 32) throw new Error("TEND_SESSION_SECRET must be at least 32 characters");
  return {
    host,
    port,
    dbPath: env.TEND_DB_PATH ?? "./data/tend.db",
    timezone,
    caregivers,
    caregiversGenerated: !env.TEND_CAREGIVERS,
    sessionSecret,
    allowedOrigins: (env.TEND_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    // Demo endpoints (session issuing, reset) default on only for loopback binds.
    demoMode: env.TEND_DEMO_MODE ? env.TEND_DEMO_MODE === "true" : loopback,
    mcpUrl: env.TEND_MCP_URL ?? `http://127.0.0.1:${port}/mcp`,
    engine,
    awsRegion: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1",
    bedrockModelId: env.BEDROCK_MODEL_ID ?? "us.amazon.nova-pro-v1:0",
    guardrail: env.BEDROCK_GUARDRAIL_ID ? { id: env.BEDROCK_GUARDRAIL_ID, version: env.BEDROCK_GUARDRAIL_VERSION ?? "DRAFT" } : undefined,
  };
}
