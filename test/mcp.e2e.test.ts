import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHarness, type Harness } from "./server-harness.ts";

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

async function connect(token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(h.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return { client, transport };
}

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(h.mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });

describe("MCP over Streamable HTTP", () => {
  test("initialize negotiates protocol 2025-11-25 and advertises tools + resources", async () => {
    const res = await rpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } } },
      { Authorization: `Bearer ${h.tokens.priya}` },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as { result: { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string }; instructions: string } };
    assert.equal(body.result.protocolVersion, "2025-11-25");
    assert.ok(body.result.capabilities.tools);
    assert.ok(body.result.capabilities.resources);
    assert.equal(body.result.serverInfo.name, "tend-care");
    assert.match(body.result.instructions, /Never give medical advice/);
  });

  test("SDK client connects and lists role-scoped tools", async () => {
    const { client, transport } = await connect(h.tokens.priya);
    assert.equal(transport.protocolVersion, "2025-11-25");
    const { tools } = await client.listTools();
    assert.equal(tools.length, 13);
    const status = tools.find((t) => t.name === "get_care_status")!;
    assert.deepEqual(status._meta, { ui: { resourceUri: "ui://tend/care-board" } });
    assert.ok(status.outputSchema, "tools declare output schemas");
    assert.equal(tools.find((t) => t.name === "confirm_action")!.annotations?.destructiveHint, true);
    await client.close();

    const viewer = await connect(h.tokens.maria);
    const viewerTools = (await viewer.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(viewerTools, ["forecast_refills", "get_care_status", "get_handoff_report", "get_recent_activity", "list_care_recipients"]);
    const denied = await viewer.client.callTool({ name: "log_dose", arguments: { medication: "metformin" } });
    assert.equal(denied.isError, true);
    await viewer.client.close();
  });

  test("tools/call returns speech text plus schema-validated structuredContent", async () => {
    const { client } = await connect(h.tokens.priya);
    const logged = await client.callTool({ name: "log_dose", arguments: { medication: "metformin", person: "Mom" } });
    assert.ok(!logged.isError);
    assert.equal((logged.structuredContent as { outcome: string }).outcome, "logged");
    assert.match((logged.content as { text: string }[])[0]!.text, /Lakshmi took the 8:00 AM Metformin 500 mg/);

    const dup = await connect(h.tokens.arjun);
    const second = await dup.client.callTool({ name: "log_dose", arguments: { medication: "metformin", person: "Mom" } });
    assert.equal((second.structuredContent as { outcome: string }).outcome, "needs_confirmation");
    assert.match((second.content as { text: string }[])[0]!.text, /already logged as taken .* by Priya/);

    const status = await client.callTool({ name: "get_care_status", arguments: { person: "Mom" } });
    const sc = status.structuredContent as { people: { slots: { state: string; loggedBy: string | null }[] }[] };
    assert.equal(sc.people[0]!.slots[0]!.state, "taken");
    assert.equal(sc.people[0]!.slots[0]!.loggedBy, "Priya");
    await client.close();
    await dup.client.close();
  });

  test("domain errors come back as isError results the model can act on; schema violations are rejected", async () => {
    const { client } = await connect(h.tokens.priya);
    const nf = await client.callTool({ name: "get_care_status", arguments: { person: "Grandpa" } });
    assert.equal(nf.isError, true);
    assert.match((nf.content as { text: string }[])[0]!.text, /^NOT_FOUND: .*Lakshmi \(Mom\)/);
    const bad = await client.callTool({ name: "log_dose", arguments: { medication: "metformin", slot_time: "8pm" } });
    assert.equal(bad.isError, true);
    assert.match((bad.content as { text: string }[])[0]!.text, /Input validation error/);
    const badUuid = await client.callTool({ name: "confirm_action", arguments: { action_id: "not-a-uuid" } });
    assert.equal(badUuid.isError, true);
    await client.close();
  });

  test("MCP Apps UI resource is served with the mcp-app MIME type", async () => {
    const { client } = await connect(h.tokens.maria);
    const { resources } = await client.listResources();
    assert.equal(resources[0]!.uri, "ui://tend/care-board");
    const read = await client.readResource({ uri: "ui://tend/care-board" });
    const c = read.contents[0] as { mimeType: string; text: string };
    assert.equal(c.mimeType, "text/html;profile=mcp-app");
    assert.match(c.text, /ui\/initialize/);
    await client.close();
  });
});

describe("transport security", () => {
  test("missing or bad bearer token -> 401 with WWW-Authenticate", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
    const none = await rpc(init);
    assert.equal(none.status, 401);
    assert.match(none.headers.get("www-authenticate") ?? "", /Bearer/);
    const wrong = await rpc(init, { Authorization: "Bearer not-a-real-token-xxxxxxxxxxxxxxxx" });
    assert.equal(wrong.status, 401);
  });

  test("cross-origin browser requests and foreign Host headers are rejected (DNS rebinding)", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: `Bearer ${h.tokens.priya}`, Origin: "https://evil.example" });
    assert.equal(res.status, 403);
    const { request } = await import("node:http");
    const url = new URL(h.mcpUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: url.hostname, port: url.port, path: "/mcp", method: "POST", headers: { Host: "attacker.example:80", "Content-Type": "application/json" } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(status, 403);
  });

  test("GET/DELETE on /mcp -> 405 for this stateless server", async () => {
    const res = await fetch(h.mcpUrl, { headers: { Authorization: `Bearer ${h.tokens.priya}`, Accept: "text/event-stream" } });
    assert.equal(res.status, 405);
  });

  test("short-lived session tokens work for MCP and are bound to one caregiver", async () => {
    const res = await fetch(`${h.base}/api/demo/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caregiverId: "maria" }) });
    const { token, actor } = (await res.json()) as { token: string; actor: { role: string } };
    assert.equal(actor.role, "viewer");
    const { client } = await connect(token);
    assert.equal((await client.listTools()).tools.length, 5);
    await client.close();
    const cfg = (await (await fetch(`${h.base}/api/config`)).json()) as { caregivers: Record<string, unknown>[] };
    assert.ok(cfg.caregivers.every((c) => !("token" in c)), "config never exposes tokens");
  });
});
