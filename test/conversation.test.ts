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
    ["I am feeling depressed", "self_feeling"],
    ["I feel so tired", "self_feeling"],
    ["I am worried about Mom", "self_feeling"],
    ["Dad is having a migraine as well", "observation"],
    ["I think Dad has a fever", "observation"],
    ["Dad felt dizzy after lunch", "observation"],
    ["Is Mom feeling okay?", "overview"],
    ["No, I meant Mom", "correction"],
    ["Actually Dad", "correction"],
    ["Actually Dad took his amlodipine", "log_taken"],
    ["What does Dad take?", "regimen"],
    ["What meds is Mom on?", "regimen"],
    ["Dad missed his morning dose, what should I do?", "missed_advice"],
    ["What's the weather like?", "out_of_scope"],
    ["Play some music", "out_of_scope"],
    ["Remind me to give Dad his pills at 9", "out_of_scope"],
    // The caregiver clarifying that something is about themselves.
    ["nah its my feeling", "self_clarify"],
    ["No, it's me", "self_clarify"],
    ["I'm talking about myself", "self_clarify"],
    ["Not Mom or Dad", "self_clarify"],
    ["I am suffering from migraine", "self_feeling"],
    // Symptom phrasing, including speech-to-text slips.
    ["dad is suffering from migrain as well", "observation"],
    ["Dad is suffering from migraine", "observation"],
    ["Dad has a migraine.", "observation"],
    ["DAD HAS A MIGRAINE", "observation"],
    ["Dad has been having headaches", "observation"],
    ["My dad is suffering from migraine", "observation"],
    ["my mom is feeling low", "observation"],
    // Nearby phrases that are not symptoms or self-clarifications.
    ["Dad is having lunch", "followup"],
    ["Did Dad take his migraine tablet?", "status"],
    ["It's my dad", "followup"],
    ["I gave Dad his amlodipine", "log_taken"],
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

  test("regression: 'I am feeling depressed' is the caregiver's feeling, not a note about Mom or Dad", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      const t = await say("I am feeling depressed");
      assert.doesNotMatch(t.reply, /note for|Mom or Dad|\?$/, t.reply);
      assert.match(t.reply, /haven't added anything to the care record/);
      assert.deepEqual(t.tools.map((x) => x.name).filter((n) => n !== "list_care_recipients"), [], "no tools, nothing saved");
      // A bare yes afterwards doesn't save anything either.
      const yes = await say("yes");
      assert.equal(called(yes, "add_care_note").length, 0);
      for (const text of ["I'm so exhausted", "I feel overwhelmed today", "I am worried about Mom"]) {
        const r = await talker(h)(text);
        assert.equal(called(r, "add_care_note").length, 0, text);
        assert.doesNotMatch(r.reply, /note for/, text);
      }
    } finally {
      await h.close();
    }
  });

  test("regression: 'Dad is having a migraine as well' asks before saving, and saves only on yes", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      await say("I am feeling depressed");
      const ask = await say("Dad is having a migraine as well");
      assert.equal(called(ask, "add_care_note").length, 0, "nothing saved before confirmation");
      assert.match(ask.reply, /Should I add “Dad is having a migraine” to his notes/);
      assert.doesNotMatch(ask.reply, /depress/i, "the caregiver's feeling isn't carried onto Dad");
      const yes = await say("yes");
      const saved = called(yes, "add_care_note");
      assert.equal(saved.length, 1);
      assert.deepEqual(saved[0]!.arguments, { person: "Ravi", text: "Dad is having a migraine", category: "symptom" });
      assert.match(yes.reply, /^Added to Dad's notes\./);
      // Declining saves nothing.
      const say2 = talker(h);
      await say2("Mom seems confused today");
      const no = await say2("no");
      assert.equal(called(no, "add_care_note").length, 0);
      assert.equal(no.reply, "Okay, I haven't saved it.");
    } finally {
      await h.close();
    }
  });

  test("an observation with only a pronoun asks who, then names them in the saved note", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      const who = await say("She has a headache");
      assert.equal(who.reply, "Who has the headache, Mom or Dad?");
      const conf = await say("Mom");
      assert.equal(called(conf, "add_care_note").length, 0);
      const yes = await say("yes");
      assert.equal(called(yes, "add_care_note")[0]?.arguments.text, "Mom has a headache");
    } finally {
      await h.close();
    }
  });

  test("an explicit note keeps the original words after 'for Mom or Dad?'", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      await say("Note that he felt dizzy after lunch");
      const a = await say("Dad");
      assert.equal(called(a, "add_care_note")[0]?.arguments.text, "he felt dizzy after lunch");
    } finally {
      await h.close();
    }
  });

  test("crisis language gets safety guidance and nothing is recorded", async () => {
    const h = await startHarness();
    try {
      const t = await talker(h)("I want to end it all");
      assert.match(t.reply, /emergency number/);
      assert.match(t.reply, /988/);
      assert.deepEqual(t.tools.map((x) => x.name).filter((n) => n !== "list_care_recipients"), []);
    } finally {
      await h.close();
    }
  });

  test("'what does Dad take?' lists his medicines; 'no, I meant Mom' asks the same thing about Mom", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      const dad = await say("What does Dad take?");
      assert.equal(dad.reply, "Dad takes Amlodipine 5 mg at 9 AM.");
      const mom = await say("No, I meant Mom");
      assert.equal(mom.reply, "Mom takes Metformin 500 mg at 8 AM and 8 PM.");
      assert.deepEqual([...dad.tools, ...mom.tools].map((x) => x.name).filter((n) => n !== "list_care_recipients"), [], "read from the record, nothing written");
      // A correction re-asks the last question, not a generic "Okay."
      const st = await say("Did Dad take his pills?");
      assert.match(st.reply, /Dad/);
      const fix = await say("sorry, I meant Mom");
      assert.equal(called(fix, "get_care_status")[0]?.arguments.person, "Lakshmi");
      assert.match(fix.reply, /Mom|Metformin/);
    } finally {
      await h.close();
    }
  });

  test("a correction right after a dose was logged never re-logs or claims an undo; it offers a note", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      const logged = await say("I just gave Dad his amlodipine");
      assert.equal(called(logged, "log_dose").length, 1);
      const fix = await say("no, I meant Mom");
      assert.equal(called(fix, "log_dose").length, 0, "nothing logged for Mom by inference");
      assert.match(fix.reply, /already recorded for Dad, and I can't undo that by voice/);
      assert.equal(called(fix, "add_care_note").length, 0, "the note waits for a yes");
      const yes = await say("yes");
      const note = called(yes, "add_care_note")[0];
      assert.equal(note?.arguments.person, "Ravi");
      assert.match(String(note?.arguments.text), /recorded for Dad by mistake; it was meant for Mom/);
    } finally {
      await h.close();
    }
  });

  test("an observation pinned on the wrong person is moved before anything is saved", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      await say("Dad is having a migraine");
      const moved = await say("no, it's Mom who has the migraine");
      assert.equal(called(moved, "add_care_note").length, 0);
      assert.match(moved.reply, /Should I add “Mom is having a migraine” to her notes\?/);
      const yes = await say("yes");
      assert.deepEqual(called(yes, "add_care_note")[0]?.arguments, { person: "Lakshmi", text: "Mom is having a migraine", category: "symptom" });
    } finally {
      await h.close();
    }
  });

  test("'Dad missed his dose, what should I do?' states the record, defers to the pharmacist, and logs only when told", async () => {
    const h = await startHarness({ clockAt: ["2026-10-21", "14:00"] });
    try {
      const say = talker(h);
      const ask = await say("Dad missed his morning dose, what should I do?");
      assert.match(ask.reply, /^Dad's 9 AM Amlodipine hasn't been logged\./);
      assert.match(ask.reply, /label or the pharmacist/);
      assert.doesNotMatch(ask.reply, /\b(give it|take it now|double|skip it)\b/i, "no dosing instructions");
      assert.equal(called(ask, "log_dose").length, 0);
      const did = await say("he did take it");
      assert.deepEqual(called(did, "log_dose")[0]?.arguments, { medication: "Amlodipine", person: "Ravi", status: "taken" });
    } finally {
      await h.close();
    }
  });

  test("requests outside Tend get a clear boundary, not 'is that about Dad?' or the full help text", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      await say("Did Dad take his pills?");
      for (const text of ["What's the weather like?", "Play some music", "Set a timer for ten minutes"]) {
        const t = await say(text);
        assert.match(t.reply, /Mom and Dad/, text);
        assert.doesNotMatch(t.reply, /Is it about|still not following/, text);
        assert.deepEqual(t.tools.map((x) => x.name).filter((n) => n !== "list_care_recipients"), [], text);
      }
      const rem = await say("Remind me to give Dad his pills at 9");
      assert.match(rem.reply, /can't set reminders yet/);
      assert.equal(called(rem, "log_dose").length, 0);
    } finally {
      await h.close();
    }
  });

  test("regression: 'nah its my feeling' after a disclosure stays about the caregiver; 'dad' can't save it as Dad's note", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      const first = await say("i am feeling depressed");
      assert.match(first.reply, /haven't added anything to the care record/);
      const clarify = await say("nah its my feeling");
      assert.doesNotMatch(clarify.reply, /Who is that about|Mom or Dad\?/, clarify.reply);
      assert.match(clarify.reply, /that's about you, not Mom or Dad, so I haven't saved anything/);
      assert.doesNotMatch(clarify.reply, /diagnos|depression is/i, "no diagnosis");
      const dad = await say("dad");
      assert.equal(called(dad, "add_care_note").length, 0, "nothing saved");
      assert.doesNotMatch(dad.reply, /my feeling|Should I add/i, dad.reply);
      const all = [first, clarify, dad].flatMap((t) => t.tools.map((x) => x.name));
      assert.ok(!all.some((n) => ["add_care_note", "log_dose", "request_refill", "confirm_action"].includes(n)), all.join(","));
      // A separate care statement afterwards is a new observation, asked about normally.
      const migraine = await say("Dad is suffering from migrain as well");
      assert.match(migraine.reply, /Should I add “Dad is suffering from migraine” to his notes/);
      const yes = await say("yes");
      assert.deepEqual(called(yes, "add_care_note")[0]?.arguments, { person: "Ravi", text: "Dad is suffering from migraine", category: "symptom" });
    } finally {
      await h.close();
    }
  });

  test("self-clarifications drop a pending 'who is it about?' or note question without saving", async () => {
    const h = await startHarness();
    try {
      for (const clarify of ["no, it's me", "I'm talking about myself", "not Mom or Dad"]) {
        const say = talker(h);
        const ask = await say("feeling really low today");
        assert.match(ask.reply, /Who is that about, Mom or Dad\?/, "no context yet, so asking who is right");
        const c = await say(clarify);
        assert.match(c.reply, /that's about you/, clarify);
        const after = await say("Dad");
        assert.equal(called(after, "add_care_note").length, 0, clarify);
        assert.doesNotMatch(after.reply, /Should I add/, clarify);
      }
      // A pending note confirmation is dropped too, even though Mom and Dad are named.
      const say = talker(h);
      await say("Mom seems confused today");
      const c = await say("not Mom or Dad, it's me");
      assert.equal(called(c, "add_care_note").length, 0);
      const yes = await say("yes");
      assert.equal(called(yes, "add_care_note").length, 0, "the dropped note can't be confirmed later");
    } finally {
      await h.close();
    }
  });

  test("regression: 'dad is suffering from migrain as well' asks first, saves on yes, saves nothing on no", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      const ask = await say("dad is suffering from migrain as well");
      assert.equal(ask.reply.includes("outside what I can do") || ask.reply.includes("didn't follow"), false, ask.reply);
      assert.match(ask.reply, /Should I add “Dad is suffering from migraine” to his notes so the care circle knows\?/);
      assert.doesNotMatch(ask.reply, /doctor has been|contacted|take (a|an|some)|dose/i, "no advice, no implied clinician contact");
      assert.equal(called(ask, "add_care_note").length, 0);
      const yes = await say("yes");
      assert.deepEqual(called(yes, "add_care_note")[0]?.arguments, { person: "Ravi", text: "Dad is suffering from migraine", category: "symptom" });
      assert.match(yes.reply, /^Added to Dad's notes\./);
      const say2 = talker(h);
      await say2("Dad has been having headaches");
      const no = await say2("no");
      assert.equal(called(no, "add_care_note").length, 0);
      assert.equal(no.reply, "Okay, I haven't saved it.");
    } finally {
      await h.close();
    }
  });

  test("sad → 'just my feeling' → Dad's migraine → yes: only Dad's observation is saved", async () => {
    const h = await startHarness();
    try {
      const say = talker(h);
      const turns = [await say("Hey, I am sad."), await say("Nah, it's just my feeling.")];
      assert.match(turns[1]!.reply, /that's about you/);
      const ask = await say("Dad is suffering from migraine as well.");
      assert.match(ask.reply, /Should I add “Dad is suffering from migraine” to his notes/);
      const yes = await say("yes");
      turns.push(ask, yes);
      const notes = turns.flatMap((t) => called(t, "add_care_note"));
      assert.equal(notes.length, 1, "exactly one note, the observation");
      assert.deepEqual(notes[0]!.arguments, { person: "Ravi", text: "Dad is suffering from migraine", category: "symptom" });
      const report = await talker(h)("Give me the handoff for this week");
      assert.doesNotMatch(report.reply, /sad|my feeling/i);
    } finally {
      await h.close();
    }
  });

  test("a new request that names someone isn't swallowed by a pending note or 'who?' question", async () => {
    const h = await startHarness();
    try {
      // Pending "Should I add Dad has a headache?" then a question about Mom.
      let say = talker(h);
      await say("Dad has a headache");
      const q = await say("Did Mom take her metformin?");
      assert.doesNotMatch(q.reply, /Should I add/, q.reply);
      assert.equal(called(q, "get_care_status")[0]?.arguments.person, "Lakshmi");
      // Pending note, then a dose report about Mom: the dose is logged, the note is not retargeted.
      say = talker(h);
      await say("Dad has a headache");
      const log = await say("Mom took her metformin");
      assert.equal(called(log, "log_dose")[0]?.arguments.person, "Lakshmi");
      assert.equal(called(log, "add_care_note").length, 0);
      // Pending "Is that note for Mom or Dad?", then a question naming Mom: not answered as "Mom".
      say = talker(h);
      await say("Note that she is dizzy");
      const q2 = await say("Did Mom take her metformin?");
      assert.equal(called(q2, "add_care_note").length, 0, "the note isn't filed for Mom by a question");
      // A real correction still works.
      say = talker(h);
      await say("Dad has a headache");
      const fix = await say("no, it's Mom");
      assert.match(fix.reply, /Should I add “Mom has a headache” to her notes\?/);
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

  test("speech sets quoted note text apart with pauses", () => {
    assert.equal(toSpeech("Should I add “Dad has a headache” to his notes so the care circle knows?"), "Should I add, Dad has a headache, to his notes so the care circle knows?");
    assert.equal(toSpeech("For example: “Did Dad take his pills?”"), "For example: Did Dad take his pills?");
    assert.equal(toSpeech("Should I add “Mom is tired”?"), "Should I add, Mom is tired?");
  });

  test("speech expands units and tidies times", () => {
    assert.equal(toSpeech("Metformin 500 mg at 8:00 PM and Levothyroxine 50 mcg at 6:30 AM"), "Metformin 500 milligrams at 8 PM and Levothyroxine 50 micrograms at 6:30 AM");
  });
});
