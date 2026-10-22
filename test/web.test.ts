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

describe("caregiver web app", () => {
  test("index is served with a strict CSP and references only same-origin assets", async () => {
    const res = await fetch(`${h.base}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'self'/);
    const html = await res.text();
    for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      const url = m[1]!;
      if (url.startsWith("data:")) continue;
      assert.ok(!/^https?:/.test(url), `external asset referenced: ${url}`);
    }
  });

  test("every ES module in the import graph, the stylesheet and the fonts resolve", async () => {
    const seen = new Set<string>();
    const queue = ["js/app.js"];
    while (queue.length) {
      const path = queue.shift()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const res = await fetch(`${h.base}/${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /javascript/, path);
      const src = await res.text();
      for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gm)) {
        queue.push(new URL(m[1]!, `http://x/${path}`).pathname.slice(1));
      }
    }
    assert.ok(seen.size >= 10, `expected the full module graph, saw ${[...seen].join(", ")}`);
    const css = await fetch(`${h.base}/styles.css`);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    const fonts = [...(await css.text()).matchAll(/url\("(fonts\/[^"]+)"\)/g)].map((m) => m[1]!);
    assert.equal(fonts.length, 4);
    for (const f of fonts) {
      const r = await fetch(`${h.base}/${f}`);
      assert.equal(r.status, 200, f);
      assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString("latin1"), "wOF2", `${f} is a WOFF2 font`);
    }
  });

  test("MCP Apps sandbox proxy forbids network access from views", async () => {
    const res = await fetch(`${h.base}/sandbox-proxy.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  });

  test("handoff report exposes the per-day dose grid the dashboard draws, schema-validated over MCP", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(h.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${h.tokens.maria}` } } });
    const client = new Client({ name: "web-test", version: "1" });
    await client.connect(transport);
    const res = await client.callTool({ name: "get_handoff_report", arguments: { days: 3 } });
    assert.ok(!res.isError);
    const sc = res.structuredContent as { people: { adherence: { medicationId: string; times: string[]; daily: { date: string; slots: { state: string }[] }[] }[] }[] };
    const line = sc.people[0]!.adherence[0]!;
    assert.ok(line.medicationId);
    assert.equal(line.daily.length, 3);
    assert.equal(line.daily[0]!.slots.length, line.times.length);
    await client.close();
  });
});
