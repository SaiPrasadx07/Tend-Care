// Offline dialogue manager: the assistant used when no LLM is configured.
// It is deterministic, not generative. It understands intent and entities
// (intent.ts), keeps short-term conversational context, asks clarifying
// questions instead of dumping data, and composes replies only from verified
// MCP tool results. Every read and write is a real MCP tools/call, so the
// server's permission and safety rules still apply.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AFFIRMATIVE, NEGATIVE, classify, scopeOf, type Entities, type HouseholdPerson, type TimeScope, type Understanding } from "./intent.ts";

export { AFFIRMATIVE, NEGATIVE, parseSlotTime } from "./intent.ts";

type Pending =
  | { type: "refill_confirm"; actionId: string; person: string; med: string }
  | { type: "duplicate"; args: Record<string, unknown>; person: string; med: string }
  | { type: "confirm_log"; args: Record<string, unknown>; person: string; med: string; status: "taken" | "skipped" }
  | { type: "which_person"; intent: Understanding["intent"]; entities: Entities; candidates: string[] }
  | { type: "vague" }
  | { type: "which_med"; person?: string; intent: Understanding["intent"] }
  | { type: "offer_refill"; person: string; med: string };

export interface OfflineSession {
  person?: string;
  medication?: string;
  lastIntent?: Understanding["intent"];
  lastScope?: TimeScope;
  /** Words the user uses for people ("Mom"), so replies mirror their language. */
  words: Record<string, string>;
  pending?: Pending;
  household?: HouseholdPerson[];
  householdAt?: number;
}

export function newOfflineSession(): OfflineSession {
  return { words: {} };
}

export interface OfflineOptions {
  timezone: string;
  now?: () => Date;
  actorName: string;
}

export interface OfflineReply {
  reply: string;
  /** Spoken form when it should differ from the text (e.g. omit a long drafted message). */
  speech?: string;
}

type Call = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

interface Slot { medicationId: string; medication: string; time: string; state: string; dose: string; instructions: string; recordedAt: string | null; loggedBy: string | null }
interface PersonStatus { name: string; slots: Slot[]; counts: Record<string, number> }
interface Forecast { medicationId: string; personName: string; medication: string; daysLeft: number; runoutDate: string; refillsRemaining: number; openRefillRequest: boolean; urgency: string; quantityOnHand: number }

const HOUSEHOLD_TTL_MS = 30_000;
const FEMALE = new Set(["mom", "mum", "amma", "mother", "grandma", "nani", "aunt"]);
const MALE = new Set(["dad", "appa", "father", "grandpa", "nana", "uncle"]);

// ---------- phrasing helpers ----------
const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const short = (label: string) => label.split(" ")[0]!;

