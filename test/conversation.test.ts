// Conversational behaviour of the offline assistant: intent, clarification,
// context, grounding and safety. These run against the real MCP server (no LLM).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { classify, type HouseholdPerson } from "../src/agent/intent.ts";
import { runOffline, newOfflineSession, toSpeech } from "../src/agent/offline.ts";
import { startHarness, type Harness } from "./server-harness.ts";

interface Turn {
  reply: string;
  speech: string;
  tools: { name: string; arguments: Record<string, unknown>; isError: boolean }[];
}

function talker(h: Harness, who: keyof Harness["tokens"] = "priya", sessionId = `conv-${Math.random().toString(36).slice(2, 10)}`) {
  return async (text: string): Promise<Turn> => {
    const res = await fetch(`${h.base}/api/agent/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${h.tokens[who]}` },
      body: JSON.stringify({ text, sessionId }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as Turn;
  };
}
const called = (t: Turn, name: string) => t.tools.filter((x) => x.name === name);

const HOUSEHOLD: HouseholdPerson[] = [
  { name: "Lakshmi", aliases: ["Mom"], medications: [{ id: "m1", name: "Metformin", label: "Metformin 500 mg", times: ["08:00", "20:00"] }] },
  { name: "Ravi", aliases: ["Dad"], medications: [{ id: "m2", name: "Amlodipine", label: "Amlodipine 5 mg", times: ["09:00"] }] },
];

describe("intent understanding", () => {
  const cases: [string, string][] = [
    ["I want to know about the medicine", "vague_medication"],
    ["Tell me about the meds", "vague_medication"],
    ["What does Mom need to take today?", "status"],
    ["Did Dad take his pills?", "status"],
    ["What about tonight?", "followup"],
    ["And Dad?", "followup"],
    ["Tell me about Mom's metformin", "med_info"],
    ["When does Dad take amlodipine?", "med_info"],
    ["I just gave Dad his amlodipine", "log_taken"],
    ["Mom skipped her metformin", "log_skipped"],
    ["When will we run out of anything?", "supply"],
    ["Reorder Mom's metformin", "refill_request"],
    ["Note that Dad felt dizzy after lunch", "note"],
    ["Give me the handoff for this week", "handoff"],
    ["Should Mom take two pills since she missed one?", "advice"],
    ["Yes, go ahead", "affirm"],
    ["No, not now", "deny"],
    ["Hi Alexa.", "greeting"],
    ["Hi Alexa, did Dad take his pills?", "status"],
    ["How are Mum's medicines looking?", "overview"],
    ["Is Dad okay?", "overview"],
    ["What does Mom have tomorrow?", "status"],
  ];
  for (const [text, intent] of cases) {
    test(`"${text}" → ${intent}`, () => assert.equal(classify(text, HOUSEHOLD).intent, intent));
  }

  test("entities: aliases, possessives, pronouns, time scope, hedging", () => {
    const e = classify("Mom probably took her metformin this evening", HOUSEHOLD).entities;
    assert.deepEqual(e.people, ["Lakshmi"]);
    assert.equal(e.personWord, "Mom");
    assert.deepEqual(e.meds, [{ name: "Metformin", owners: ["Lakshmi"] }]);
    assert.equal(e.timeScope, "evening");
    assert.equal(e.hedged, true);
    assert.equal(classify("did she take it?", HOUSEHOLD).entities.pronoun, true);
  });

  test("entities: everyday alias variants, day and focus", () => {
    const mum = classify("How are Mum's medicines looking?", HOUSEHOLD).entities;
    assert.deepEqual(mum.people, ["Lakshmi"]);
    assert.equal(mum.personWord, "Mum");
    const did = classify("Hi Alexa, did Dad take his pills yesterday?", HOUSEHOLD).entities;
    assert.equal(did.day, "yesterday");
    assert.equal(did.focus, "taken");
    assert.equal(classify("What's left for Mom today?", HOUSEHOLD).entities.focus, "remaining");
    assert.equal(classify("What about tomorrow?", HOUSEHOLD).entities.day, "tomorrow");
  });
});

describe("conversation over MCP (offline engine)", () => {
  test("a vague medicine question gets a short clarifying question, not a data dump", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      const t = await say("I want to know about the medicine");
      assert.match(t.reply, /today, or asking about a particular medicine\?$/);
      assert.match(t.reply, /Mom or Dad/);
      assert.equal(called(t, "get_care_status").length, 0, "no status dump");
      assert.doesNotMatch(t.reply, /missed|due now|running low/i);
      assert.ok(t.reply.length < 140, `concise: ${t.reply}`);
      // Answering the clarification gets a focused answer.
      const t2 = await say("What Mom needs today");
      assert.deepEqual(called(t2, "get_care_status")[0]?.arguments, { person: "Lakshmi" });
      assert.match(t2.reply, /^Mom/);
    } finally {
      await h.close();
    }
  });

  test("clear questions get direct, person-scoped answers; follow-ups reuse context", async () => {
    const h = await startHarness({ clockAt: ["2026-10-21", "08:10"] });
    try {
      const say = talker(h);
      const a = await say("What does Mom need to take today?");
      assert.deepEqual(called(a, "get_care_status").map((x) => x.arguments), [{ person: "Lakshmi" }]);
      assert.equal(a.reply, "Mom's Metformin is due now.");
      const b = await say("What about tonight?");
      assert.deepEqual(called(b, "get_care_status")[0]?.arguments, { person: "Lakshmi" }, "carries Mom into the follow-up");
      assert.match(b.reply, /Metformin at 8 PM tonight/);
      const c = await say("And Dad?");
      assert.deepEqual(called(c, "get_care_status")[0]?.arguments, { person: "Ravi" });
      assert.match(c.reply, /^Dad/);
      assert.doesNotMatch(c.reply, /Mom|Metformin/);
    } finally {
      await h.close();
    }
  });

  test("a specific medicine question is answered from status and supply for that medicine only", async () => {
    const h = await startHarness({ clockAt: ["2026-10-21", "08:10"] });
    try {
      const t = await talker(h)("Tell me about Mom's metformin");
      assert.match(t.reply, /^Mom's Metformin 500 mg is scheduled at 8 AM and 8 PM\./);
      assert.match(t.reply, /the 8 AM dose is due now/);
      assert.match(t.reply, /About 5 days of supply left/);
      assert.doesNotMatch(t.reply, /Amlodipine|Dad/);
      assert.equal(t.speech.includes("500 milligrams"), true, "units are expanded for speech");
    } finally {
      await h.close();
    }
  });

  test("an ambiguous write asks who it was for and writes nothing until answered", async () => {
    const h = await startHarness({ clockAt: ["2026-10-21", "08:10"] });
    try {
      // Give Dad a metformin too, so "the metformin" is ambiguous.
      const transport = new StreamableHTTPClientTransport(new URL(h.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${h.tokens.priya}` } } });
      const client = new Client({ name: "setup", version: "1" });
      await client.connect(transport);
      const added = await client.callTool({ name: "add_medication", arguments: { person: "Dad", name: "Metformin", times: ["08:00"], quantity_on_hand: 30 } });
      assert.ok(!added.isError);
      await client.close();

      const say = talker(h);
      const q = await say("I gave the metformin");
      assert.equal(q.reply, "Is that metformin for Mom or Dad?".replace("metformin", "Metformin"));
      assert.equal(called(q, "log_dose").length, 0, "no write while ambiguous");
      const a = await say("Dad");
      const log = called(a, "log_dose");
      assert.equal(log.length, 1);
      assert.equal(log[0]!.arguments.person, "Ravi");
      assert.match(a.reply, /^Logged: Dad's 8 AM Metformin is recorded as given\./);
    } finally {
      await h.close();
    }
  });

  test("an unsure statement is not recorded as a dose until confirmed", async () => {
    const h = await startHarness({ clockAt: ["2026-10-21", "08:10"] });
    try {
      const say = talker(h);
      const q = await say("Mom probably took her metformin");
      assert.equal(called(q, "log_dose").length, 0);
      assert.match(q.reply, /Did Mom definitely take her Metformin\?/);
      const a = await say("Yes");
      assert.equal(called(a, "log_dose").length, 1);
      assert.match(a.reply, /recorded as given/);
    } finally {
      await h.close();
    }
  });

  test("duplicate dose: a bare yes is not enough to record a second dose", async () => {
    const h = await startHarness({ clockAt: ["2026-10-21", "08:10"] });
    try {
      await talker(h, "priya")("Mom took her metformin");
      const arjun = talker(h, "arjun");
      const warn = await arjun("I gave Mom her metformin");
      assert.match(warn.reply, /already logged as taken at 8:10 AM by Priya, so I haven't added another entry/);
      const yes = await arjun("yes");
      assert.equal(called(yes, "log_dose").length, 0, "plain yes does not write");
      assert.match(yes.reply, /was a second dose actually given\?/);
      const sure = await arjun("yes, a second dose was given");
      assert.deepEqual(called(sure, "log_dose")[0]?.arguments.confirm_duplicate, true);
      assert.match(sure.reply, /Recorded a second/);
    } finally {
      await h.close();
    }
  });

  test("supply answer offers a refill; accepting only prepares it, confirming is a separate step", async () => {
    const h = await startHarness({ clockAt: ["2026-10-21", "08:10"] });
    try {
      const say = talker(h);
      const s = await say("Is anything running low?");
      assert.match(s.reply, /Mom's Metformin has about 5 days left/);
      assert.match(s.reply, /Want me to prepare a refill request for Mom's Metformin\?$/);
      const prep = await say("Yes please");
      assert.equal(called(prep, "request_refill").length, 1);
      assert.equal(called(prep, "confirm_action").length, 0, "accepting the offer only prepares the request");
      assert.match(prep.reply, /Should I go ahead\?$/);
      const done = await say("Yes, go ahead");
      assert.equal(called(done, "confirm_action").length, 1);
      assert.match(done.reply, /recorded/);
      assert.doesNotMatch(done.speech, /Hello Maple Street/, "the long draft is shown, not read aloud");
    } finally {
      await h.close();
    }
  });

  test("a greeting is a greeting: no capability list, and the introduction isn't repeated", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      const hi = await say("Hi Alexa.");
      assert.equal(hi.reply, "Hey Priya. What can I help you with today?");
      const again = await say("hello");
      assert.doesNotMatch(again.reply, /Priya|log a dose|handoff/);
      assert.ok(again.reply.length < 50, again.reply);
    } finally {
      await h.close();
    }
  });

  test("a check-in on one person summarizes their day and urgent supply, in the family's words", async () => {
    const h = await startHarness({ clockAt: ["2026-10-21", "08:10"] });
    try {
      const t = await talker(h)("How are Mum's medicines looking?");
      assert.deepEqual(called(t, "get_care_status")[0]?.arguments, { person: "Lakshmi" });
      assert.equal(called(t, "forecast_refills").length, 1);
      assert.match(t.reply, /Mum/, "mirrors 'Mum' even though the record says 'Mom'");
      assert.match(t.reply, /Metformin is down to about 5 days/);
      assert.match(t.reply, /0 of her 2 doses today, with Metformin due now/);
      assert.doesNotMatch(t.reply, /Dad|Amlodipine/);
      assert.equal(called(t, "request_refill").length, 0, "offering a refill doesn't prepare one");
    } finally {
      await h.close();
    }
  });

  test("'did Dad take his pills?' reports what was logged and never infers a dose from the schedule", async () => {
    const h = await startHarness({ clockAt: ["2026-10-21", "08:10"] });
    try {
      const say = talker(h);
      h.clock.set("2026-10-21", "07:00");
      const early = await say("Did Dad take his pills?");
      assert.equal(early.reply, "Nothing has come due for Dad yet today. Next is Amlodipine at 9 AM.");
      h.clock.set("2026-10-21", "12:30");
      const late = await say("Did Dad take his pills?");
      assert.match(late.reply, /^Not that I can see\./);
      assert.match(late.reply, /Dad.s 9 AM Amlodipine hasn.t been logged, so I can.t confirm he took it/);
      assert.doesNotMatch(late.reply, /was given|was logged as given/);
      // A follow-up about tomorrow resolves Dad from context and reads the schedule for that date.
      const tmr = await say("What about tomorrow?");
      assert.deepEqual(called(tmr, "get_care_status")[0]?.arguments, { person: "Ravi", date: "2026-10-22" });
      assert.equal(tmr.reply, "Tomorrow, Dad has Amlodipine at 9 AM.");
    } finally {
      await h.close();
    }
  });

  test("with no context, 'what about tomorrow?' asks which meaning was intended", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      const q = await say("What about tomorrow?");
      assert.equal(q.reply, "Do you mean tomorrow's doses, or whether anything will run out?");
      assert.equal(called(q, "get_care_status").length, 0);
      const a = await say("anything running out");
      assert.equal(called(a, "forecast_refills").length, 1);
      assert.match(a.reply, /run out by tomorrow/);
    } finally {
      await h.close();
    }
  });

  test("the fallback suggests a concrete next step, and only lists everything after a second miss", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      const first = await say("purple elephants");
      assert.match(first.reply, /Could you put it another way\?/);
      assert.doesNotMatch(first.reply, /handoff/);
      const second = await say("banana telephone");
      assert.match(second.reply, /still not following/);
      assert.match(second.reply, /handoff/);
    } finally {
      await h.close();
    }
  });

  test("a dose for another day is never logged against today", async () => {
    const h = await startHarness({ clockAt: ["2026-10-21", "08:10"] });
    try {
      const t = await talker(h)("Mom took her metformin yesterday");
      assert.equal(called(t, "log_dose").length, 0);
      assert.match(t.reply, /haven't recorded anything/);
    } finally {
      await h.close();
    }
  });

  test("medical advice is declined without touching the record", async () => {
    const h = await startHarness();
    try {
      const t = await talker(h)("Should Mom take two pills since she missed one?");
      assert.match(t.reply, /can't advise on changing, skipping or combining doses/);
      assert.deepEqual(t.tools.map((x) => x.name).filter((n) => n !== "list_care_recipients"), []);
    } finally {
      await h.close();
    }
  });
});

describe("dialogue manager with a failing tool layer", () => {
  const people = { people: HOUSEHOLD.map((p) => ({ ...p, medications: p.medications })) };
  const ok = (sc: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text: "ok" }], structuredContent: sc });
  const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

  test("a tool error is explained plainly and nothing is claimed as done", async () => {
    const calls: string[] = [];
    const call = async (name: string): Promise<CallToolResult> => {
      calls.push(name);
      if (name === "list_care_recipients") return ok(people);
      return fail("INTERNAL: Something went wrong on the Tend server. Please try again.");
    };
    const r = await runOffline("I just gave Dad his amlodipine", newOfflineSession(), call, { timezone: "UTC", actorName: "Priya" });
    assert.deepEqual(calls, ["list_care_recipients", "log_dose"]);
    assert.equal(r.reply, "Something went wrong on the Tend server. Please try again.");
    assert.doesNotMatch(r.reply, /Logged|recorded/);
  });

  test("an unreachable care record is reported, not papered over", async () => {
    const r = await runOffline("What's due today?", newOfflineSession(), async () => fail("TOOL_ERROR: fetch failed"), { timezone: "UTC", actorName: "Priya" });
    assert.match(r.reply, /^I couldn't reach the care record just now\./);
  });

  test("speech expands units and tidies times", () => {
    assert.equal(toSpeech("Metformin 500 mg at 8:00 PM and Levothyroxine 50 mcg at 6:30 AM"), "Metformin 500 milligrams at 8 PM and Levothyroxine 50 micrograms at 6:30 AM");
  });
});
