// The Alexa+ simulator's host agent. Per turn it opens a real MCP session to
// Tend (initialize -> tools/list -> tools/call ...), lets the engine
// (Bedrock or offline) plan tool calls, enforces host-side safety policy, and
// returns the reply plus a wire-level trace and any MCP Apps cards.
import type { Message } from "@aws-sdk/client-bedrock-runtime";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BedrockEngine } from "./bedrock.ts";
import { connectMcp, type WireEntry } from "./mcpClient.ts";
import { AFFIRMATIVE, NEGATIVE, runOffline, newOfflineSession, toSpeech, type OfflineSession } from "./offline.ts";
import type { EngineChoice } from "../config.ts";
import type { Actor } from "../domain/care.ts";
import { zonedParts, formatDateLong, formatTime12 } from "../domain/time.ts";

export interface ToolTrace {
  name: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  speech: string;
  structuredContent: Record<string, unknown> | null;
  blockedByHost?: string;
  ms: number;
}

export interface UiCard {
  toolName: string;
  resourceUri: string;
  html: string;
  toolInput: Record<string, unknown>;
  toolResult: CallToolResult;
}

export interface TurnResult {
  reply: string;
  /** Spoken form of the reply (units expanded, long drafts omitted). Same facts as `reply`. */
  speech: string;
  engine: "bedrock" | "offline";
  engineNote: string | null;
  protocolVersion: string | null;
  tools: ToolTrace[];
  cards: UiCard[];
  wire: WireEntry[];
  usage: { inputTokens: number; outputTokens: number; modelCalls: number } | null;
  guardrail: { configured: boolean; intervened: boolean };
  ms: number;
}

interface Session {
  actorId: string;
  history: Message[];
  offline: OfflineSession;
  /** Pending action ids surfaced to the user in an earlier turn of this session. */
  offeredActions: Set<string>;
  lastUsed: number;
}

export function hasAwsCredentialSource(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.AWS_ACCESS_KEY_ID ||
      env.AWS_PROFILE ||
      env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
      env.AWS_LAMBDA_FUNCTION_NAME ||
      existsSync(join(homedir(), ".aws", "credentials")) ||
      existsSync(join(homedir(), ".aws", "config")),
  );
}

export interface AgentOptions {
  mcpUrl: string;
  timezone: string;
  engine: EngineChoice;
  bedrock?: BedrockEngine;
  now?: () => Date;
}

const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 200;

export class CareAgent {
  private readonly sessions = new Map<string, Session>();
  private readonly opts: AgentOptions;
  private readonly now: () => Date;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  get engineName(): "bedrock" | "offline" {
    return this.opts.bedrock ? "bedrock" : "offline";
  }

  get modelId(): string | null {
    return this.opts.bedrock?.modelId ?? null;
  }

  get guardrailId(): string | null {
    return this.opts.bedrock?.guardrail?.id ?? null;
  }

