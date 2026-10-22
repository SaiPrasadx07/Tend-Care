// Offline dialogue manager: the assistant used when no LLM is configured.
// It is deterministic, not generative. It understands intent and entities
// (intent.ts), keeps short-term conversational context, asks clarifying
// questions instead of dumping data, and composes replies only from verified
// MCP tool results. Every read and write is a real MCP tools/call, so the
// server's permission and safety rules still apply.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AFFIRMATIVE, NEGATIVE, REMINDER, SYMPTOM, classify, scopeOf, type Day, type Entities, type Focus, type HouseholdPerson, type TimeScope, type Understanding } from "./intent.ts";

export { AFFIRMATIVE, NEGATIVE, parseSlotTime } from "./intent.ts";

type Pending =
  | { type: "refill_confirm"; actionId: string; person: string; med: string }
  | { type: "duplicate"; args: Record<string, unknown>; person: string; med: string }
  | { type: "confirm_log"; args: Record<string, unknown>; person: string; med: string; status: "taken" | "skipped" }
  | { type: "which_person"; intent: Understanding["intent"]; entities: Entities; candidates: string[]; text: string }
  | { type: "confirm_note"; person: string; text: string; category: string; fixed?: boolean }
  | { type: "offer_checkin"; person?: string }
  | { type: "vague" }
  | { type: "which_med"; person?: string; intent: Understanding["intent"] }
  | { type: "offer_refill"; person: string; med: string }
  | { type: "which_aspect"; day: Exclude<Day, "today">; person?: string };

export interface OfflineSession {
  person?: string;
  medication?: string;
  lastIntent?: Understanding["intent"];
  lastScope?: TimeScope;
  lastDay?: Day;
  /** Turns so far: used to vary phrasing deterministically and to avoid repeating the introduction. */
  turns: number;
  greeted: boolean;
  /** Consecutive turns Tend couldn't understand; the second one gets the full list of what it can do. */
  misses: number;
  /** The last question answered, so "no, I meant Mom" can ask it again for someone else. */
  lastAsk?: { intent: Understanding["intent"]; timeScope?: TimeScope; focus?: Focus; day?: Day; med?: string };
  /** The last record written, and on which turn, so a correction right after it isn't silently ignored. */
  lastWrite?: { person: string; what: string; turn: number };
  /** Words the user uses for people ("Mom"), so replies mirror their language. */
  words: Record<string, string>;
  pending?: Pending;
  household?: HouseholdPerson[];
  householdAt?: number;
}

