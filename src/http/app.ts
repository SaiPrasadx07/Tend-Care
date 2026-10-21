import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { Actor, CareService } from "../domain/care.ts";
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from "../mcp/server.ts";
import { Auth, bearerFrom } from "./auth.ts";
import type { CareAgent } from "../agent/agent.ts";
import type { Config } from "../config.ts";
import { seedDemo } from "../seed.ts";

declare module "express-serve-static-core" {
  interface Request {
    actor?: Actor;
    bearer?: string;
  }
}

export interface AppDeps {
  config: Config;
  care: CareService;
  auth: Auth;
  agent: CareAgent;
}

const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));

export function createApp({ config, care, auth, agent }: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");

  const selfOrigins = new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    ...config.allowedOrigins,
  ]);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, ...config.allowedOrigins.map((o) => new URL(o).host)]);

  // Security headers for everything we serve.
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
    next();
  });

  // DNS-rebinding protection: on a loopback bind only accept our own Host header,
  // and reject cross-origin browser requests (MCP spec, Streamable HTTP security warning).
  app.use((req, res, next) => {
    if (loopback && req.headers.host && !allowedHosts.has(req.headers.host)) {
      res.status(403).json({ error: "forbidden_host" });
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== "null" && !selfOrigins.has(origin)) {
      res.status(403).json({ error: "forbidden_origin" });
      return;
    }
    next();
  });

  const limiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: "draft-8", legacyHeaders: false });
  app.use(["/mcp", "/api"], limiter);
  app.use(express.json({ limit: "100kb" }));

  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const token = bearerFrom(req.headers.authorization);
    const actor = auth.verify(token);
    if (!actor) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="tend", error="invalid_token"');
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" }, id: null });
      return;
    }
    req.actor = actor;
    req.bearer = token;
    next();
  };

  // ---------------- MCP: Streamable HTTP (stateless, JSON responses) ----------------
  app.post("/mcp", requireAuth, async (req, res) => {
    const server = buildMcpServer(care, req.actor!);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[tend] MCP transport error", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  // Stateless server: no standalone SSE stream and no sessions to delete.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This server is stateless; use POST." }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // ---------------- Simulator API ----------------
  app.get("/api/config", (_req, res) => {
    res.json({
      server: { name: SERVER_NAME, version: SERVER_VERSION, mcpProtocolVersion: LATEST_PROTOCOL_VERSION, mcpPath: "/mcp" },
      engine: agent.engineName,
      model: agent.modelId,
      guardrail: agent.guardrailId !== null,
      timezone: config.timezone,
      demoMode: config.demoMode,
      caregivers: auth.listActors(),
    });
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  if (config.demoMode) {
    // Issues a short-lived session token so the browser can act as an MCP client
    // without ever holding a long-lived caregiver secret. Only enabled in demo mode.
    app.post("/api/demo/session", (req, res) => {
      const id = typeof req.body?.caregiverId === "string" ? req.body.caregiverId : "";
      if (!auth.actorById(id)) {
        res.status(400).json({ error: "unknown_caregiver" });
        return;
      }
      res.json({ ...auth.issueSessionToken(id, 3600), actor: auth.actorById(id) });
    });
    app.post("/api/demo/reset", requireAuth, (req, res) => {
      if (req.actor!.role !== "caregiver") {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      seedDemo(care, { reset: true });
      res.json({ ok: true });
    });
  }

  app.post("/api/agent/turn", requireAuth, async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const sessionId = typeof req.body?.sessionId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(req.body.sessionId) ? req.body.sessionId : "";
    if (!text || text.length > 500 || !sessionId) {
      res.status(400).json({ error: "invalid_request", message: "text (1-500 chars) and sessionId are required" });
      return;
    }
    try {
      const result = await agent.turn({ sessionId: `${req.actor!.id}:${sessionId}`, actor: req.actor!, token: req.bearer!, text });
      res.json(result);
    } catch (err) {
      console.error("[tend] agent turn failed", err);
      const name = err instanceof Error ? err.name : "Error";
      res.status(502).json({ error: "agent_failed", message: `The assistant couldn't complete that (${name}). Check server logs and AWS configuration.` });
    }
  });

  app.post("/api/agent/reset", requireAuth, (req, res) => {
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
    agent.resetSession(`${req.actor!.id}:${sessionId}`);
    res.json({ ok: true });
  });

  // ---------------- Static simulator UI ----------------
  app.use(
    express.static(WEB_DIR, {
      setHeaders(res, path) {
        if (path.endsWith("sandbox-proxy.html")) {
          // The MCP Apps sandbox proxy: views may run inline scripts but cannot make network requests.
          res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src 'self' about:; frame-ancestors 'self'");
        } else if (path.endsWith(".html")) {
          res.setHeader(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
          );
        }
      },
    }),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (err as { status?: number })?.status === "number" ? (err as { status: number }).status : 500;
    if (status >= 500) console.error("[tend] unhandled error", err);
    res.status(status).json({ error: status === 400 ? "bad_request" : "internal_error" });
  });

  return app;
}
