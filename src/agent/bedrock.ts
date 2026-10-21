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
  guardrailIntervened: boolean;
}

export interface GuardrailRef {
  id: string;
  version: string;
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
    const isUserUtterance = m.content?.some((c) => ("text" in c && c.text !== undefined) || ("guardContent" in c && c.guardContent !== undefined));
    if (m.role === "user" && isUserUtterance && !m.content!.some((c) => "toolResult" in c && c.toolResult)) break;
    start++;
  }
  return messages.slice(start);
}

export class BedrockEngine {
  readonly modelId: string;
  readonly guardrail: GuardrailRef | undefined;
  private readonly client: BedrockRuntimeClient;

  constructor(opts: { region: string; modelId: string; guardrail?: GuardrailRef; client?: BedrockRuntimeClient }) {
    this.modelId = opts.modelId;
    this.guardrail = opts.guardrail;
    this.client = opts.client ?? new BedrockRuntimeClient({ region: opts.region, maxAttempts: 3 });
  }

  async run(turn: EngineTurn): Promise<EngineResult> {
    // With a guardrail, only the user's own words are evaluated (guardContent), so tool
    // results that legitimately mention medications don't trip the "medical advice" topic.
    const userContent: ContentBlock[] = this.guardrail ? [{ guardContent: { text: { text: turn.userText } } }] : [{ text: turn.userText }];
    const messages: Message[] = [...turn.history, { role: "user", content: userContent }];
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
          ...(this.guardrail ? { guardrailConfig: { guardrailIdentifier: this.guardrail.id, guardrailVersion: this.guardrail.version, trace: "enabled" as const } } : {}),
        }),
      );
      usage.modelCalls++;
      usage.inputTokens += res.usage?.inputTokens ?? 0;
      usage.outputTokens += res.usage?.outputTokens ?? 0;
      const msg = res.output?.message;
      if (!msg) throw new Error("Bedrock returned no message");
      if (res.stopReason === "guardrail_intervened") {
        const reply = (msg.content ?? []).map((c) => ("text" in c && c.text ? c.text : "")).join(" ").trim();
        // Keep the blocked exchange out of history so it isn't re-evaluated on every later turn.
        return { reply: reply || "I can't help with that one. Please ask the pharmacist or doctor.", history: turn.history, usage, guardrailIntervened: true };
      }
      messages.push(msg);
      const toolUses = (msg.content ?? []).filter((c): c is ContentBlock.ToolUseMember => "toolUse" in c && c.toolUse !== undefined);
      if (res.stopReason !== "tool_use" || toolUses.length === 0) {
        const reply = (msg.content ?? []).map((c) => ("text" in c && c.text ? c.text : "")).join(" ").trim();
        return { reply: reply || "Okay.", history: trimHistory(messages), usage, guardrailIntervened: false };
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
    return { reply: "Sorry, that took too many steps. Could you say it more simply?", history: trimHistory(messages), usage, guardrailIntervened: false };
  }
}
