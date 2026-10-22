// Deterministic intent + entity understanding for the offline assistant.
// Pure functions (no I/O) so they can be unit-tested and reasoned about.

export interface HouseholdMed {
  id: string;
  name: string;
  label: string;
  times: string[];
}

export interface HouseholdPerson {
  name: string;
  aliases: string[];
  medications: HouseholdMed[];
}

export type TimeScope = "morning" | "afternoon" | "evening" | "now";
export type Day = "today" | "tomorrow" | "yesterday";
/** What a status question is really after: what's still to do, or whether doses were given. */
export type Focus = "remaining" | "taken";

export type Intent =
  | "greeting"
  | "thanks"
  | "help"
  | "affirm"
  | "deny"
  | "vague_medication"
  | "status"
  | "med_info"
  | "log_taken"
  | "log_skipped"
  | "supply"
  | "refill_request"
  | "pickup"
  | "note"
  | "handoff"
  | "activity"
  | "advice"
  | "followup"
  | "overview"
  | "self_feeling"
  | "observation"
  | "correction"
  | "regimen"
  | "missed_advice"
  | "out_of_scope"
  | "unknown";

export interface Entities {
  /** People named explicitly (name or alias), in order of mention. */
  people: string[];
  /** The word the user used for the first person, e.g. "Mom" (used to mirror their language). */
  personWord?: string;
  /** True when the user referred to someone only by pronoun ("her", "his"). */
  pronoun: boolean;
  /** Medications named, with every person who takes a medication of that name. */
  meds: { name: string; owners: string[] }[];
  timeScope?: TimeScope;
  day?: Day;
  focus?: Focus;
  slotTime?: string;
  quantity?: number;
  /** "probably", "I think", "might have": the user isn't sure something happened. */
  hedged: boolean;
  question: boolean;
  /** Words that suggest the speaker may be at risk of harming themselves. */
  crisis: boolean;
}

export interface Understanding {
  intent: Intent;
  entities: Entities;
  normalized: string;
}

