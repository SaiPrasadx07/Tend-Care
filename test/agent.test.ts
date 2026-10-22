import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { BedrockRuntimeClient, ConverseCommand, ConverseCommandOutput, Message } from "@aws-sdk/client-bedrock-runtime";
import { BedrockEngine, toBedrockTool, trimHistory } from "../src/agent/bedrock.ts";
import { parseSlotTime } from "../src/agent/offline.ts";
import { startHarness } from "./server-harness.ts";

interface TurnBody {
  reply: string;
  engine: string;
  protocolVersion: string;
  tools: { name: string; isError: boolean; blockedByHost?: string; arguments: Record<string, unknown> }[];
  cards: { toolName: string; resourceUri: string; html: string }[];
  wire: { direction: string; message: { method?: string } }[];
}

async function say(base: string, token: string, text: string, sessionId = "session-test-1"): Promise<TurnBody> {
  const res = await fetch(`${base}/api/agent/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, sessionId }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as TurnBody;
}

describe("Alexa+ simulator agent (offline router) over real MCP", () => {
  test("a status question runs initialize -> tools/list -> tools/call and returns an MCP Apps card", async () => {
    const h = await startHarness();
    try {
      const r = await say(h.base, h.tokens.priya, "Did Mom take her pills today?");
      assert.equal(r.engine, "offline");
      assert.equal(r.protocolVersion, "2025-11-25");
      const methods = r.wire.filter((w) => w.direction === "client→server").map((w) => w.message.method);
      assert.deepEqual(methods.slice(0, 3), ["initialize", "notifications/initialized", "tools/list"]);
      assert.ok(methods.includes("tools/call"));
      assert.ok(r.tools.some((t) => t.name === "get_care_status"));
      // Replies mirror the caregiver's words ("Mom") and stay on the person asked about.
      assert.match(r.reply, /Mom|Lakshmi/);
      assert.doesNotMatch(r.reply, /Ravi|Dad/);
      assert.equal(r.cards[0]?.resourceUri, "ui://tend/care-board");
      assert.match(r.cards[0]!.html, /ui\/initialize/);
    } finally {
      await h.close();
    }
  });

  test("refill flow needs a yes in a later turn; the host executes confirm_action only then", async () => {
    const h = await startHarness();
    try {
      const ask = await say(h.base, h.tokens.priya, "Reorder Mom's metformin");
      assert.match(ask.reply, /Request a refill of Metformin 500 mg for Lakshmi.*Should I go ahead\?/);
      assert.ok(!ask.tools.some((t) => t.name === "confirm_action"));
      const yes = await say(h.base, h.tokens.priya, "Yes, go ahead");
      const confirm = yes.tools.find((t) => t.name === "confirm_action")!;
      assert.ok(confirm && !confirm.isError, JSON.stringify(yes.tools));
      assert.match(yes.reply, /refill request .* is recorded/);
      const again = await say(h.base, h.tokens.arjun, "Reorder Mom's metformin", "session-arjun-1");
      assert.match(again.reply, /Priya already requested a refill/);
    } finally {
      await h.close();
    }
  });

  test("double-dose guard surfaces through the assistant across caregivers", async () => {
    const h = await startHarness();
    try {
      await say(h.base, h.tokens.priya, "Mom took her metformin");
      const r = await say(h.base, h.tokens.arjun, "I just gave Mom her metformin", "session-arjun-2");
      assert.match(r.reply, /already logged as taken at 8:10 AM by Priya/);
      const yes = await say(h.base, h.tokens.arjun, "Yes, she really did get an extra one", "session-arjun-2");
      assert.match(yes.reply, /Recorded a second/);
    } finally {
      await h.close();
    }
  });

  test("view-only caregiver can ask but cannot log", async () => {
    const h = await startHarness();
    try {
      const r = await say(h.base, h.tokens.maria, "Mom took her metformin", "session-maria-1");
      assert.ok(r.tools.some((t) => t.name === "log_dose" && t.isError));
    } finally {
      await h.close();
    }
  });

  test("agent API validates input and requires auth", async () => {
    const h = await startHarness();
    try {
      const unauth = await fetch(`${h.base}/api/agent/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi", sessionId: "abcdefgh" }) });
      assert.equal(unauth.status, 401);
      const bad = await fetch(`${h.base}/api/agent/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${h.tokens.priya}` },
        body: JSON.stringify({ text: "x".repeat(600), sessionId: "abcdefgh" }),
      });
      assert.equal(bad.status, 400);
    } finally {
      await h.close();
    }
  });
});