  private session(id: string, actor: Actor): Session {
    const nowMs = Date.now();
    for (const [k, s] of this.sessions) if (nowMs - s.lastUsed > SESSION_TTL_MS) this.sessions.delete(k);
    let s = this.sessions.get(id);
    // A session is bound to the caregiver who started it.
    if (!s || s.actorId !== actor.id) {
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (oldest) this.sessions.delete(oldest[0]);
      }
      s = { actorId: actor.id, history: [], offline: newOfflineSession(), offeredActions: new Set(), lastUsed: nowMs };
      this.sessions.set(id, s);
    }
    s.lastUsed = nowMs;
    return s;
  }

  resetSession(id: string): void {
    this.sessions.delete(id);
  }

  private systemPrompt(actor: Actor, instructions: string | undefined): string {
    const local = zonedParts(this.now(), this.opts.timezone);
    return [
      "You are Alexa+, running the Tend care-circle add-on. You are speaking out loud on an Echo Show, so answer in one to three short, warm, plain sentences. No markdown, no lists, no emojis.",
      "Answer the question that was actually asked, using the fewest tool calls that answer it. A question about one person or one medicine gets an answer about that person or medicine only; never recite the whole household's status unless asked.",
      "If a request is vague (for example 'I want to know about the medicine'), ask one short clarifying question, such as whether they want today's doses or a particular medicine, instead of dumping information. Clear questions get direct answers.",
      "Use the conversation so far for follow-ups ('what about tonight?', 'and Dad?'). If the referent is unclear, ask. Never carry an assumed person or medicine into a write; resolve it first.",
      "A greeting gets a short greeting back ('Hey Priya. What can I help you with today?'). Describe what you can do only when asked, and don't repeat the introduction later in the conversation.",
      "Lead with the short answer ('Partly.', 'Yes.', 'Not yet.'), then the useful detail. A dose counts as given only if it was logged; say 'hasn't been logged, so I can't confirm it was taken' rather than inferring from the schedule. For other days, pass get_care_status a date.",
      "When the caregiver talks about their own feelings ('I am feeling depressed', 'I'm exhausted'), respond briefly and warmly, never save it as a care note, and never attribute it to a care recipient. If they mention wanting to harm themselves, urge them to call their local emergency number (in the US, call or text 988). When they describe a symptom or change in a care recipient ('Dad is having a migraine'), ask whether to add it to that person's notes and call add_care_note only after they say yes.",
      "Corrections ('no, I meant Mom') redo the last question for the new person. If the last turn wrote a record for the wrong person, say plainly that it was already recorded and can't be undone by voice; offer to add a note saying it was logged by mistake. Requests outside Tend (weather, music, timers) get one short line saying Tend only handles the care record.",
      "If a dose was missed and they ask what to do, state what the record shows and say the pharmacist, prescriber or medicine label is the right guide for late or missed doses. Never tell them to give, double or skip a dose.",
      "Only record a dose when the caregiver says it was given. If they sound unsure ('probably', 'I think'), ask them to confirm before calling log_dose.",
      "Style: calm and concise. Mirror the family's words ('Mom'). Don't open with 'Of course' or 'Certainly', don't repeat the question back, don't keep using the caregiver's name, and only say an action succeeded when the tool result confirms it.",
      `The speaker is ${actor.name} (${actor.role === "caregiver" ? "a caregiver who can log and change records" : "view-only; cannot change records"}).`,
      `Current local time: ${formatDateLong(local.date)}, ${formatTime12(local.time)} (${this.opts.timezone}). Today is ${local.date}.`,
      "Use Tend's tools for every fact about medications, doses, supply and notes; never invent them. Call list_care_recipients if you need to resolve who 'Mom' or 'Dad' is.",
      "Never give medical advice. For anything clinical, suggest calling the pharmacist or doctor.",
      "Consequential actions: request_refill only prepares an action. Read its summary and ask for a yes. Call confirm_action only in a later turn after the user clearly says yes.",
      instructions ? `Server guidance from Tend:\n${instructions}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async turn(input: { sessionId: string; actor: Actor; token: string; text: string }): Promise<TurnResult> {
    const started = Date.now();
    const text = input.text.trim().slice(0, 500);
    const session = this.session(input.sessionId, input.actor);
    const wire: WireEntry[] = [];
    const traces: ToolTrace[] = [];
    const cards: UiCard[] = [];
    const mcp = await connectMcp(this.opts.mcpUrl, input.token, wire);
    const toolIndex = new Map<string, Tool>(mcp.tools.map((t) => [t.name, t]));
    const uiCache = new Map<string, string>();
    const affirmed = AFFIRMATIVE.test(text) && !NEGATIVE.test(text);
    const offeredThisTurn = new Set<string>();

    const callTool = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      const t0 = Date.now();
      // Host policy: a consequential action needs an explicit "yes" from the user in this turn,
      // for an action that was read to them in an earlier turn. The model can't self-confirm.
      if (name === "confirm_action") {
        const id = String(args.action_id ?? "");
        let reason: string | undefined;
        if (!affirmed) reason = "The user has not explicitly said yes in this turn. Read the summary and ask them to confirm.";
        else if (!session.offeredActions.has(id)) reason = "This action was not presented to the user in an earlier turn. Read the summary to them first.";
        if (reason) {
          const blocked: CallToolResult = { isError: true, content: [{ type: "text", text: `HOST_POLICY: ${reason}` }] };
          traces.push({ name, arguments: args, isError: true, speech: reason, structuredContent: null, blockedByHost: reason, ms: Date.now() - t0 });
          return blocked;
        }
      }
      let result: CallToolResult;
      if (!toolIndex.has(name)) {
        // Tools are role-scoped by the server; explain instead of surfacing a protocol error.
        const why = input.actor.role === "viewer"
          ? `${input.actor.name} has view-only access, so I can't change care records. A caregiver in the circle can log that.`
          : `The ${name} tool isn't available.`;
        result = { isError: true, content: [{ type: "text", text: `NOT_AVAILABLE: ${why}` }] };
        traces.push({ name, arguments: args, isError: true, speech: why, structuredContent: null, ms: Date.now() - t0 });
        return result;
      }
      try {
        result = await mcp.callTool(name, args);
      } catch (err) {
        // Protocol-level errors (unknown tool, schema violations) go back to the model as tool errors.
        result = { isError: true, content: [{ type: "text", text: `TOOL_ERROR: ${err instanceof Error ? err.message : String(err)}` }] };
      }
      const first = result.content.find((c) => c.type === "text");
      traces.push({
        name,
        arguments: args,
        isError: Boolean(result.isError),
        speech: first && first.type === "text" ? first.text : "",
        structuredContent: (result.structuredContent as Record<string, unknown> | undefined) ?? null,
        ms: Date.now() - t0,
      });
      if (!result.isError) {
        if (name === "request_refill" && typeof result.structuredContent?.actionId === "string") {
          offeredThisTurn.add(result.structuredContent.actionId);
        }
        if (name === "confirm_action" || name === "cancel_action") session.offeredActions.delete(String(args.action_id));
        const uri = (toolIndex.get(name)?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
        if (uri) {
          let html = uiCache.get(uri);
          if (html === undefined) {
            html = (await mcp.readResource(uri))?.text ?? "";
            uiCache.set(uri, html);
          }
          if (html) cards.push({ toolName: name, resourceUri: uri, html, toolInput: args, toolResult: result });
        }
      }
      return result;
    };

    let engine: "bedrock" | "offline" = this.engineName;
    let engineNote: string | null = null;
    let reply: string;
    let usage: TurnResult["usage"] = null;
    let guardrailIntervened = false;
    let speech: string | undefined;
    const offlineOpts = { timezone: this.opts.timezone, now: this.now, actorName: input.actor.name.replace(/^Nurse\s+/, "") };
    try {
      if (this.opts.bedrock) {
        try {
          const r = await this.opts.bedrock.run({
            system: this.systemPrompt(input.actor, mcp.instructions),
            history: session.history,
            userText: text,
            tools: mcp.tools,
            callTool,
          });
          session.history = r.history;
          reply = r.reply;
          usage = r.usage;
          guardrailIntervened = r.guardrailIntervened;
        } catch (err) {
          if (this.opts.engine === "bedrock") throw err;
          // auto mode: degrade to the offline router rather than failing the demo.
          engine = "offline";
          engineNote = `Bedrock unavailable (${err instanceof Error ? err.name : "error"}); used the offline router.`;
          const r = await runOffline(text, session.offline, callTool, offlineOpts);
          reply = r.reply;
          speech = r.speech;
        }
      } else {
        const r = await runOffline(text, session.offline, callTool, offlineOpts);
        reply = r.reply;
        speech = r.speech;
      }
    } finally {
      for (const id of offeredThisTurn) session.offeredActions.add(id);
      await mcp.close().catch(() => undefined);
    }
    return {
      reply,
      speech: speech ?? toSpeech(reply),
      engine,
      engineNote,
      protocolVersion: mcp.protocolVersion ?? null,
      tools: traces,
      // One card per turn: the most recent visual result is the one that answers the question.
      cards: cards.slice(-1),
      wire,
      usage,
      guardrail: { configured: Boolean(this.opts.bedrock?.guardrail), intervened: guardrailIntervened },
      ms: Date.now() - started,
    };
  }
}

export function createAgent(opts: {
  mcpUrl: string;
  timezone: string;
  engine: EngineChoice;
  awsRegion: string;
  bedrockModelId: string;
  guardrail?: { id: string; version: string };
}): CareAgent {
  const useBedrock = opts.engine === "bedrock" || (opts.engine === "auto" && hasAwsCredentialSource());
  return new CareAgent({
    mcpUrl: opts.mcpUrl,
    timezone: opts.timezone,
    engine: opts.engine,
    bedrock: useBedrock ? new BedrockEngine({ region: opts.awsRegion, modelId: opts.bedrockModelId, guardrail: opts.guardrail }) : undefined,
  });
}
