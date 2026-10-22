// A dependency-free MCP client for the browser, speaking JSON-RPC over
// Streamable HTTP (MCP 2025-11-25). Handles both application/json and
// text/event-stream responses, as the transport spec requires of clients.
export const PROTOCOL_VERSION = "2025-11-25";

export class BrowserMcpClient {
  constructor(url, getToken, onWire) {
    this.url = url;
    this.getToken = getToken;
    this.onWire = onWire || (() => {});
    this.nextId = 1;
    this.initialized = null;
    this.initPromise = null;
  }

  async post(message, source) {
    const started = performance.now();
    this.onWire({ direction: "client→server", message, source });
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${await this.getToken()}`,
    };
    if (this.initialized) headers["MCP-Protocol-Version"] = this.initialized.protocolVersion;
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(message) });
    const ms = Math.round(performance.now() - started);
    if (res.status === 202) {
      await res.text().catch(() => "");
      this.onWire({ direction: "server→client", httpStatus: 202, message: "(202 Accepted)", source, ms });
      return undefined;
    }
    const ct = res.headers.get("content-type") || "";
    let body;
    if (ct.includes("text/event-stream")) {
      const text = await res.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (!data) continue;
        const msg = JSON.parse(data);
        if (msg.id === message.id) body = msg;
      }
    } else {
      body = await res.json().catch(() => ({ error: { code: res.status, message: res.statusText } }));
    }
    this.onWire({ direction: "server→client", httpStatus: res.status, message: body, source, ms });
    if (!res.ok && !body?.error) throw new Error(`HTTP ${res.status}`);
    return body;
  }

  async request(method, params, source = "dashboard") {
    if (method !== "initialize") await this.initialize(source);
    const body = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, ...(params ? { params } : {}) }, source);
    if (body?.error) {
      const err = new Error(body.error.message || "MCP error");
      err.code = body.error.code;
      throw err;
    }
    return body?.result;
  }

  /** Runs the initialize handshake once; concurrent callers share the same promise. */
  initialize(source = "dashboard") {
    if (this.initialized) return Promise.resolve(this.initialized);
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const result = await this.post({
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
            clientInfo: { name: "tend-web", version: "0.2.0" },
          },
        }, source);
        if (result?.error) throw new Error(result.error.message);
        this.initialized = result.result;
        await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, source);
        return this.initialized;
      })().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  listTools(source) {
    return this.request("tools/list", undefined, source);
  }

  callTool(name, args, source) {
    return this.request("tools/call", { name, arguments: args || {} }, source);
  }

  readResource(uri, source) {
    return this.request("resources/read", { uri }, source);
  }
}