export const AFFIRMATIVE = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|go ahead|do it|please do|that's right|correct|right)\b/i;
export const NEGATIVE = /^\s*(no|nope|cancel|don't|do not|stop|never ?mind|not now|wait)\b/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (text: string, w: string) => new RegExp(`(^|[^a-z])${escape(w.toLowerCase())}('s)?([^a-z]|$)`).test(text);

/** Everyday variants of the words families use, so "Mum" finds the person filed as "Mom". */
const ALIAS_VARIANTS: Record<string, string[]> = {
  mom: ["mum", "mommy", "mummy", "mama", "mother", "ma"],
  mum: ["mom", "mummy", "mommy", "mother"],
  dad: ["daddy", "papa", "pa", "father"],
  amma: ["ammi"],
  grandma: ["granny", "nana", "nan"],
  grandpa: ["grandad", "granddad", "gramps"],
};

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^\s*(hey|hi|hello)\s+alexa\b[,.!\s]*/, "$1 ")
    .replace(/^\s*(ok\s+)?alexa\b[,.!\s]*/, "")
    .replace(/[^a-z0-9:'.,?!\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSlotTime(text: string): string | undefined {
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i.exec(text) ?? /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function timeScope(t: string): TimeScope | undefined {
  if (/\b(tonight|this evening|evening|bedtime|night|pm doses?)\b/.test(t)) return "evening";
  if (/\b(this morning|morning|breakfast|am doses?)\b/.test(t)) return "morning";
  if (/\b(this afternoon|afternoon|lunch(time)?)\b/.test(t)) return "afternoon";
  if (/\b(right now|now|at the moment|currently)\b/.test(t)) return "now";
  return undefined;
}

function dayOf(t: string): Day | undefined {
  if (/\b(tomorrow|tmrw)\b/.test(t)) return "tomorrow";
  if (/\b(yesterday|last night)\b/.test(t)) return "yesterday";
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) return "today";
  return undefined;
}

function focusOf(t: string): Focus | undefined {
  if (/\b(left|remaining|still (to|need|needs|has|have)|what's next|whats next|next dose|coming up|to go)\b/.test(t)) return "remaining";
  if (/^(did|has|have)\b.*\b(take|taken|had|get|got|given)\b/.test(t) || /\b(been given|been taken)\b/.test(t)) return "taken";
  return undefined;
}

export function extractEntities(text: string, household: HouseholdPerson[]): Entities {
  const t = normalize(text);
  const people: { name: string; at: number; word: string }[] = [];
  for (const p of household) {
    const words = [p.name, ...p.aliases, ...p.aliases.flatMap((a) => ALIAS_VARIANTS[a.toLowerCase()] ?? [])];
    for (const w of words) {
      if (!w) continue;
      const m = new RegExp(`(^|[^a-z])(${escape(w.toLowerCase())})('s)?([^a-z]|$)`).exec(t);
      if (m) {
        // Keep the word the user actually said ("Mum"), so replies mirror it.
        people.push({ name: p.name, at: m.index, word: w === p.name || p.aliases.includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1) });
        break;
      }
    }
  }
  people.sort((a, b) => a.at - b.at);
  const meds = new Map<string, Set<string>>();
  for (const p of household) {
    for (const m of p.medications) {
      if (word(t, m.name)) {
        const set = meds.get(m.name.toLowerCase()) ?? new Set<string>();
        set.add(p.name);
        meds.set(m.name.toLowerCase(), set);
      }
    }
  }
  const medList = [...meds].map(([n, owners]) => {
    const canonical = household.flatMap((p) => p.medications).find((m) => m.name.toLowerCase() === n)!.name;
    return { name: canonical, owners: [...owners] };
  });
  const qty = /\b(\d{1,4})\s*(tablets?|pills?|capsules?|of them)?\b/.exec(t.replace(/\b\d{1,2}(:\d{2})?\s*(a\.?m|p\.?m)\b/g, ""));
  return {
    people: people.map((p) => p.name),
    personWord: people[0]?.word,
    pronoun: people.length === 0 && /\b(she|her|hers|he|him|his|they|them|their)\b/.test(t),
    meds: medList,
    timeScope: timeScope(t),
    day: dayOf(t),
    focus: focusOf(t),
    slotTime: parseSlotTime(t),
    quantity: qty ? Number(qty[1]) : undefined,
    hedged: /\b(probably|maybe|might have|may have|i think|i guess|not sure|should have|supposed to)\b/.test(t),
    question: QUESTION.test(t) || t.endsWith("?"),
    crisis: CRISIS.test(t),
  };
}

