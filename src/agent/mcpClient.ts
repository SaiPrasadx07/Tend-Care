// A real MCP client over Streamable HTTP (the same path an Alexa+ host would
// use). A tracing fetch records every JSON-RPC message on the wire so the
// simulator can show exactly what was sent and received.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export interface WireEntry {
  at: string;
  direction: "client→server" | "server→client";
  httpStatus?: number;
  message: unknown;
}

export interface McpSession {
  client: Client;
  tools: Tool[];
  instructions: string | undefined;
  protocolVersion: string | undefined;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  readResource(uri: string): Promise<{ text: string; mimeType: string } | undefined>;
  close(): Promise<void>;
}

function tracingFetch(wire: WireEntry[]): typeof fetch {
  return async (input, init) => {
    if (init?.body && typeof init.body === "string") {
      try {
        wire.push({ at: new Date().toISOString(), direction: "client→server", message: JSON.parse(init.body) });
      } catch {
        /* non-JSON body; not traced */
      }
    }
    const res = await fetch(input, init);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = await res.clone().json().catch(() => undefined);
      if (body !== undefined) wire.push({ at: new Date().toISOString(), direction: "server→client", httpStatus: res.status, message: body });
    } else if (res.status >= 400 || res.status === 202) {
      wire.push({ at: new Date().toISOString(), direction: "server→client", httpStatus: res.status, message: res.status === 202 ? "(202 Accepted)" : await res.clone().text() });
    }
    return res;
  };
}

export async function connectMcp(url: string, token: string, wire: WireEntry[]): Promise<McpSession> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: tracingFetch(wire),
  });
  const client = new Client(
    { name: "tend-alexa-plus-simulator", version: "0.1.0" },
    { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } },
  );
  await client.connect(transport);
  const { tools } = await client.listTools();
  return {
    client,
    tools,
    instructions: client.getInstructions(),
    protocolVersion: transport.protocolVersion,
    async callTool(name, args) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
    async readResource(uri) {
      const res = await client.readResource({ uri });
      const c = res.contents[0];
      if (c && "text" in c && typeof c.text === "string") return { text: c.text, mimeType: c.mimeType ?? "text/html" };
      return undefined;
    },
    async close() {
      await client.close();
    },
  };
}

/** First text block of a tool result (Tend puts the voice-ready sentence there). */
export function speechOf(result: CallToolResult): string {
  const first = result.content.find((c) => c.type === "text");
  const text = first && first.type === "text" ? first.text : "";
  return result.isError ? text.replace(/^[A-Z_]+:\s*/, "") : text;
}
