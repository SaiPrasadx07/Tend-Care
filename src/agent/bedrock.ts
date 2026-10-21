// Amazon Bedrock reasoning layer for the Alexa+ simulator. Uses the Converse
// API with tool use: MCP tools from tools/list become Bedrock toolSpecs, and
// each toolUse block is executed as a real MCP tools/call.
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool as BedrockTool,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

export interface EngineTurn {
  system: string;
  history: Message[];
  userText: string;
  tools: McpTool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface EngineResult {
  reply: string;
  history: Message[];
  usage: { inputTokens: number; outputTokens: number; modelCalls: number };
}

const MAX_STEPS = 6;
const MAX_HISTORY = 24;

/** Convert an MCP tool to a Bedrock toolSpec. Bedrock rejects the "$schema" keyword. */
export function toBedrockTool(t: McpTool): BedrockTool {
  const { $schema: _ignored, ...schema } = t.inputSchema as Record<string, unknown>;
  return {
    toolSpec: {
      name: t.name,
      description: (t.description ?? t.title ?? t.name).slice(0, 1000),
      inputSchema: { json: schema as never },
    },
  };
}

export function toToolResultContent(result: CallToolResult): ToolResultContentBlock[] {
  const blocks: ToolResultContentBlock[] = [];
  const first = result.content.find((c) => c.type === "text");
  if (first && first.type === "text") blocks.push({ text: first.text });
  if (result.structuredContent && !result.isError) blocks.push({ json: result.structuredContent as never });
  if (blocks.length === 0) blocks.push({ text: "(no content)" });
  return blocks;
}

/** Keep history bounded and starting on a plain user text turn (never an orphaned toolResult). */
export function trimHistory(messages: Message[]): Message[] {
  let start = Math.max(0, messages.length - MAX_HISTORY);
  while (start < messages.length) {
    const m = messages[start]!;
    if (m.role === "user" && m.content?.some((c) => "text" in c && c.text !== undefined) && !m.content.some((c) => "toolResult" in c && c.toolResult)) break;
    start++;
  }
  return messages.slice(start);
}

export class BedrockEngine {
  readonly modelId: string;
  private readonly client: BedrockRuntimeClient;

  constructor(opts: { region: string; modelId: string; client?: BedrockRuntimeClient }) {
    this.modelId = opts.modelId;
    this.client = opts.client ?? new BedrockRuntimeClient({ region: opts.region, maxAttempts: 3 });
  }

  async run(turn: EngineTurn): Promise<EngineResult> {
    const messages: Message[] = [...turn.history, { role: "user", content: [{ text: turn.userText }] }];
    const toolConfig = { tools: turn.tools.map(toBedrockTool) };
    const usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [{ text: turn.system }],
          messages,
          toolConfig,
          inferenceConfig: { maxTokens: 700, temperature: 0.2 },
        }),
      );
      usage.modelCalls++;
      usage.inputTokens += res.usage?.inputTokens ?? 0;
      usage.outputTokens += res.usage?.outputTokens ?? 0;
      const msg = res.output?.message;
      if (!msg) throw new Error("Bedrock returned no message");
      messages.push(msg);
      const toolUses = (msg.content ?? []).filter((c): c is ContentBlock.ToolUseMember => "toolUse" in c && c.toolUse !== undefined);
      if (res.stopReason !== "tool_use" || toolUses.length === 0) {
        const reply = (msg.content ?? []).map((c) => ("text" in c && c.text ? c.text : "")).join(" ").trim();
        return { reply: reply || "Okay.", history: trimHistory(messages), usage };
      }
      const results: ContentBlock[] = [];
      for (const block of toolUses) {
        const { toolUseId, name, input } = block.toolUse;
        const result = await turn.callTool(name!, (input ?? {}) as Record<string, unknown>);
        results.push({ toolResult: { toolUseId: toolUseId!, content: toToolResultContent(result), status: result.isError ? "error" : "success" } });
      }
      messages.push({ role: "user", content: results });
    }
    messages.push({ role: "assistant", content: [{ text: "Sorry, that took too many steps. Could you say it more simply?" }] });
    return { reply: "Sorry, that took too many steps. Could you say it more simply?", history: trimHistory(messages), usage };
  }
}