export function t12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** Turn display text into something pleasant to hear. Same facts, spoken form. */
export function toSpeech(text: string): string {
  return text
    .replace(/\b(\d+(?:\.\d+)?)\s?mg\b/gi, "$1 milligrams")
    .replace(/\b(\d+(?:\.\d+)?)\s?mcg\b/gi, "$1 micrograms")
    .replace(/\b(\d+(?:\.\d+)?)\s?ml\b/gi, "$1 milliliters")
    .replace(/\b(\d{1,2}):00\s?(AM|PM)\b/g, "$1 $2")
    .replace(/[“”"]/g, "")
    .replace(/\s+—\s+/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function data(r: CallToolResult): Record<string, unknown> {
  return (r.structuredContent as Record<string, unknown> | undefined) ?? {};
}
function errorText(r: CallToolResult): string {
  const first = r.content.find((c) => c.type === "text");
  const text = first && first.type === "text" ? first.text : "Something went wrong.";
  return text.replace(/^[A-Z_]+:\s*/, "").replace(/^MCP error -?\d+:\s*/, "");
}

export async function runOffline(text: string, session: OfflineSession, call: Call, opts: OfflineOptions): Promise<OfflineReply> {
  const now = opts.now ?? (() => new Date());
  const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: opts.timezone });
  const localMinutes = () => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: opts.timezone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now());
    return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value);
  };

  // Household (names, aliases, medications) for entity resolution; cached briefly to avoid a lookup every turn.
  if (!session.household || Date.now() - (session.householdAt ?? 0) > HOUSEHOLD_TTL_MS) {
    const r = await call("list_care_recipients", {});
    if (r.isError) return { reply: `I couldn't reach the care record just now. ${errorText(r)}` };
    session.household = ((data(r).people as HouseholdPerson[] | undefined) ?? []);
    session.householdAt = Date.now();
  }
  const household = session.household;
  const u = classify(text, household);
  const e = u.entities;
  for (const p of e.people.slice(0, 1)) if (e.personWord) session.words[p] = e.personWord;

  // Mirror the family's words: what the caregiver called them, else the household alias ("Mom"), else the name.
  const ref = (name: string) => session.words[name] ?? household.find((p) => p.name === name)?.aliases[0] ?? name;
  const poss = (name: string) => `${ref(name)}'s`;
  const pron = (name: string) => {
    const w = ref(name).toLowerCase();
    return FEMALE.has(w) ? "her" : MALE.has(w) ? "his" : "their";
  };
  const ownersOf = (med: string) => household.filter((p) => p.medications.some((m) => m.name.toLowerCase() === med.toLowerCase())).map((p) => p.name);
  const everyoneWords = () => household.map((p) => session.words[p.name] ?? p.aliases[0] ?? p.name);
  const orList = (xs: string[]) => listJoin(xs).replace(/ and ([^,]+)$/, " or $1");

  // ---------- composers (each uses the minimum tool calls for the question) ----------
  async function status(person: string | undefined, scope: TimeScope | undefined): Promise<OfflineReply> {
    const r = await call("get_care_status", person ? { person } : {});
    if (r.isError) return { reply: errorText(r) };
    const people = (data(r).people as PersonStatus[]) ?? [];
    session.lastIntent = "status";
    session.lastScope = scope;
    if (person) session.person = person;
    const lines = people.map((p) => personDay(p, scope, people.length === 1));
    return { reply: lines.join(" ") };
  }

  function inScope(time: string, scope: TimeScope | undefined): boolean {
    if (!scope) return true;
    if (scope === "now") {
      const m = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
      return Math.abs(m - localMinutes()) <= 120;
    }
    return scopeOf(time) === scope;
  }

  function personDay(p: PersonStatus, scope: TimeScope | undefined, solo: boolean): string {
    const slots = p.slots.filter((s) => inScope(s.time, scope));
    const who = solo ? poss(p.name) : poss(p.name);
    const when = scope === "evening" ? "tonight" : scope === "morning" ? "this morning" : scope === "afternoon" ? "this afternoon" : scope === "now" ? "right now" : "today";
    if (!slots.length) return `${cap(ref(p.name))} has nothing scheduled ${when}.`;
    const by = (st: string) => slots.filter((s) => s.state === st);
    const names = (xs: Slot[]) => listJoin([...new Set(xs.map((s) => short(s.medication)))]);
    // "8 AM Lisinopril and Metformin" or "8 AM Lisinopril and 9 PM Atorvastatin"
    const grouped = (xs: Slot[]) => {
      const byTime = new Map<string, string[]>();
      for (const x of xs) byTime.set(x.time, [...(byTime.get(x.time) ?? []), short(x.medication)]);
      return listJoin([...byTime].map(([time, meds]) => `${t12(time)} ${listJoin(meds)}`));
    };
    const missed = by("missed");
    const due = by("due");
    const upcoming = by("upcoming");
    const done = slots.filter((s) => s.state === "taken");
    const parts: string[] = [];
    if (missed.length) parts.push(`${who} ${grouped(missed)} ${missed.length === 1 ? "hasn't" : "haven't"} been logged`);
    if (due.length) parts.push(`${missed.length ? "and" : who} ${names(due)} ${due.length === 1 ? "is" : "are"} due now`);
    if (parts.length) {
      let s = `${cap(parts.join(" "))}.`;
      if (upcoming.length && scope) s += ` Still to come ${when}: ${upcoming.map((x) => `${short(x.medication)} at ${t12(x.time)}`).join(" and ")}.`;
      return s;
    }
    if (upcoming.length && !done.length) {
      return `${cap(ref(p.name))} has ${listJoin(upcoming.map((x) => `${short(x.medication)} at ${t12(x.time)}`))} ${when}. None of these has come due yet.`;
    }
    if (upcoming.length) {
      const next = upcoming[0]!;
      return `${cap(ref(p.name))} is on track ${when}: ${done.length} of ${slots.length} doses given. Next is ${short(next.medication)} at ${t12(next.time)}.`;
    }
    const skipped = by("skipped");
    return `All of ${poss(p.name)} doses ${when} are logged${skipped.length ? `, with ${names(skipped)} marked skipped` : ""}.`;
  }

  async function medInfo(person: string, med: string): Promise<OfflineReply> {
    const [st, fc] = await Promise.all([call("get_care_status", { person }), call("forecast_refills", { person, within_days: 7 })]);
    if (st.isError) return { reply: errorText(st) };
    const p = ((data(st).people as PersonStatus[]) ?? [])[0];
    const info = household.find((h) => h.name === person)?.medications.find((m) => m.name.toLowerCase() === med.toLowerCase());
    const slots = (p?.slots ?? []).filter((s) => short(s.medication).toLowerCase() === med.toLowerCase());
    const f = ((data(fc).items as Forecast[]) ?? []).find((x) => short(x.medication).toLowerCase() === med.toLowerCase());
    session.person = person;
    session.medication = med;
    session.lastIntent = "med_info";
    const label = info?.label ?? med;
    const sched = slots[0]?.instructions ? `, ${slots[0].instructions}` : "";
    let reply = `${poss(person)} ${label} is scheduled at ${listJoin((info?.times ?? slots.map((s) => s.time)).map(t12))}${sched}.`;
    const states = slots.map((s) => {
      if (s.state === "taken") return `the ${t12(s.time)} dose was given${s.recordedAt ? ` at ${clock(s.recordedAt)}` : ""}${s.loggedBy ? ` by ${s.loggedBy}` : ""}`;
      if (s.state === "missed") return `the ${t12(s.time)} dose hasn't been logged`;
      if (s.state === "due") return `the ${t12(s.time)} dose is due now`;
      if (s.state === "skipped") return `the ${t12(s.time)} dose was marked skipped`;
      return `the ${t12(s.time)} dose is still to come`;
    });
    if (states.length) reply += ` Today, ${listJoin(states)}.`;
    if (f) {
      reply += ` About ${plural(f.daysLeft, "day")} of supply left`;
      reply += f.openRefillRequest ? "; a refill has already been requested." : f.urgency !== "ok" ? (f.refillsRemaining > 0 ? `, so it's time to request a refill.` : `, and there are no refills left on the prescription.`) : ".";
    }
    return { reply };
  }

  async function supply(person: string | undefined, med: string | undefined): Promise<OfflineReply> {
    const r = await call("forecast_refills", { ...(person ? { person } : {}), within_days: 7 });
    if (r.isError) return { reply: errorText(r) };
    const items = (data(r).items as Forecast[]) ?? [];
    session.lastIntent = "supply";
    if (person) session.person = person;
    const describe = (f: Forecast) => {
      let s = `${poss(f.personName)} ${short(f.medication)} has about ${plural(f.daysLeft, "day")} left`;
      if (f.openRefillRequest) s += ", and a refill has already been requested";
      else if (f.urgency !== "ok") s += f.refillsRemaining > 0 ? `; ${plural(f.refillsRemaining, "refill")} remain on the prescription` : "; there are no refills left, so the prescriber needs to authorize a new one";
      return `${s}.`;
    };
    if (med) {
      const f = items.find((x) => short(x.medication).toLowerCase() === med.toLowerCase() && (!person || x.personName === person));
      session.medication = med;
      return { reply: f ? describe(f) : `I don't have supply information for ${med}.` };
    }
    const low = items.filter((f) => f.urgency !== "ok");
    if (!low.length) return { reply: `Nothing is running low. Every medication${person ? ` for ${ref(person)}` : ""} has more than a week of supply.` };
    const rest = items.length - low.length;
    let reply = low.map(describe).join(" ");
    if (rest) reply += ` Everything else has more than a week.`;
    const requestable = low.find((f) => !f.openRefillRequest && f.refillsRemaining > 0);
    if (requestable) {
      session.pending = { type: "offer_refill", person: requestable.personName, med: short(requestable.medication) };
      reply += ` Want me to prepare a refill request for ${poss(requestable.personName)} ${short(requestable.medication)}?`;
    }
    return { reply };
  }

  async function logDose(person: string, med: string, status: "taken" | "skipped", slotTime?: string, confirmDuplicate = false): Promise<OfflineReply> {
    const args: Record<string, unknown> = { medication: med, person, status, ...(slotTime ? { slot_time: slotTime } : {}), ...(confirmDuplicate ? { confirm_duplicate: true } : {}) };
    const r = await call("log_dose", args);
    if (r.isError) return { reply: errorText(r) };
    const d = data(r) as { outcome: string; slotTime: string; medication: string; previous: { recordedAt: string; loggedBy: string } | null; supplyWarning: string | null; message: string };
    session.person = person;
    session.medication = med;
    session.lastIntent = status === "taken" ? "log_taken" : "log_skipped";
    if (d.outcome === "needs_confirmation" && d.previous) {
      session.pending = { type: "duplicate", args: { ...args, slot_time: d.slotTime }, person, med };
      return {
        reply: `${poss(person)} ${t12(d.slotTime)} ${short(d.medication)} was already logged as taken at ${clock(d.previous.recordedAt)} by ${d.previous.loggedBy}, so I haven't added another entry. Please check with ${d.previous.loggedBy}; if a second dose really was given, tell me and I'll record it as an extra dose.`,
      };
    }
    if (confirmDuplicate) return { reply: d.message };
    const what = `${poss(person)} ${t12(d.slotTime)} ${short(d.medication)}`;
    let reply = status === "taken" ? `Logged: ${what} is recorded as given.` : `Okay, ${what} is marked as skipped.`;
    if (d.supplyWarning) reply += ` ${d.supplyWarning.replace(/^Only/, "There are only")}`;
    return { reply };
  }

  /** Resolve who a write is about. Never guesses between people. */
  function resolveForWrite(med: string | undefined): { person?: string; candidates: string[] } {
    if (e.people.length === 1) return { person: e.people[0], candidates: [] };
    if (med) {
      const owners = ownersOf(med);
      if (owners.length === 1) return { person: owners[0], candidates: [] };
      if (e.pronoun && session.person && owners.includes(session.person)) return { person: session.person, candidates: [] };
      return { candidates: owners };
    }
    if (e.pronoun && session.person) return { person: session.person, candidates: [] };
    if (household.length === 1) return { person: household[0]!.name, candidates: [] };
    return { candidates: household.map((p) => p.name) };
  }

  const askWho = (intent: Understanding["intent"], candidates: string[], what: string): OfflineReply => {
    session.pending = { type: "which_person", intent, entities: e, candidates };
    return { reply: `Is that ${what} for ${orList(candidates.map((c) => session.words[c] ?? household.find((h) => h.name === c)?.aliases[0] ?? c))}?` };
  };

  async function handle(intent: Understanding["intent"]): Promise<OfflineReply> {
    const person = e.people[0] ?? (e.pronoun ? session.person : undefined);
    const med = e.meds[0]?.name;
    switch (intent) {
      case "greeting":
        return { reply: `Hi ${opts.actorName}. I can check what's due, log a dose, look at supplies or prepare a handoff. What do you need?` };
      case "thanks":
        return { reply: "You're welcome." };
      case "help":
        return { reply: "Ask me what's due today, tell me when a dose was given or skipped, check how long a medicine will last, request a refill, add a note about how someone is doing, or ask for a handoff summary." };
      case "advice":
        return { reply: "I can't advise on changing, skipping or combining doses. That's a question for the pharmacist or doctor. If it helps, I can add a note so the care circle knows you asked." };
      case "vague_medication": {
        session.pending = { type: "vague" };
        const who = household.length === 1 ? ref(household[0]!.name) : orList(everyoneWords());
        return { reply: `Happy to help. Are you checking what ${who} needs to take today, or asking about a particular medicine?` };
      }
      case "status":
        if (med) return intentWithMed("med_info", person, med);
        return status(person, e.timeScope);
      case "med_info":
        return intentWithMed("med_info", person, med);
      case "supply":
        return supply(person, med);
      case "handoff": {
        const r = await call("get_handoff_report", { ...(person ? { person } : {}), days: 7 });
        if (r.isError) return { reply: errorText(r) };
        const d = data(r) as { people: { name: string; overallAdherencePct: number | null; missedDoses: unknown[]; notes: { text: string; loggedBy: string }[] }[]; supplyAlerts: unknown[]; openRefillRequests: unknown[] };
        session.lastIntent = "handoff";
        const lines = d.people.map((p) => {
          let s = `${cap(ref(p.name))}: ${p.overallAdherencePct == null ? "no doses due yet" : `${p.overallAdherencePct}% of doses given`}`;
          s += p.missedDoses.length ? `, ${plural(p.missedDoses.length, "missed dose")}` : ", none missed";
          if (p.notes.length) s += `. Latest note from ${p.notes.at(-1)!.loggedBy}: ${p.notes.at(-1)!.text.replace(/[.!?]+$/, "")}`;
          return `${s}.`;
        });
        let reply = `Over the past week: ${lines.join(" ")}`;
        const follow: string[] = [];
        if (d.supplyAlerts.length) follow.push(plural(d.supplyAlerts.length, "medication") + " running low");
        if (d.openRefillRequests.length) follow.push(plural(d.openRefillRequests.length, "open refill request"));
        if (follow.length) reply += ` To follow up: ${listJoin(follow)}.`;
        reply += " The full report is on the Handoff page.";
        return { reply };
      }
      case "activity": {
        const r = await call("get_recent_activity", { limit: 3 });
        if (r.isError) return { reply: errorText(r) };
        const items = (data(r).items as { message: string }[]) ?? [];
        return { reply: items.length ? `Most recently, ${items[0]!.message.charAt(0).toLowerCase() + items[0]!.message.slice(1)}${items[1] ? ` Before that, ${items[1].message.charAt(0).toLowerCase() + items[1].message.slice(1)}` : ""}` : "Nothing has been recorded yet." };
      }
      case "log_taken":
      case "log_skipped": {
        const status = intent === "log_taken" ? "taken" : "skipped";
        const m = med ?? (e.pronoun || /\b(it|them|the dose|the pill)\b/.test(u.normalized) ? session.medication : undefined);
        if (!m) {
          session.pending = { type: "which_med", person, intent };
          return { reply: `Which medicine was ${status === "taken" ? "given" : "skipped"}${person ? ` for ${ref(person)}` : ""}?` };
        }
        const who = resolveForWrite(m);
        if (!who.person) return askWho(intent, who.candidates, m);
        if (e.hedged) {
          session.pending = { type: "confirm_log", args: {}, person: who.person, med: m, status };
          return { reply: `I'll only record it once we're sure. Did ${ref(who.person)} definitely ${status === "taken" ? `take ${pron(who.person) === "their" ? "the" : pron(who.person)} ${m}` : `skip the ${m}`}?` };
        }
        return logDose(who.person, m, status, e.slotTime);
      }
      case "refill_request": {
        const m = med ?? session.medication;
        if (!m) return { reply: `Which medicine should I request a refill for?` };
        const who = resolveForWrite(m);
        if (!who.person) return askWho(intent, who.candidates, `refill of ${m}`);
        const r = await call("request_refill", { medication: m, person: who.person });
        if (r.isError) return { reply: errorText(r) };
        const d = data(r) as { actionId: string; summary: string };
        session.pending = { type: "refill_confirm", actionId: d.actionId, person: who.person, med: m };
        session.person = who.person;
        session.medication = m;
        return { reply: `${d.summary} Should I go ahead?` };
      }
      case "pickup": {
        const m = med ?? session.medication;
        if (!m || !e.quantity) return { reply: "How many tablets were picked up, and for which medicine?" };
        const who = resolveForWrite(m);
        if (!who.person) return askWho(intent, who.candidates, `pickup of ${m}`);
        const r = await call("record_refill_pickup", { medication: m, person: who.person, quantity: e.quantity });
        return { reply: r.isError ? errorText(r) : String(data(r).message ?? "Recorded.") };
      }
      case "note": {
        const who = e.people.length === 1 ? { person: e.people[0], candidates: [] as string[] } : resolveForWrite(undefined);
        if (!who.person) return askWho(intent, who.candidates, "note");
        const noteText = text.replace(/^\s*(alexa[,\s]+)?(please\s+)?(add a |make a |take a )?note( that| for \w+)?[:,]?\s*/i, "").replace(/^remember that\s*/i, "").trim();
        const category = /\bappointment\b/i.test(text) ? "appointment" : /\b(dizzy|pain|nause|tired|fever|cough|felt|feeling|fell|confused|sleepy)\b/i.test(text) ? "symptom" : "observation";
        const r = await call("add_care_note", { person: who.person, text: noteText || text, category });
        if (r.isError) return { reply: errorText(r) };
        session.person = who.person;
        return { reply: `Noted for ${ref(who.person)}. The care circle will see it in the next handoff.` };
      }
      case "followup": {
        const target = e.people[0] ?? session.person;
        const last = session.lastIntent;
        if (last === "med_info" && (e.meds[0] || e.people[0]) ) return intentWithMed("med_info", target, e.meds[0]?.name ?? session.medication);
        if (last === "supply") return supply(target, e.meds[0]?.name);
        if (e.meds[0]) return intentWithMed("med_info", target, e.meds[0].name);
        return status(target, e.timeScope ?? (e.people[0] ? session.lastScope : undefined));
      }
      case "affirm":
      case "deny":
        return { reply: intent === "affirm" ? "There's nothing waiting for a yes right now. What would you like to do?" : "Okay." };
      default:
        return { reply: "Sorry, I didn't catch that. You can ask what's due, log a dose, check supplies, request a refill, add a note or ask for a handoff." };
    }
  }

  async function intentWithMed(intent: "med_info", person: string | undefined, med: string | undefined): Promise<OfflineReply> {
    if (!med) {
      session.pending = { type: "which_med", person, intent };
      return { reply: "Which medicine would you like to know about?" };
    }
    const owners = ownersOf(med);
    const target = person && owners.includes(person) ? person : owners.length === 1 ? owners[0] : undefined;
    if (!target) {
      if (!owners.length) return { reply: `I don't have ${med} on file for anyone.` };
      return askWho(intent, owners, med);
    }
    return medInfo(target, med);
  }

  // ---------- pending clarifications take priority ----------
  const pending = session.pending;
  session.pending = undefined;
  if (pending) {
    switch (pending.type) {
      case "refill_confirm":
        if (u.intent === "affirm" || u.intent === "deny") {
          const r = await call(u.intent === "affirm" ? "confirm_action" : "cancel_action", { action_id: pending.actionId });
          if (r.isError) return { reply: errorText(r) };
          const d = data(r) as { message: string; pharmacyMessage?: string | null };
          if (u.intent === "deny") return { reply: "Okay, I've cancelled it. Nothing was requested." };
          return {
            reply: `${d.message}${d.pharmacyMessage ? ` Here's the draft: ${d.pharmacyMessage}` : ""}`,
            speech: toSpeech(`${d.message} The draft message is on screen.`),
          };
        }
        break;
      case "duplicate":
        if (u.intent === "affirm") {
          if (!/\b(extra|second|another|again|really|did|was given|two)\b/.test(u.normalized)) {
            session.pending = pending;
            return { reply: "Just to be sure: was a second dose actually given? Say “yes, a second dose was given” and I'll record it as an extra dose." };
          }
          return logDose(pending.person, pending.med, "taken", String(pending.args.slot_time ?? "") || undefined, true);
        }
        if (u.intent === "deny") return { reply: "Okay, nothing else is recorded. It stays as one dose." };
        break;
      case "confirm_log":
        if (u.intent === "affirm") return logDose(pending.person, pending.med, pending.status);
        if (u.intent === "deny") return { reply: "Okay, I won't record anything. Let me know once you've checked." };
        break;
      case "which_person": {
        const chosen = e.people.find((p) => pending.candidates.includes(p));
        if (chosen) {
          // Re-run the original request with the person now explicit.
          e.people = [chosen, ...e.people.filter((p) => p !== chosen)];
          Object.assign(e, { meds: pending.entities.meds, slotTime: pending.entities.slotTime ?? e.slotTime, quantity: pending.entities.quantity ?? e.quantity, hedged: pending.entities.hedged, timeScope: pending.entities.timeScope ?? e.timeScope });
          return handle(pending.intent);
        }
        if (u.intent === "deny") return { reply: "Okay, I'll leave it." };
        break;
      }
      case "vague":
        if (e.meds.length) return intentWithMed("med_info", e.people[0], e.meds[0]!.name);
        if (/\b(particular|specific|one|a medicine|certain)\b/.test(u.normalized)) {
          session.pending = { type: "which_med", person: e.people[0], intent: "med_info" };
          return { reply: "Which medicine?" };
        }
        if (/\b(today|need|due|take|schedule|what)\b/.test(u.normalized) || e.people.length || e.timeScope) return status(e.people[0], e.timeScope);
        break;
      case "which_med":
        if (e.meds.length) {
          if (pending.person && !e.people.length) e.people = [pending.person];
          return handle(pending.intent === "status" ? "med_info" : pending.intent);
        }
        break;
      case "offer_refill":
        if (u.intent === "affirm") {
          e.people = [pending.person];
          e.meds = [{ name: pending.med, owners: [pending.person] }];
          return handle("refill_request");
        }
        if (u.intent === "deny") return { reply: "Okay, I won't request it." };
        break;
    }
  }
  return handle(u.intent);
}