/** Scripted stand-in for BedrockRuntimeClient: returns queued Converse responses and records requests. */
class FakeBedrock {
  calls: ConverseCommand["input"][] = [];
  private readonly script: ((input: ConverseCommand["input"]) => ConverseCommandOutput)[];
  constructor(script: ((input: ConverseCommand["input"]) => ConverseCommandOutput)[]) {
    this.script = script;
  }
  async send(cmd: ConverseCommand): Promise<ConverseCommandOutput> {
    this.calls.push(structuredClone(cmd.input));
    const next = this.script.shift();
    if (!next) throw new Error("FakeBedrock: no more scripted responses");
    return next(cmd.input);
  }
}

const toolUse = (id: string, name: string, input: Record<string, unknown>): ConverseCommandOutput => ({
  $metadata: {},
  stopReason: "tool_use",
  output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: id, name, input: input as never } }] } },
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  metrics: { latencyMs: 1 },
});
const say_ = (text: string): ConverseCommandOutput => ({
  $metadata: {},
  stopReason: "end_turn",
  output: { message: { role: "assistant", content: [{ text }] } },
  usage: { inputTokens: 150, outputTokens: 15, totalTokens: 165 },
  metrics: { latencyMs: 1 },
});

describe("Amazon Bedrock engine (Converse tool-use loop, mocked client)", () => {
  test("MCP tools become Bedrock toolSpecs and toolUse blocks run as MCP tools/call", async () => {
    const fake = new FakeBedrock([
      () => toolUse("t1", "get_care_status", { person: "Mom" }),
      (input) => {
        const last = input.messages!.at(-1)!;
        const tr = last.content![0]!.toolResult!;
        assert.equal(tr.toolUseId, "t1");
        assert.equal(tr.status, "success");
        assert.ok(tr.content!.some((c) => c.json), "structuredContent passed as json block");
        return say_("Lakshmi's 8 AM metformin is due now.");
      },
    ]);
    const engine = new BedrockEngine({ region: "us-east-1", modelId: "test-model", client: fake as unknown as BedrockRuntimeClient });
    const h = await startHarness({ bedrock: engine });
    try {
      const r = await say(h.base, h.tokens.priya, "Did Mom take her pills?");
      assert.equal(r.engine, "bedrock");
      assert.equal(r.reply, "Lakshmi's 8 AM metformin is due now.");
      assert.deepEqual(r.tools.map((t) => t.name), ["get_care_status"]);
      const first = fake.calls[0]!;
      assert.equal(first.modelId, "test-model");
      assert.ok(first.toolConfig!.tools!.length === 13);
      assert.match(first.system![0]!.text!, /Speaker is|speaker is Priya/i);
      assert.ok(!JSON.stringify(first.toolConfig).includes("$schema"), "Bedrock rejects $schema");
    } finally {
      await h.close();
    }
  });

  test("host policy blocks a model that tries to self-confirm a refill in the same turn", async () => {
    let actionId = "";
    const fake = new FakeBedrock([
      () => toolUse("t1", "request_refill", { medication: "metformin", person: "Mom" }),
      (input) => {
        const tr = input.messages!.at(-1)!.content![0]!.toolResult!;
        actionId = (tr.content!.find((c) => c.json)!.json as { actionId: string }).actionId;
        return toolUse("t2", "confirm_action", { action_id: actionId });
      },
      (input) => {
        const tr = input.messages!.at(-1)!.content![0]!.toolResult!;
        assert.equal(tr.status, "error");
        assert.match(tr.content![0]!.text!, /HOST_POLICY/);
        return say_("I can request a refill of Mom's metformin from Maple Street Pharmacy. Should I go ahead?");
      },
      // Next turn: the user says yes; now confirm is allowed.
      () => toolUse("t3", "confirm_action", { action_id: actionId }),
      () => say_("Done, the refill is requested."),
    ]);
    const engine = new BedrockEngine({ region: "us-east-1", modelId: "test-model", client: fake as unknown as BedrockRuntimeClient });
    const h = await startHarness({ bedrock: engine });
    try {
      const t1 = await say(h.base, h.tokens.priya, "Yes, reorder Mom's metformin");
      const blocked = t1.tools.find((t) => t.name === "confirm_action")!;
      assert.ok(blocked.blockedByHost, "same-turn self-confirmation must be blocked");
      const t2 = await say(h.base, h.tokens.priya, "Yes please");
      const ok = t2.tools.find((t) => t.name === "confirm_action")!;
      assert.ok(!ok.isError && !ok.blockedByHost, JSON.stringify(t2.tools));
      // Conversation history carried over to the second turn.
      assert.ok(fake.calls[3]!.messages!.length > 2);
    } finally {
      await h.close();
    }
  });
});