export function newOfflineSession(): OfflineSession {
  return { words: {}, turns: 0, greeted: false, misses: 0 };
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

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const numWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

/** Local calendar date (YYYY-MM-DD) in the household timezone, shifted by whole days. */
function localDate(now: Date, timezone: string, offsetDays = 0): string {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, day + offsetDays)).toISOString().slice(0, 10);
}

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
  /** The utterance a write is about. After "Is that for Mom or Dad?" it's the original request, not "Dad". */
  let sourceText = text;
  const e = u.entities;
  for (const p of e.people.slice(0, 1)) if (e.personWord) session.words[p] = e.personWord;

  // Mirror the family's words: what the caregiver called them, else the household alias ("Mom"), else the name.
  const ref = (name: string) => session.words[name] ?? household.find((p) => p.name === name)?.aliases[0] ?? name;
  const poss = (name: string) => `${ref(name)}'s`;
  const pron = (name: string) => {
    const w = ref(name).toLowerCase();
    return FEMALE.has(w) ? "her" : MALE.has(w) ? "his" : "their";
  };
  const subj = (name: string) => ({ her: "she", his: "he", their: "they" })[pron(name)];
  const ownersOf = (med: string) => household.filter((p) => p.medications.some((m) => m.name.toLowerCase() === med.toLowerCase())).map((p) => p.name);
  const everyoneWords = () => household.map((p) => session.words[p.name] ?? p.aliases[0] ?? p.name);
  const orList = (xs: string[]) => listJoin(xs).replace(/ and ([^,]+)$/, " or $1");
  // Deterministic variety: the same facts, phrased a little differently from turn to turn.
  session.turns = (session.turns ?? 0) + 1;
  const pick = (xs: string[]) => xs[session.turns % xs.length]!;
  const example = () => {
    const [a, b] = household;
    if (!a) return "What's due today?";
    return pick([`What's left for ${ref(a.name)} today?`, b ? `Did ${ref(b.name)} take ${pron(b.name)} pills?` : `Did ${ref(a.name)} take ${pron(a.name)} pills?`]);
  };
  /** "her" for Mom, "Ravi's" when no pronoun fits; used once a person is already named in the sentence. */
  const theirs = (name: string) => (pron(name) === "their" ? poss(name) : pron(name));
  /** "Lisinopril at 8 AM, Metformin at 8 AM and 8 PM, and Atorvastatin at 9 PM" */
  const scheduleText = (slots: Slot[]) => {
    const byMed = new Map<string, string[]>();
    for (const x of slots) byMed.set(short(x.medication), [...(byMed.get(short(x.medication)) ?? []), t12(x.time)]);
    const items = [...byMed].map(([m, times]) => `${m} at ${listJoin(times)}`);
    // A serial comma keeps "Metformin at 8 AM and 8 PM, and Atorvastatin" unambiguous.
    return items.length > 2 && items.some((x) => x.includes(" and ")) ? `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}` : listJoin(items);
  };
  const doseBits = (s: Slot) => `${t12(s.time)} ${short(s.medication)}`;
  const givenBit = (s: Slot) => `${doseBits(s)} was logged as given${s.recordedAt ? ` at ${clock(s.recordedAt)}` : ""}${s.loggedBy ? ` by ${s.loggedBy}` : ""}`;

  // ---------- composers (each uses the minimum tool calls for the question) ----------
  async function status(person: string | undefined, scope: TimeScope | undefined, focus?: Focus, day?: Day): Promise<OfflineReply> {
    if (day && day !== "today") return dayStatus(person, day);
    const r = await call("get_care_status", person ? { person } : {});
    if (r.isError) return { reply: errorText(r) };
    const people = (data(r).people as PersonStatus[]) ?? [];
    session.lastIntent = "status";
    session.lastScope = scope;
    session.lastDay = "today";
    if (person) session.person = person;
    const lines = people.map((p) => (focus === "taken" ? takenAnswer(p) : focus === "remaining" ? remainingAnswer(p, scope) : personDay(p, scope, people.length === 1)));
    return { reply: lines.join(" ") };
  }

  /** Doses for another day. Tomorrow is schedule only (nothing can be logged yet); yesterday is what was recorded. */
  async function dayStatus(person: string | undefined, day: Exclude<Day, "today">, med?: string): Promise<OfflineReply> {
    const date = localDate(now(), opts.timezone, day === "tomorrow" ? 1 : -1);
    const r = await call("get_care_status", { ...(person ? { person } : {}), date });
    if (r.isError) return { reply: errorText(r) };
    const people = (data(r).people as PersonStatus[]) ?? [];
    const alerts = (data(r).supplyAlerts as Forecast[] | undefined) ?? [];
    session.lastIntent = "status";
    session.lastDay = day;
    if (person) session.person = person;
    const lines = people.map((p, i) => {
      const lead = i === 0 ? `${cap(day)}, ` : "";
      const who = i === 0 ? ref(p.name) : cap(ref(p.name));
      const slots = p.slots.filter((s) => !med || short(s.medication).toLowerCase() === med.toLowerCase());
      if (!slots.length) return `${lead}${who} has nothing scheduled${med ? ` for ${med}` : ""}.`;
      if (day === "tomorrow") {
        let line = `${lead}${who} has ${scheduleText(slots)}.`;
        const short1 = alerts.filter((a) => a.personName === p.name && a.daysLeft <= 1 && !a.openRefillRequest && slots.some((s) => s.medicationId === a.medicationId));
        if (short1.length) line += ` ${listJoin(short1.map((a) => short(a.medication)))} may run out before then, and no refill has been requested.`;
        return line;
      }
      const given = slots.filter((s) => s.state === "taken");
      const notLogged = slots.filter((s) => s.state === "missed" || s.state === "due");
      const skipped = slots.filter((s) => s.state === "skipped");
      if (given.length === slots.length && slots.length > 2) {
        const last = given.reduce((a, b) => ((a.recordedAt ?? "") > (b.recordedAt ?? "") ? a : b));
        return `${i === 0 && e.focus === "taken" ? "Yes. " : ""}All ${numWord(slots.length)} of ${poss(p.name)} doses were logged as given ${day}${last.recordedAt ? `, the last at ${clock(last.recordedAt)}` : ""}.`;
      }
      const parts: string[] = [];
      if (given.length) parts.push(`${poss(p.name)} ${listJoin(given.map(givenBit))}`);
      if (skipped.length) parts.push(`${given.length ? theirs(p.name) : poss(p.name)} ${listJoin(skipped.map(doseBits))} ${skipped.length === 1 ? "was" : "were"} marked skipped`);
      if (notLogged.length) parts.push(`${given.length || skipped.length ? theirs(p.name) : poss(p.name)} ${listJoin(notLogged.map(doseBits))} ${notLogged.length === 1 ? "wasn't" : "weren't"} logged, so I can't confirm ${notLogged.length === 1 ? "it was" : "they were"} taken`);
      const answer = e.focus === "taken" && i === 0 && people.length === 1 ? (notLogged.length || skipped.length ? (given.length ? "Partly. " : "No. ") : "Yes. ") : "";
      return `${answer}${lead}${parts.join("; ")}.`;
    });
    return { reply: lines.join(" ") };
  }

  /** "Did Dad take his pills?" — what was recorded, with honest uncertainty about anything not logged. */
  function takenAnswer(p: PersonStatus): string {
    const soFar = p.slots.filter((s) => s.state !== "upcoming");
    const given = soFar.filter((s) => s.state === "taken");
    const skipped = soFar.filter((s) => s.state === "skipped");
    const missed = soFar.filter((s) => s.state === "missed");
    const due = soFar.filter((s) => s.state === "due");
    const next = p.slots.find((s) => s.state === "upcoming");
    const nextBit = next ? ` Next is ${short(next.medication)} at ${t12(next.time)}.` : "";
    if (!soFar.length) return `Nothing has come due for ${ref(p.name)} yet today.${nextBit}`;
    const one = (xs: Slot[], a: string, b: string) => (xs.length === 1 ? a : b);
    const out: string[] = [];
    // Name the person once, in the first clause; pronouns after that.
    const owner = (fallback: string) => (out.length ? fallback : poss(p.name));
    if (given.length) out.push(`${owner(cap(theirs(p.name)))} ${listJoin(given.map(givenBit))}.`);
    if (skipped.length) out.push(`${owner(cap(theirs(p.name)))} ${listJoin(skipped.map(doseBits))} ${one(skipped, "was", "were")} marked skipped.`);
    if (missed.length) out.push(`${owner("The")} ${listJoin(missed.map(doseBits))} ${one(missed, "hasn't", "haven't")} been logged, so I can't confirm ${subj(p.name)} took ${one(missed, "it", "them")}.`);
    if (due.length) out.push(`${owner("The")} ${listJoin(due.map(doseBits))} ${one(due, "is", "are")} due now and ${one(due, "hasn't", "haven't")} been logged yet.`);
    const lead = !missed.length && !due.length && !skipped.length ? "Yes." : given.length ? "Partly." : missed.length ? "Not that I can see." : due.length && !skipped.length ? "Not yet." : "";
    return `${lead ? lead + " " : ""}${out.join(" ")}${nextBit}`;
  }

  /** "What's left today?" — what's still to do, plus anything overdue. */
  function remainingAnswer(p: PersonStatus, scope: TimeScope | undefined): string {
    const slots = p.slots.filter((s) => inScope(s.time, scope));
    const left = slots.filter((s) => s.state === "due" || s.state === "upcoming");
    const overdue = slots.filter((s) => s.state === "missed");
    const when = scope === "evening" ? "tonight" : scope === "morning" ? "this morning" : scope === "afternoon" ? "this afternoon" : "today";
    let line = left.length
      ? `${cap(ref(p.name))} still has ${listJoin(left.map((s) => `${short(s.medication)} ${s.state === "due" ? "(due now)" : `at ${t12(s.time)}`}`))}.`
      : `Nothing is left for ${ref(p.name)} ${when}.`;
    const not = overdue.length === 1 ? "hasn't" : "haven't";
    if (overdue.length && left.length) line += ` ${cap(theirs(p.name))} ${listJoin(overdue.map(doseBits))} also ${not} been logged.`;
    else if (overdue.length) line = `Nothing else is scheduled for ${ref(p.name)} ${when}, but ${theirs(p.name)} ${listJoin(overdue.map(doseBits))} ${not} been logged.`;
    return line;
  }

  /** A check-in: today's doses, anything not logged and urgent supply, without reciting every slot. */
  async function overview(person: string | undefined): Promise<OfflineReply> {
    const [st, fc] = await Promise.all([call("get_care_status", person ? { person } : {}), call("forecast_refills", { ...(person ? { person } : {}), within_days: 7 })]);
    if (st.isError) return { reply: errorText(st) };
    const people = (data(st).people as PersonStatus[]) ?? [];
    const low = fc.isError ? [] : ((data(fc).items as Forecast[]) ?? []).filter((f) => f.urgency !== "ok");
    session.lastIntent = "overview";
    session.lastDay = "today";
    if (person) session.person = person;
    const solo = people.length === 1;
    // In a one-person answer, name them once and use pronouns after that.
    const whose = (name: string) => (solo ? theirs(name) : poss(name));
    const issues: string[] = [];
    for (const p of people) {
      const missed = p.slots.filter((s) => s.state === "missed");
      if (missed.length) issues.push(`${whose(p.name)} ${listJoin(missed.map(doseBits))} ${missed.length === 1 ? "hasn't" : "haven't"} been logged`);
    }
    for (const f of low) {
      if (f.openRefillRequest) continue;
      issues.push(`${whose(f.personName)} ${short(f.medication)} is down to about ${plural(f.daysLeft, "day")} ${f.refillsRemaining > 0 ? "and hasn't been reordered" : "with no refills on the prescription, so the prescriber needs to authorize more"}`);
    }
    const facts = people.map((p) => {
      const total = p.slots.length;
      const given = p.slots.filter((s) => s.state === "taken").length;
      const due = p.slots.filter((s) => s.state === "due");
      const next = p.slots.find((s) => s.state === "upcoming");
      const subject = solo ? cap(subj(p.name)) : cap(ref(p.name));
      const has = solo && subj(p.name) === "they" ? "have" : "has";
      const hasHad = solo && has === "has" ? `${subject}'s had` : `${subject} ${has} had`;
      let line = total ? `${hasHad} ${given} of ${pron(p.name)} ${plural(total, "dose")} today` : `${subject} ${has} nothing scheduled today`;
      if (due.length) line += `, with ${listJoin(due.map((s) => short(s.medication)))} due now`;
      else if (next) line += `, and ${short(next.medication)} is next at ${t12(next.time)}`;
      return `${line}.`;
    });
    const who = person ? ` for ${ref(person)}` : "";
    const sentence = (x: string) => `${cap(x)}.`;
    let reply: string;
    if (!issues.length) reply = `${pick(["Everything's on track", "All on track", "Looking good"])}${who}. ${facts.join(" ")} Nothing is running low.`;
    else if (issues.length === 1) reply = `Mostly on track${who}. One thing to look at: ${issues[0]}. ${solo ? "Otherwise, " + facts[0]!.charAt(0).toLowerCase() + facts[0]!.slice(1) : facts.join(" ")}`;
    else reply = `${cap(numWord(issues.length))} things need attention${who}. ${issues.map(sentence).join(" ")} ${facts.join(" ")}`;
    const requested = low.filter((f) => f.openRefillRequest);
    if (requested.length) reply += ` A refill is already requested for ${listJoin(requested.map((f) => `${whose(f.personName)} ${short(f.medication)}`))}.`;
    if (/\b(okay|ok|alright|all right|fine|doing)\b/.test(u.normalized)) reply = `I can only go by what's been recorded. ${reply}`;
    const requestable = low.find((f) => !f.openRefillRequest && f.refillsRemaining > 0);
    if (requestable) {
      session.pending = { type: "offer_refill", person: requestable.personName, med: short(requestable.medication) };
      reply += ` Want me to prepare a refill request for ${whose(requestable.personName)} ${short(requestable.medication)}?`;
    }
    return { reply };
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
    if (e.focus === "taken" && slots.length) {
      const soFar = slots.filter((s) => s.state !== "upcoming");
      const given = soFar.filter((s) => s.state === "taken");
      const open = soFar.filter((s) => s.state === "missed" || s.state === "due");
      const next = slots.find((s) => s.state === "upcoming");
      const parts: string[] = [];
      if (!soFar.length) parts.push(`Not yet; ${poss(person)} first ${short(label)} dose today is at ${t12(slots[0]!.time)}`);
      else {
        const lead = open.length ? (given.length ? "Partly" : "Not that I can see") : "Yes";
        if (given.length) parts.push(`${lead}. The ${listJoin(given.map((s) => `${t12(s.time)} dose was logged as given${s.recordedAt ? ` at ${clock(s.recordedAt)}` : ""}${s.loggedBy ? ` by ${s.loggedBy}` : ""}`))}`);
        if (open.length) parts.push(`${given.length ? "" : `${lead}. `}The ${listJoin(open.map((s) => t12(s.time)))} dose ${open.length === 1 ? "hasn't" : "haven't"} been logged, so I can't confirm ${subj(person)} took it`);
        const skipped = soFar.filter((s) => s.state === "skipped");
        if (skipped.length) parts.push(`The ${listJoin(skipped.map((s) => t12(s.time)))} dose was marked skipped`);
      }
      if (next && soFar.length) parts.push(`The ${t12(next.time)} dose is still to come`);
      let reply = `${parts.join(". ")}.`;
      if (f && f.urgency !== "ok" && !f.openRefillRequest) reply += ` Heads up: only about ${plural(f.daysLeft, "day")} of supply left.`;
      return { reply };
    }
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

  async function supply(person: string | undefined, med: string | undefined, day?: Day): Promise<OfflineReply> {
    const r = await call("forecast_refills", { ...(person ? { person } : {}), within_days: 7 });
    if (r.isError) return { reply: errorText(r) };
    const items = (data(r).items as Forecast[]) ?? [];
    session.lastIntent = "supply";
    if (person) session.person = person;
    if (day === "tomorrow") {
      const soon = items.filter((f) => f.daysLeft <= 1);
      if (!soon.length) return { reply: `Nothing should run out by tomorrow${person ? ` for ${ref(person)}` : ""}.` };
      return { reply: `${listJoin(soon.map((f) => `${poss(f.personName)} ${short(f.medication)}`))} could run out by tomorrow${soon.every((f) => f.openRefillRequest) ? "; a refill is already requested" : ""}.` };
    }
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
    session.lastWrite = { person, what: `the ${t12(d.slotTime)} ${short(d.medication)} dose`, turn: session.turns };
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
    session.pending = { type: "which_person", intent, entities: e, candidates, text: sourceText };
    return { reply: `Is that ${what} for ${orList(candidates.map((c) => session.words[c] ?? household.find((h) => h.name === c)?.aliases[0] ?? c))}?` };
  };

  function noteCategory(t: string): string {
    if (/\bappointment\b/i.test(t)) return "appointment";
    return SYMPTOM.test(t.toLowerCase()) ? "symptom" : "observation";
  }

  /**
   * The caregiver talking about themselves. Never written to the care record and
   * never attributed to a care recipient; no tools are called.
   */
  function selfFeeling(): OfflineReply {
    if (e.crisis) {
      return {
        reply: "I'm really glad you told me, and I'm sorry you're carrying this. I can't help in an emergency, so if you might hurt yourself, please call your local emergency number now, or in the US call or text 988 to reach the Suicide & Crisis Lifeline. If you can, reach out to someone you trust right now too.",
      };
    }
    const n = u.normalized;
    const about = e.people[0];
    const heavy = /\b(depressed|hopeless|can't cope|cannot cope|struggling|not okay|lonely|scared)\b/.test(n);
    const tired = /\b(tired|exhausted|overwhelmed|stressed|burnt out|burned out|busy|frazzled)\b/.test(n);
    const sorry = pick(["I'm sorry you're feeling that way.", "That sounds really hard.", "Thank you for telling me. That sounds like a lot."]);
    if (about) {
      session.pending = { type: "offer_checkin", person: about };
      return { reply: `That's understandable. Caring for ${ref(about)} takes a lot. Would it help if I checked how ${pron(about) === "their" ? `${poss(about)}` : pron(about)} day is going?` };
    }
    if (heavy) {
      return { reply: `${sorry} Looking after family can take a real toll, and how you're doing matters too. If it's been weighing on you for a while, it may help to talk with someone you trust or your own doctor. I haven't added anything to the care record.` };
    }
    if (tired) {
      session.pending = { type: "offer_checkin" };
      return { reply: `${sorry} Caregiving is a lot to carry. I haven't added anything to the care record. Want me to tell you what's still left today, so you know what can wait?` };
    }
    return { reply: `${sorry} I'm here if you want to talk it through, and I haven't added anything to the care record.` };
  }

  /**
   * Someone in the care circle seems unwell or different. Observations are only
   * saved after the caregiver says yes, and only reported as saved once the server confirms.
   */
  function observation(): OfflineReply {
    const person = e.people[0] ?? (e.pronoun ? session.person : undefined) ?? (household.length === 1 ? household[0]!.name : undefined);
    if (!person) {
      const symptom = /\b(migraine|headache|fever|cough|rash|pain|nause\w*|dizz\w*)\b/.exec(u.normalized)?.[0];
      session.pending = { type: "which_person", intent: "observation", entities: e, candidates: household.map((p) => p.name), text: sourceText };
      return { reply: `Who ${symptom ? `has the ${symptom}` : "is that about"}, ${orList(everyoneWords())}?` };
    }
    session.person = person;
    // Keep the caregiver's own words, minus filler like "as well".
    const clean = sourceText.replace(/^\s*(hey |ok )?alexa[,.!\s]*/i, "").replace(/[,\s]+(as well|too|also)\s*([.!?]*)$/i, "$2").replace(/[.!?\s]+$/, "").trim();
    // A note is read later without this conversation, so "She has a headache" is saved as "Mom has a headache".
    const named = clean.replace(/^(she|he)\b/i, ref(person));
    const quoted = named.charAt(0).toUpperCase() + named.slice(1);
    session.pending = { type: "confirm_note", person, text: quoted, category: noteCategory(sourceText) };
    const urgent = /\b(fell|fall|chest pain|can't breathe|cannot breathe|short of breath|breathless|unconscious|passed out|fainted|slurr\w*|stroke)\b/.test(u.normalized)
      ? ` If this feels like an emergency, call your local emergency number first.`
      : "";
    const empathy = pick([`Sorry to hear that about ${ref(person)}.`, `Oh no, poor ${ref(person)}.`, `Thanks for letting me know about ${ref(person)}.`]);
    return { reply: `${empathy}${urgent} Should I add “${quoted}” to ${theirs(person)} notes so the care circle knows?` };
  }

  /** "What does Dad take?" — the medicine list from the care record, not today's status. */
  function regimen(person: string | undefined): OfflineReply {
    const people = person ? household.filter((p) => p.name === person) : household;
    session.lastIntent = "regimen";
    if (person) session.person = person;
    const lines = people.map((p) => {
      if (!p.medications.length) return `${cap(ref(p.name))} has no medicines on file.`;
      const byTime = [...p.medications].sort((a, b) => (a.times[0] ?? "").localeCompare(b.times[0] ?? ""));
      return `${cap(ref(p.name))} takes ${listJoin(byTime.map((m) => `${m.label} at ${listJoin(m.times.map(t12))}`))}.`;
    });
    if (!lines.length) return { reply: "There's no one in the care record yet." };
    return { reply: lines.join(" ") };
  }

  /** "Dad missed his morning dose, what should I do?" — what the record shows, and who can actually advise. */
  async function missedAdvice(person: string | undefined): Promise<OfflineReply> {
    const r = await call("get_care_status", person ? { person } : {});
    if (r.isError) return { reply: errorText(r) };
    const people = (data(r).people as PersonStatus[]) ?? [];
    session.lastIntent = "missed_advice";
    const open = people.map((p) => ({ p, slots: p.slots.filter((s) => s.state === "missed" || s.state === "due") })).filter((x) => x.slots.length);
    const facts = open.length
      ? open.map(({ p, slots }) => `${poss(p.name)} ${listJoin(slots.map(doseBits))} ${slots.length === 1 ? "hasn't" : "haven't"} been logged.`).join(" ")
      : `Everything due so far${person ? ` for ${ref(person)}` : ""} has been logged, so I don't see a missed dose today.`;
    const only = open.length === 1 ? open[0]! : undefined;
    if (only) {
      session.person = only.p.name;
      if (only.slots.length === 1) session.medication = short(only.slots[0]!.medication);
    } else if (person) session.person = person;
    const guide = "I can't say whether a missed dose should be given late. The medicine's label or the pharmacist is the right guide for that.";
    const offer = only ? ` If ${subj(only.p.name)} did take it, tell me and I'll log it.` : open.length ? " If any of these was actually given, tell me and I'll log it." : "";
    return { reply: `${facts} ${guide}${offer}` };
  }

  function helpText(): string {
    return `I keep the care circle's record of ${listJoin(everyoneWords())}'s medicines. You can ask what's due or what's left today, tell me a dose was given or skipped, check supply and refills, add a note, or ask for a handoff. For example: “${example()}”`;
  }

  async function handle(intent: Understanding["intent"]): Promise<OfflineReply> {
    if (intent !== "unknown") session.misses = 0;
    const person = e.people[0] ?? (e.pronoun ? session.person : undefined);
    const med = e.meds[0]?.name;
    if (["status", "overview", "med_info", "supply", "handoff", "regimen", "advice", "missed_advice", "followup"].includes(intent)) {
      session.lastAsk = { intent, timeScope: e.timeScope, focus: e.focus, day: e.day, med: med ?? (intent === "followup" ? session.medication : undefined) };
    }
    switch (intent) {
      case "correction": {
        const to = e.people[0]!;
        const w = session.lastWrite;
        if (w && w.turn === session.turns - 1 && w.person !== to) {
          session.pending = { type: "confirm_note", person: w.person, text: `${cap(w.what)} was recorded for ${ref(w.person)} by mistake; it was meant for ${ref(to)}`, category: "observation", fixed: true };
          return { reply: `${cap(w.what)} is already recorded for ${ref(w.person)}, and I can't undo that by voice. Should I add a note to ${theirs(w.person)} record saying it was a mistake?` };
        }
        const last = session.lastAsk;
        if (!last) return overview(to);
        e.people = [to];
        Object.assign(e, { timeScope: last.timeScope, focus: last.focus, day: last.day, meds: [] });
        if (last.med) {
          if (!ownersOf(last.med).includes(to)) {
            const theirMeds = household.find((p) => p.name === to)?.medications.map((m) => m.name) ?? [];
            if (theirMeds.length) session.pending = { type: "which_med", person: to, intent: "med_info" };
            return { reply: `${cap(ref(to))} doesn't take ${last.med}.${theirMeds.length ? ` ${cap(subj(to))} ${subj(to) === "they" ? "take" : "takes"} ${listJoin(theirMeds)}. Which one should I check?` : ""}` };
          }
          e.meds = [{ name: last.med, owners: [to] }];
        }
        return handle(last.intent === "followup" ? "status" : last.intent);
      }
      case "regimen":
        return regimen(person);
      case "missed_advice":
        return missedAdvice(person);
      case "out_of_scope":
        if (REMINDER.test(u.normalized)) return { reply: "I can't set reminders yet. What's due is always on the Today page, and you can ask me what's left at any time." };
        return { reply: pick([
          `That's outside what I can do here. I look after ${listJoin(everyoneWords())}'s medicines, notes and refills.`,
          `I can't help with that one. I'm only set up for ${listJoin(everyoneWords())}'s care: doses, supply, notes and handoffs.`,
        ]) };
      case "greeting": {
        const first = !session.greeted;
        session.greeted = true;
        const tod = /^good (morning|afternoon|evening)/.exec(u.normalized)?.[0];
        if (first) return { reply: `${tod ? cap(tod) + "," : "Hey"} ${opts.actorName}. What can I help you with today?` };
        return { reply: pick(["Hi again. What do you need?", "I'm here. What would you like to check?"]) };
      }
      case "thanks":
        return { reply: pick(["You're welcome.", "Anytime.", "Happy to help."]) };
      case "help":
        return { reply: helpText() };
      case "advice":
        return { reply: "I can't advise on changing, skipping or combining doses. That's a question for the pharmacist or doctor. If it helps, I can add a note so the care circle knows you asked." };
      case "vague_medication": {
        session.pending = { type: "vague" };
        const who = household.length === 1 ? ref(household[0]!.name) : orList(everyoneWords());
        return { reply: `Happy to help. Are you checking what ${who} needs to take today, or asking about a particular medicine?` };
      }
      case "status":
        if (med) return e.day && e.day !== "today" ? dayStatus(person ?? ownersOf(med)[0], e.day, med) : intentWithMed("med_info", person, med);
        return status(person, e.timeScope, e.focus, e.day);
      case "overview":
        return overview(person);
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
        if (e.day === "tomorrow") return { reply: "A dose can't be logged ahead of time, so I haven't recorded anything." };
        if (e.day === "yesterday") return { reply: "I can only log today's doses by voice, so I haven't recorded anything for yesterday." };
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
        const noteText = sourceText.replace(/^\s*(alexa[,\s]+)?(please\s+)?(add a |make a |take a )?note( that| for \w+)?[:,]?\s*/i, "").replace(/^remember that\s*/i, "").trim();
        const category = noteCategory(sourceText);
        const r = await call("add_care_note", { person: who.person, text: noteText || sourceText, category });
        if (r.isError) return { reply: errorText(r) };
        session.person = who.person;
        session.lastWrite = { person: who.person, what: "that note", turn: session.turns };
        return { reply: `Noted for ${ref(who.person)}. The care circle will see it in the next handoff.` };
      }
      case "self_feeling":
        return selfFeeling();
      case "observation":
        return observation();
      case "followup": {
        const target = e.people[0] ?? session.person;
        const last = session.lastIntent;
        if (e.day && e.day !== "today") {
          if (last === "supply") return supply(target, e.meds[0]?.name, e.day);
          const medCtx = e.meds[0]?.name ?? (last === "med_info" ? session.medication : undefined);
          if (last || target || medCtx) return dayStatus(target, e.day, medCtx);
          session.pending = { type: "which_aspect", day: e.day, person: target };
          return { reply: `Do you mean ${e.day}'s doses, or whether anything will run out?` };
        }
        if (last === "overview" && e.people[0]) return overview(target);
        if (last === "med_info" && (e.meds[0] || e.people[0]) ) return intentWithMed("med_info", target, e.meds[0]?.name ?? session.medication);
        if (last === "supply") return supply(target, e.meds[0]?.name);
        if (e.meds[0]) return intentWithMed("med_info", target, e.meds[0].name);
        if (session.lastDay && session.lastDay !== "today" && !e.timeScope && !e.day) return dayStatus(target, session.lastDay);
        return status(target, e.timeScope ?? (e.people[0] ? session.lastScope : undefined), e.focus);
      }
      case "affirm":
      case "deny":
        return { reply: intent === "affirm" ? "There's nothing waiting for a yes right now. What would you like to do?" : "Okay." };
      default: {
        session.misses += 1;
        if (session.misses >= 2) return { reply: `I'm still not following, sorry. ${helpText()}` };
        if (session.person) {
          const obj = pron(session.person) === "their" ? ref(session.person) : pron(session.person) === "her" ? "her" : "him";
          return { reply: `Sorry, I didn't follow that. Is it about ${ref(session.person)}? You can ask what's left for ${obj} today, or tell me a dose was given.` };
        }
        return { reply: `${pick(["Sorry, I didn't catch that.", "I'm not sure I understood."])} Could you put it another way? For example, “${example()}”` };
      }
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
          sourceText = pending.text;
          // Re-run the original request with the person now explicit.
          e.people = [chosen, ...e.people.filter((p) => p !== chosen)];
          Object.assign(e, { meds: pending.entities.meds, slotTime: pending.entities.slotTime ?? e.slotTime, quantity: pending.entities.quantity ?? e.quantity, hedged: pending.entities.hedged, timeScope: pending.entities.timeScope ?? e.timeScope });
          return handle(pending.intent);
        }
        if (/\b(both|everyone|all of them|each)\b/.test(u.normalized) && ["status", "overview", "supply", "handoff", "followup"].includes(pending.intent)) {
          e.people = [];
          return handle(pending.intent);
        }
        if (u.intent === "deny") return { reply: "Okay, I'll leave it." };
        break;
      }
      case "confirm_note":
        if (u.intent === "affirm") {
          const r = await call("add_care_note", { person: pending.person, text: pending.text, category: pending.category });
          if (r.isError) return { reply: `I couldn't save that note. ${errorText(r)}` };
          session.person = pending.person;
          session.lastWrite = { person: pending.person, what: "that note", turn: session.turns };
          return { reply: `Added to ${poss(pending.person)} notes. The care circle will see it in the next handoff.` };
        }
        // "No, it's Mom who has the migraine": same observation, different person. Ask again; still nothing saved.
        if (e.people[0] && e.people[0] !== pending.person && !pending.fixed) {
          const to = e.people[0];
          const text = pending.text.startsWith(ref(pending.person)) ? ref(to) + pending.text.slice(ref(pending.person).length) : pending.text;
          session.pending = { ...pending, person: to, text };
          session.person = to;
          return { reply: `Got it, ${ref(to)}. Should I add “${text}” to ${theirs(to)} notes?` };
        }
        if (u.intent === "deny") return { reply: "Okay, I haven't saved it." };
        break;
      case "offer_checkin":
        if (u.intent === "affirm") return pending.person ? overview(pending.person) : status(undefined, undefined, "remaining");
        if (u.intent === "deny") return { reply: pick(["Okay. I'm here whenever you need me.", "No problem. Take care of yourself too."]) };
        break;
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
      case "which_aspect":
        if (/\b(run(ning)? (out|low)|supply|stock|refill|low)\b/.test(u.normalized)) return supply(e.people[0] ?? pending.person, undefined, pending.day);
        if (/\b(dose|doses|schedule|pills|meds|medicines?|take|due)\b/.test(u.normalized) || e.people.length || u.intent === "affirm") return dayStatus(e.people[0] ?? pending.person, pending.day);
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