/** How someone is: symptoms and wellbeing observations (about a care recipient or the speaker). */
export const SYMPTOM = /\b(felt|feeling|feels|feel|seems|seemed|looks|looked|complain(ed|ing|s)?|dizzy|tired|exhausted|pain|ache|aches|aching|headache|migraine|nause\w*|vomit\w*|threw up|fever|cough\w*|cold|flu|sick|unwell|ill|fell|fall|confused|sleepy|drowsy|weak|breathless|short of breath|rash|swollen|swelling|sore|depressed|anxious|sad|low|down|upset|agitated|stressed|overwhelmed|worried|lonely|scared|frustrated|struggling|can't sleep|couldn't sleep|insomnia|not (eating|sleeping)|off (her|his|their) food)\b/;
/** The speaker talking about themselves ("I am feeling depressed"), not about the person they care for. */
const FIRST_PERSON = /^(honestly,? |to be honest,? |tbh,? |just )?(i|i'm|im|i am|i've|ive|i have|i feel|i've been|i was|i get|i keep|me|my)\b/;
const REPORTING = /^i (think|noticed|notice|saw|feel like|reckon|guess|just noticed|found)\b/;
const CRISIS = /\b(kill (myself|me)|suicid\w*|end (it all|my life|things)|hurt(ing)? myself|self[- ]harm|don't want to (live|be here|go on)|no reason to live|better off without me)\b/;
const QUESTION = /^(did|has|have|what|what's|when|is|are|how|who|which|can|could|do|does|will|should|tell me|show me|any)\b/;
const MED_WORDS = /\b(medicine|medicines|medication|medications|meds|pills|tablets|drugs|prescriptions?)\b/;

const GREETING = /^(hi|hello|hey|hiya|good (morning|afternoon|evening))\b[,.!\s]*/;
const OVERVIEW = /\b(how (are|is|'s|s) (\w+'?s? )?(medicines?|meds|medications?|pills|tablets|doing|looking|getting on|holding up)|how (are|is) (things|everything|everyone|it going)|how's (everything|everyone|it going|things)|(is|are) (\w+ )?(okay|ok|alright|all right|fine)\b|(is|are) \w+ (feeling|doing) (okay|ok|alright|all right|fine|well)\b|anything (i should know|to worry about|wrong|urgent|important)|any (problems|concerns|issues|worries)|overview|status update|where are we|give me an update|update me)/;

/** "No, I meant Mom", "actually Dad", "not Mom, Dad": the same request, a different person. */
const CORRECTION = /^((no|nope|sorry|oops|wait|sorry no)[,.!]?\s+)?(i meant|i mean|meant|actually|not (\w+)[,.]?\s+(i meant\s+|i mean\s+)?)\b/;
/** "What does Dad take?", "What meds is Mom on?" — the list of medicines, not today's status. */
const REGIMEN = /\b(what (does|do) \w+ take|what (meds|medicines?|medications?|pills|tablets) (is|does|do|are) \w+ (on|take|taking)|what is \w+ on|what's \w+ on|list (\w+'s )?(meds|medicines|medications)|(meds|medicines?|medications?) list|which (meds|medicines|medications|pills) (does|do|is|are)|what (meds|medicines|medications) (does|do|is|are) \w+)\b/;
const MISSED_ADVICE = /\b(missed|forgot|forgotten|didn't (get|take|have)|did not (get|take|have))\b/;
const WHAT_TO_DO = /\b(what (should|do|can) (i|we) do|what now|should (i|we)|can (she|he|they|i|we|\w+) still|too late|is it (ok|okay|safe)|now or)\b/;
/** Things Alexa itself does, but Tend doesn't. */
const OUT_OF_SCOPE = /\b(weather|raining|temperature outside|music|song|songs|playlist|podcast|radio|news|headlines|timer|alarm|joke|lights?|thermostat|recipe|traffic|movie|sports?|score|shopping list|spotify)\b|^(play|call|text|order|buy|turn (on|off))\b/;
export const REMINDER = /\b(remind me|set a reminder|reminders?)\b/;

export function classify(text: string, household: HouseholdPerson[]): Understanding {
  let t = normalize(text);
  const e = extractEntities(text, household);
  // "Hi Alexa, did Dad take his pills?" is a question with a greeting in front, not a greeting.
  const greet = GREETING.exec(t);
  if (greet && t.slice(greet[0].length).split(" ").filter(Boolean).length >= 2) {
    t = t.slice(greet[0].length);
    e.question ||= QUESTION.test(t);
    e.focus ??= focusOf(t);
  }
  const has = (re: RegExp) => re.test(t);
  const short = t.split(" ").length <= 4;

  let intent: Intent = "unknown";
  const advice = e.question
    && has(/\b(should|is it (ok|okay|safe|fine)|can (she|he|they|i|we|mom|dad)|okay to|safe to|what if)\b/)
    && has(/\b(skip|stop|double|two|extra|cut|half|increase|reduce|change|mix|together|instead|more|less)\b/);
  const writeVerb = has(/\b(took|taken|gave|given|skipped|refused|note|refill|reorder|picked up)\b/);
  if (CORRECTION.test(t) && e.people.length > 0 && t.split(" ").length <= 7 && !writeVerb && !has(SYMPTOM)) intent = "correction";
  else if (advice) intent = "advice";
  else if (has(MISSED_ADVICE) && has(WHAT_TO_DO)) intent = "missed_advice";
  else if (has(REMINDER)) intent = "out_of_scope";
  else if (AFFIRMATIVE.test(t) && !has(/\b(reorder|refill|took|gave|note)\b/) && t.split(" ").length <= 8) intent = "affirm";
  else if (NEGATIVE.test(t) && t.split(" ").length <= 6) intent = "deny";
  else if (short && has(/^(hi|hello|hey|good (morning|afternoon|evening))\b/)) intent = "greeting";
  else if (short && has(/\b(thanks|thank you|cheers)\b/)) intent = "thanks";
  else if (has(/\b(what can you do|help me|how does this work|what do you do)\b/) || t === "help") intent = "help";
  // The caregiver's own feelings are never a care-recipient note. A named person
  // ("I'm worried about Mom") makes it about them; a symptom about them is an observation.
  // "I'm worried about Mom" is still the caregiver's own feeling; "I think Dad has a fever" reports on Dad.
  else if (e.crisis || (FIRST_PERSON.test(t) && !REPORTING.test(t) && has(SYMPTOM) &&!has(/\b(note|took|gave|given|skipped|refill)\b/))) intent = "self_feeling";
  else if (has(OUT_OF_SCOPE) && !e.people.length && !e.meds.length && !MED_WORDS.test(t)) intent = "out_of_scope";
  else if (has(REGIMEN) && !e.meds.length && !e.day && !e.timeScope && !e.focus) intent = "regimen";
  else if (has(/^(what about|how about|and( what about)?|what of)\b/) || (short && t.startsWith("and "))) intent = "followup";
  else if (has(/\b(add a note|make a note|take a note|note that|remember that|write down)\b/)) intent = "note";
  else if (has(/\b(refill|reorder|re-order|order more|request more|get more)\b/) && !has(/\b(when|how long|status|left|need a refill\?)\b/) && !e.question) intent = "refill_request";
  else if (has(/\b(picked up|pick(ed)? up|collected|got (the |a )?(refill|new bottle|\d))/) && e.quantity) intent = "pickup";
  else if (has(/\b(skip|skipped|refused|didn't take|did not take|won't take|wouldn't take)\b/) && !e.question) intent = "log_skipped";
  else if (has(/\b(took|taken|take[sn]? (it|them)|gave|given|had (her|his|their|the)|swallowed|finished)\b/) && !e.question) intent = "log_taken";
  else if (has(/\bappointment\b/) && !e.question) intent = "note";
  else if (has(SYMPTOM) && !e.question && !FIRST_PERSON.test(t)) intent = "observation";
  else if (has(SYMPTOM) && !e.question && (e.people.length || e.pronoun)) intent = "observation";
  else if (has(/\b(handoff|hand off|hand over|summary|summarize|report|recap|catch me up|this week|past week|last week|how has .* been|how was .* week)\b/)) intent = "handoff";
  else if (has(OVERVIEW) && e.meds.length === 0 && !has(/\b(run out|running (out|low)|supply|stock|refill)\b/)) intent = "overview";
  else if (has(/\b(run out|running out|running low|supply|supplies|stock|how many .* left|days left|left in the bottle|need (a )?refill|refills?)\b/)) intent = "supply";
  else if (has(/\b(who (gave|logged|did)|activity|what happened|anything happen|lately|recently)\b/)) intent = "activity";
  else if (e.meds.length > 0 && (e.question || has(/\b(about|tell me|info|information|schedule|when|dose|doses)\b/))) intent = "med_info";
  else if (has(/\b(did .* take|has .* (taken|had)|due|next dose|what's next|left to take|need(s)? to take|schedule|today|tonight|this morning|this evening|missed|on track|doses?|how is|how's|tomorrow|yesterday|last night)\b/)) intent = "status";
  else if (MED_WORDS.test(t)) intent = e.people.length || e.pronoun ? "status" : "vague_medication";
  else if (e.meds.length > 0) intent = "med_info";
  else if (e.timeScope && e.people.length === 0) intent = "followup";
  else if (e.people.length > 0 && short) intent = "followup";

  // "How's Mom?" is a general check-in, not a request for one slot.
  if (intent === "status" && /^how(?: is|'s|s)\b/.test(t) && !e.meds.length && !e.timeScope && !e.day) intent = "overview";
  // A vague medication question is only vague if nothing narrows it down.
  if (intent === "status" && MED_WORDS.test(t) && !e.people.length && !e.pronoun && !e.meds.length && !e.timeScope
    && !has(/\b(did|has|due|next|left|today|tonight|missed|take|taken|schedule)\b/)) {
    intent = "vague_medication";
  }
  return { intent, entities: e, normalized: t };
}

export function scopeOf(time: string): Exclude<TimeScope, "now"> {
  const h = Number(time.slice(0, 2));
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}