describe("Amazon Bedrock Guardrails", () => {
  test("only the user's words are guarded, and a blocked turn is kept out of history", async () => {
    const fake = new FakeBedrock([
      () => ({
        $metadata: {},
        stopReason: "guardrail_intervened",
        output: { message: { role: "assistant", content: [{ text: "I can't give medical advice. Please call the pharmacist or doctor." }] } },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        metrics: { latencyMs: 1 },
      }),
      () => say_("Lakshmi has two doses left today."),
    ]);
    const engine = new BedrockEngine({ region: "us-east-1", modelId: "m", guardrail: { id: "gr-123", version: "1" }, client: fake as unknown as BedrockRuntimeClient });
    const h = await startHarness({ bedrock: engine });
    try {
      const blocked = (await say(h.base, h.tokens.priya, "Mom missed a dose, should she take two now?")) as TurnBody & { guardrail: { configured: boolean; intervened: boolean } };
      assert.deepEqual(blocked.guardrail, { configured: true, intervened: true });
      assert.match(blocked.reply, /can't give medical advice/);
      const req = fake.calls[0]!;
      assert.deepEqual(req.guardrailConfig, { guardrailIdentifier: "gr-123", guardrailVersion: "1", trace: "enabled" });
      assert.deepEqual(req.messages!.at(-1)!.content, [{ guardContent: { text: { text: "Mom missed a dose, should she take two now?" } } }]);
      await say(h.base, h.tokens.priya, "What's left for Mom today?");
      assert.equal(fake.calls[1]!.messages!.length, 1, "blocked exchange was not carried into history");
    } finally {
      await h.close();
    }
  });
});

describe("helpers", () => {
  test("toBedrockTool strips $schema and keeps the JSON schema", () => {
    const spec = toBedrockTool({ name: "x", description: "d", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } } } } as never);
    assert.deepEqual(spec.toolSpec!.inputSchema!.json, { type: "object", properties: { a: { type: "string" } } });
  });

  test("trimHistory never starts on an orphaned toolResult", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ text: "hi" }] },
      { role: "assistant", content: [{ toolUse: { toolUseId: "1", name: "a", input: {} } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "1", content: [{ text: "r" }] } }] },
      { role: "assistant", content: [{ text: "ok" }] },
    ];
    for (let i = 0; i < 12; i++) msgs.push(...structuredClone(msgs.slice(0, 4)));
    const t = trimHistory(msgs);
    assert.ok(t.length <= 24);
    assert.equal(t[0]!.role, "user");
    assert.ok(t[0]!.content![0]!.text);
  });

  test("parseSlotTime understands spoken times", () => {
    assert.equal(parseSlotTime("her 8 pm dose"), "20:00");
    assert.equal(parseSlotTime("the 8:30am one"), "08:30");
    assert.equal(parseSlotTime("12 a.m."), "00:00");
    assert.equal(parseSlotTime("at 20:00"), "20:00");
    assert.equal(parseSlotTime("no time here"), undefined);
  });
});
