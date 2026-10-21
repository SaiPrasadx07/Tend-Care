// CareService holds Tend's business rules: dose-slot matching, the
// double-dose guard, adherence math, refill forecasting and two-phase
// confirmation for consequential actions. It is transport-agnostic; the MCP
// layer is a thin adapter over it.
import type { DoseEventRow, MedicationRow, PendingActionRow, PersonRow, Role } from "./store.ts";
import { Store } from "./store.ts";
import {
  addDays, daysBetween, formatTime12, hhmmToMinutes, isHHMM, isYMD, zonedParts, zonedToUtc,
} from "./time.ts";

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

export type CareErrorCode = "NOT_FOUND" | "AMBIGUOUS" | "INVALID" | "CONFLICT" | "FORBIDDEN" | "EXPIRED";

export class CareError extends Error {
  readonly code: CareErrorCode;
  constructor(code: CareErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CareError";
  }
}

export interface CareOptions {
  timezone: string;
  now?: () => Date;
  /** Minutes after a scheduled time before an unlogged dose counts as missed. */
  missedGraceMinutes?: number;
  /** Minutes before a scheduled time when a dose becomes "due". */
  dueLeadMinutes?: number;
  pendingActionTtlMinutes?: number;
}

export type SlotState = "taken" | "skipped" | "missed" | "due" | "upcoming";

export interface MedicationView {
  id: string;
  personId: string;
  personName: string;
  name: string;
  strength: string;
  label: string;
  doseUnits: number;
  unitLabel: string;
  times: string[];
  instructions: string;
  quantityOnHand: number;
  refillsRemaining: number;
  pharmacy: string;
}

export interface SlotView {
  medicationId: string;
  medication: string;
  time: string;
  timeLabel: string;
  state: SlotState;
  dose: string;
  instructions: string;
  recordedAt: string | null;
  loggedBy: string | null;
}

export interface PersonStatus {
  personId: string;
  name: string;
  slots: SlotView[];
  counts: Record<SlotState, number>;
}

export interface ForecastItem {
  medicationId: string;
  personName: string;
  medication: string;
  unitsPerDay: number;
  quantityOnHand: number;
  daysLeft: number;
  runoutDate: string;
  refillsRemaining: number;
  openRefillRequest: boolean;
  urgency: "critical" | "soon" | "ok";
  advice: string;
}

export interface PendingActionView {
  actionId: string;
  type: string;
  summary: string;
  createdBy: string;
  expiresAt: string;
}

export interface StatusResult {
  date: string;
  timezone: string;
  generatedAt: string;
  localTime: string;
  people: PersonStatus[];
  supplyAlerts: ForecastItem[];
  pendingActions: PendingActionView[];
}

export interface LogDoseResult {
  outcome: "logged" | "needs_confirmation";
  personName: string;
  medication: string;
  status: "taken" | "skipped";
  slotDate: string;
  slotTime: string;
  slotLabel: string;
  message: string;
  previous: { status: string; recordedAt: string; loggedBy: string } | null;
  quantityOnHand: number;
  supplyWarning: string | null;
}

export interface AdherenceLine {
  medication: string;
  scheduled: number;
  taken: number;
  skipped: number;
  missed: number;
  adherencePct: number | null;
}

export interface HandoffPerson {
  personId: string;
  name: string;
  overallAdherencePct: number | null;
  adherence: AdherenceLine[];
  missedDoses: { medication: string; date: string; time: string }[];
  notes: { at: string; category: string; text: string; loggedBy: string }[];
}

export interface HandoffReport {
  fromDate: string;
  toDate: string;
  days: number;
  generatedAt: string;
  people: HandoffPerson[];
  supplyAlerts: ForecastItem[];
  openRefillRequests: { medication: string; personName: string; requestedBy: string; requestedAt: string }[];
  recentActivity: { at: string; actor: string; message: string }[];
}

export interface AddMedicationInput {
  person: string;
  name: string;
  strength?: string;
  doseUnits?: number;
  unitLabel?: string;
  times: string[];
  instructions?: string;
  quantityOnHand: number;
  refillsRemaining?: number;
  pharmacy?: string;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const LOOKBACK_LOG_HOURS = 36;

export class CareService {
  readonly store: Store;
  readonly tz: string;
  private readonly now: () => Date;
  private readonly grace: number;
  private readonly lead: number;
  private readonly ttl: number;

  constructor(store: Store, opts: CareOptions) {
    this.store = store;
    this.tz = opts.timezone;
    this.now = opts.now ?? (() => new Date());
    this.grace = opts.missedGraceMinutes ?? 90;
    this.lead = opts.dueLeadMinutes ?? 60;
    this.ttl = opts.pendingActionTtlMinutes ?? 15;
  }

  // ---------- helpers ----------

  private requireWrite(actor: Actor): void {
    if (actor.role !== "caregiver") {
      throw new CareError("FORBIDDEN", `${actor.name} has view-only access and cannot change care records.`);
    }
  }

  private activity(actor: Actor, kind: string, message: string, at?: string): void {
    this.store.insertActivity({ at: at ?? this.now().toISOString(), actor: actor.name, kind, message });
  }

  private people(): PersonRow[] {
    return this.store.listPeople();
  }

  private personName(id: string): string {
    return this.people().find((p) => p.id === id)?.name ?? "Unknown";
  }

  private view(m: MedicationRow, personName?: string): MedicationView {
    return {
      id: m.id,
      personId: m.person_id,
      personName: personName ?? this.personName(m.person_id),
      name: m.name,
      strength: m.strength,
      label: m.strength ? `${m.name} ${m.strength}` : m.name,
      doseUnits: m.dose_units,
      unitLabel: m.unit_label,
      times: JSON.parse(m.times) as string[],
      instructions: m.instructions,
      quantityOnHand: m.quantity_on_hand,
      refillsRemaining: m.refills_remaining,
      pharmacy: m.pharmacy,
    };
  }

  private doseText(m: MedicationView): string {
    const n = m.doseUnits;
    return `${n} ${m.unitLabel}${n === 1 ? "" : "s"}`;
  }

  resolvePerson(query?: string): PersonRow {
    const people = this.people();
    if (people.length === 0) throw new CareError("NOT_FOUND", "No care recipients are set up yet. Add one first.");
    if (!query || !query.trim()) {
      if (people.length === 1) return people[0]!;
      throw new CareError("AMBIGUOUS", `Which person? I'm tracking ${people.map((p) => p.name).join(" and ")}.`);
    }
    const q = norm(query);
    const exact = people.filter(
      (p) => p.id === query || norm(p.name) === q || p.aliases.split(",").map(norm).filter(Boolean).includes(q),
    );
    if (exact.length === 1) return exact[0]!;
    const partial = people.filter((p) => norm(p.name).startsWith(q) || q.includes(norm(p.name)));
    if (partial.length === 1) return partial[0]!;
    throw new CareError(
      partial.length > 1 ? "AMBIGUOUS" : "NOT_FOUND",
      `I couldn't match "${query}" to one person. I'm tracking ${people.map((p) => `${p.name}${p.aliases ? ` (${p.aliases.split(",").join(", ")})` : ""}`).join(" and ")}.`,
    );
  }

  /** Resolve a medication by name; if no person is given, infer it when the name is unique in the household. */
  resolveMedication(medQuery: string, personQuery?: string): { med: MedicationView; person: PersonRow } {
    const q = norm(medQuery);
    if (!q) throw new CareError("INVALID", "Which medication?");
    let scope: PersonRow[];
    if (personQuery && personQuery.trim()) scope = [this.resolvePerson(personQuery)];
    else scope = this.people();
    const candidates: { med: MedicationView; person: PersonRow }[] = [];
    for (const person of scope) {
      for (const row of this.store.listMedications(person.id)) candidates.push({ med: this.view(row, person.name), person });
    }
    const exact = candidates.filter((c) => c.med.id === medQuery.trim() || norm(c.med.name) === q || norm(c.med.label) === q);
    const pool = exact.length > 0 ? exact : candidates.filter((c) => norm(c.med.name).startsWith(q) || q.includes(norm(c.med.name)));
    if (pool.length === 1) return pool[0]!;
    if (pool.length === 0) {
      const names = candidates.map((c) => `${c.med.name} (${c.person.name})`).join(", ");
      throw new CareError("NOT_FOUND", `I couldn't find a medication called "${medQuery}". On file: ${names || "none"}.`);
    }
    throw new CareError(
      "AMBIGUOUS",
      `"${medQuery}" matches more than one: ${pool.map((c) => `${c.med.label} for ${c.person.name}`).join("; ")}. Who is it for?`,
    );
  }

  private slotInstant(date: string, time: string): Date {
    return zonedToUtc(date, time, this.tz);
  }

  private latestEvent(events: DoseEventRow[]): DoseEventRow | undefined {
    return events.length > 0 ? events[events.length - 1] : undefined;
  }

  // ---------- setup ----------

  addPerson(input: { name: string; aliases?: string[] }, actor: Actor): PersonRow {
    this.requireWrite(actor);
    const name = input.name.trim();
    if (!name) throw new CareError("INVALID", "A name is required.");
    if (this.people().some((p) => norm(p.name) === norm(name))) {
      throw new CareError("CONFLICT", `${name} is already being tracked.`);
    }
    const row = this.store.insertPerson({
      name,
      aliases: (input.aliases ?? []).map((a) => a.trim()).filter(Boolean).join(","),
      created_at: this.now().toISOString(),
    });
    this.activity(actor, "person_added", `${actor.name} added ${name} to the care circle.`);
    return row;
  }

  addMedication(input: AddMedicationInput, actor: Actor, opts: { createdAt?: string } = {}): MedicationView {
    this.requireWrite(actor);
    const person = this.resolvePerson(input.person);
    const name = input.name.trim();
    if (!name) throw new CareError("INVALID", "Medication name is required.");
    const times = [...new Set(input.times.map((t) => t.trim()))].sort();
    if (times.length === 0 || times.length > 8 || !times.every(isHHMM)) {
      throw new CareError("INVALID", "Schedule times must be 1-8 entries in 24-hour HH:MM format, e.g. 08:00 and 20:00.");
    }
    const doseUnits = input.doseUnits ?? 1;
    if (!(doseUnits > 0 && doseUnits <= 20)) throw new CareError("INVALID", "Dose must be between 0 and 20 units.");
    if (!(input.quantityOnHand >= 0 && input.quantityOnHand <= 10_000)) throw new CareError("INVALID", "Quantity on hand must be 0-10000.");
    if (this.store.listMedications(person.id).some((m) => norm(m.name) === norm(name))) {
      throw new CareError("CONFLICT", `${person.name} already has ${name} on file.`);
    }
    const row = this.store.insertMedication({
      person_id: person.id,
      name,
      strength: (input.strength ?? "").trim(),
      dose_units: doseUnits,
      unit_label: (input.unitLabel ?? "tablet").trim() || "tablet",
      times: JSON.stringify(times),
      instructions: (input.instructions ?? "").trim(),
      quantity_on_hand: input.quantityOnHand,
      refills_remaining: Math.max(0, Math.floor(input.refillsRemaining ?? 0)),
      pharmacy: (input.pharmacy ?? "").trim(),
      active: 1,
      created_at: opts.createdAt ?? this.now().toISOString(),
    });
    const v = this.view(row, person.name);
    this.activity(actor, "medication_added", `${actor.name} added ${v.label} for ${person.name} at ${times.map(formatTime12).join(", ")}.`);
    return v;
  }

  listRecipients(): { personId: string; name: string; aliases: string[]; medications: MedicationView[] }[] {
    return this.people().map((p) => ({
      personId: p.id,
      name: p.name,
      aliases: p.aliases.split(",").filter(Boolean),
      medications: this.store.listMedications(p.id).map((m) => this.view(m, p.name)),
    }));
  }

  // ---------- dose logging ----------

  /** Pick the scheduled slot a dose logged at `at` most plausibly belongs to. */
  matchSlot(med: MedicationView, at: Date, explicitTime?: string): { date: string; time: string } {
    const local = zonedParts(at, this.tz);
    if (explicitTime) {
      if (!med.times.includes(explicitTime)) {
        throw new CareError("INVALID", `${med.label} is scheduled at ${med.times.map(formatTime12).join(" and ")}, not ${formatTime12(explicitTime)}.`);
      }
      // An explicit slot later than the current local time refers to yesterday's dose only if it is far in the future.
      const ahead = hhmmToMinutes(explicitTime) - local.minutes;
      return { date: ahead > 4 * 60 ? addDays(local.date, -1) : local.date, time: explicitTime };
    }
    let best: { date: string; time: string; dist: number } | undefined;
    for (const date of [addDays(local.date, -1), local.date]) {
      for (const time of med.times) {
        const diffMin = (this.slotInstant(date, time).getTime() - at.getTime()) / 60_000;
        if (diffMin > 4 * 60) continue; // too far in the future to be "this" dose
        const dist = Math.abs(diffMin);
        if (!best || dist < best.dist) best = { date, time, dist };
      }
    }
    if (!best) {
      // Every slot is >4h ahead: treat as the earliest slot today (an early dose).
      return { date: local.date, time: med.times[0]! };
    }
    return { date: best.date, time: best.time };
  }

  logDose(
    input: { medication: string; person?: string; status?: "taken" | "skipped"; at?: string; slotTime?: string; confirmDuplicate?: boolean; note?: string },
    actor: Actor,
    opts: { allowBackfill?: boolean } = {},
  ): LogDoseResult {
    this.requireWrite(actor);
    const { med, person } = this.resolveMedication(input.medication, input.person);
    const status = input.status ?? "taken";
    const now = this.now();
    let at = now;
    if (input.at) {
      const parsed = new Date(input.at);
      if (Number.isNaN(parsed.getTime())) throw new CareError("INVALID", "taken_at must be an ISO 8601 timestamp.");
      if (parsed.getTime() > now.getTime() + 5 * 60_000) throw new CareError("INVALID", "A dose can't be logged in the future.");
      if (!opts.allowBackfill && now.getTime() - parsed.getTime() > LOOKBACK_LOG_HOURS * 3_600_000) {
        throw new CareError("INVALID", `Doses can only be logged up to ${LOOKBACK_LOG_HOURS} hours after the fact.`);
      }
      at = parsed;
    }
    if (input.slotTime !== undefined && !isHHMM(input.slotTime)) throw new CareError("INVALID", "slot_time must be HH:MM.");
    const slot = this.matchSlot(med, at, input.slotTime);
    const slotLabel = formatTime12(slot.time);
    const prior = this.latestEvent(this.store.dosesForSlot(med.id, slot.date, slot.time));
    const base = {
      personName: person.name,
      medication: med.label,
      status,
      slotDate: slot.date,
      slotTime: slot.time,
      slotLabel,
      previous: prior ? { status: prior.status, recordedAt: prior.recorded_at, loggedBy: prior.logged_by } : null,
    };

    // Double-dose guard: the core safety rule when several caregivers share one parent.
    if (prior && prior.status === "taken" && status === "taken" && !input.confirmDuplicate) {
      const when = formatTime12(zonedParts(new Date(prior.recorded_at), this.tz).time);
      return {
        ...base,
        outcome: "needs_confirmation",
        message: `Hold on. ${person.name}'s ${slotLabel} ${med.label} was already logged as taken at ${when} by ${prior.logged_by}. Logging it again would record a second dose. Nothing was saved. Check with ${prior.logged_by} first; if a second dose really was given, confirm and I'll record it and flag it.`,
        quantityOnHand: med.quantityOnHand,
        supplyWarning: null,
      };
    }
    if (prior && prior.status === status && status === "skipped") {
      return {
        ...base,
        outcome: "logged",
        message: `${person.name}'s ${slotLabel} ${med.label} is already marked as skipped.`,
        quantityOnHand: med.quantityOnHand,
        supplyWarning: null,
      };
    }

    const duplicate = Boolean(prior && prior.status === "taken" && status === "taken");
    this.store.tx(() => {
      this.store.insertDose({
        medication_id: med.id,
        slot_date: slot.date,
        slot_time: slot.time,
        status,
        recorded_at: at.toISOString(),
        logged_by: actor.name,
        note: (duplicate ? "[confirmed extra dose] " : "") + (input.note ?? "").trim(),
      });
      if (status === "taken") this.store.adjustStock(med.id, -med.doseUnits);
      // A skipped dose that is later taken refunds nothing; a taken dose overridden by "skipped" restores stock.
      if (status === "skipped" && prior?.status === "taken") this.store.adjustStock(med.id, med.doseUnits);
    });
    const after = this.view(this.store.getMedication(med.id)!, person.name);
    const daysLeft = Math.floor(after.quantityOnHand / (after.doseUnits * after.times.length));
    const supplyWarning =
      status === "taken" && daysLeft <= 5
        ? `Only ${after.quantityOnHand} ${after.unitLabel}${after.quantityOnHand === 1 ? "" : "s"} left, about ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`
        : null;
    const verb = status === "taken" ? "took" : "skipped";
    this.activity(
      actor,
      duplicate ? "extra_dose" : `dose_${status}`,
      duplicate
        ? `${actor.name} confirmed an EXTRA ${slotLabel} dose of ${med.label} for ${person.name}.`
        : `${actor.name} logged that ${person.name} ${verb} the ${slotLabel} ${med.label}.`,
      at.toISOString(),
    );
    const message = duplicate
      ? `Recorded a second ${slotLabel} dose of ${med.label} for ${person.name} and flagged it for the care circle. If you're worried about a double dose, call the pharmacist or Poison Control.`
      : `Got it. ${person.name} ${verb} the ${slotLabel} ${med.label}.${supplyWarning ? ` Heads up: ${supplyWarning}` : ""}`;
    return { ...base, outcome: "logged", message, quantityOnHand: after.quantityOnHand, supplyWarning };
  }

  // ---------- status ----------

  private slotState(med: MedicationView, date: string, time: string, createdAt: string, now: Date): { state: SlotState; ev?: DoseEventRow } | null {
    const instant = this.slotInstant(date, time);
    const ev = this.latestEvent(this.store.dosesForSlot(med.id, date, time));
    if (ev) return { state: ev.status, ev };
    // Slots scheduled before the medication was added don't count against anyone.
    if (instant.getTime() < new Date(createdAt).getTime()) return null;
    const mins = (now.getTime() - instant.getTime()) / 60_000;
    if (mins > this.grace) return { state: "missed" };
    if (mins >= -this.lead) return { state: "due" };
    return { state: "upcoming" };
  }

  getStatus(input: { person?: string; date?: string } = {}): StatusResult {
    const now = this.now();
    const local = zonedParts(now, this.tz);
    const date = input.date ?? local.date;
    if (!isYMD(date)) throw new CareError("INVALID", "date must be YYYY-MM-DD.");
    const people = input.person ? [this.resolvePerson(input.person)] : this.people();
    const out: PersonStatus[] = people.map((p) => {
      const slots: SlotView[] = [];
      for (const row of this.store.listMedications(p.id)) {
        const med = this.view(row, p.name);
        for (const time of med.times) {
          const s = this.slotState(med, date, time, row.created_at, now);
          if (!s) continue;
          slots.push({
            medicationId: med.id,
            medication: med.label,
            time,
            timeLabel: formatTime12(time),
            state: s.state,
            dose: this.doseText(med),
            instructions: med.instructions,
            recordedAt: s.ev?.recorded_at ?? null,
            loggedBy: s.ev?.logged_by ?? null,
          });
        }
      }
      slots.sort((a, b) => a.time.localeCompare(b.time) || a.medication.localeCompare(b.medication));
      const counts: Record<SlotState, number> = { taken: 0, skipped: 0, missed: 0, due: 0, upcoming: 0 };
      for (const s of slots) counts[s.state]++;
      return { personId: p.id, name: p.name, slots, counts };
    });
    return {
      date,
      timezone: this.tz,
      generatedAt: now.toISOString(),
      localTime: local.time,
      people: out,
      supplyAlerts: this.forecastRefills({ person: input.person, withinDays: 7 }).filter((f) => f.urgency !== "ok"),
      pendingActions: this.listPendingActions(),
    };
  }

  // ---------- refills ----------

  forecastRefills(input: { person?: string; withinDays?: number } = {}): ForecastItem[] {
    const within = input.withinDays ?? 7;
    const today = zonedParts(this.now(), this.tz).date;
    const people = input.person ? [this.resolvePerson(input.person)] : this.people();
    const items: ForecastItem[] = [];
    for (const p of people) {
      for (const row of this.store.listMedications(p.id)) {
        const m = this.view(row, p.name);
        const unitsPerDay = m.doseUnits * m.times.length;
        const daysLeft = Math.floor(m.quantityOnHand / unitsPerDay);
        const open = this.store.openRefillRequests(m.id).length > 0;
        const urgency: ForecastItem["urgency"] = daysLeft <= 3 ? "critical" : daysLeft <= within ? "soon" : "ok";
        let advice = "Supply is fine.";
        if (urgency !== "ok") {
          if (open) advice = "A refill has already been requested. Record the pickup when it arrives.";
          else if (m.refillsRemaining > 0) advice = `Request a refill now. ${m.refillsRemaining} refill${m.refillsRemaining === 1 ? "" : "s"} left on the prescription.`;
          else advice = "No refills left. The prescriber needs to authorize a new prescription.";
        }
        items.push({
          medicationId: m.id,
          personName: p.name,
          medication: m.label,
          unitsPerDay,
          quantityOnHand: m.quantityOnHand,
          daysLeft,
          runoutDate: addDays(today, daysLeft),
          refillsRemaining: m.refillsRemaining,
          openRefillRequest: open,
          urgency,
          advice,
        });
      }
    }
    return items.sort((a, b) => a.daysLeft - b.daysLeft);
  }

  requestRefill(input: { medication: string; person?: string }, actor: Actor): PendingActionView {
    this.requireWrite(actor);
    const { med, person } = this.resolveMedication(input.medication, input.person);
    const open = this.store.openRefillRequests(med.id)[0];
    if (open) {
      throw new CareError(
        "CONFLICT",
        `${open.requested_by} already requested a refill of ${med.label} for ${person.name} on ${zonedParts(new Date(open.created_at), this.tz).date}. I won't duplicate it.`,
      );
    }
    const pharmacy = med.pharmacy || "the pharmacy on file";
    const refillNote =
      med.refillsRemaining > 0
        ? `${med.refillsRemaining} refill${med.refillsRemaining === 1 ? "" : "s"} remain.`
        : "No refills remain, so it will be flagged as needing a new prescription.";
    const summary = `Request a refill of ${med.label} for ${person.name} from ${pharmacy}. ${refillNote}`;
    const now = this.now();
    const row = this.store.insertPendingAction({
      type: "refill_request",
      payload: JSON.stringify({ medicationId: med.id }),
      summary,
      created_by: actor.name,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.ttl * 60_000).toISOString(),
    });
    return this.pendingView(row);
  }

  private pendingView(row: PendingActionRow): PendingActionView {
    return { actionId: row.id, type: row.type, summary: row.summary, createdBy: row.created_by, expiresAt: row.expires_at };
  }

  listPendingActions(): PendingActionView[] {
    const now = this.now().toISOString();
    return this.store.listPendingActions().filter((a) => a.expires_at > now).map((a) => this.pendingView(a));
  }

  confirmAction(input: { actionId: string }, actor: Actor): { actionId: string; type: string; message: string; pharmacyMessage: string | null } {
    this.requireWrite(actor);
    const row = this.store.getPendingAction(input.actionId);
    if (!row) throw new CareError("NOT_FOUND", "That pending action doesn't exist.");
    if (row.status !== "pending") throw new CareError("CONFLICT", `That action was already ${row.status}.`);
    if (row.expires_at <= this.now().toISOString()) {
      this.store.resolvePendingAction(row.id, "expired");
      throw new CareError("EXPIRED", "That request expired. Ask again and I'll set it up fresh.");
    }
    if (row.type !== "refill_request") throw new CareError("INVALID", `Unsupported action type ${row.type}.`);
    const { medicationId } = JSON.parse(row.payload) as { medicationId: string };
    const medRow = this.store.getMedication(medicationId);
    if (!medRow) throw new CareError("NOT_FOUND", "The medication for this request no longer exists.");
    const med = this.view(medRow);
    const nowIso = this.now().toISOString();
    const result = this.store.tx(() => {
      if (!this.store.resolvePendingAction(row.id, "confirmed")) throw new CareError("CONFLICT", "That action was resolved by someone else.");
      if (this.store.openRefillRequests(med.id).length > 0) throw new CareError("CONFLICT", `A refill of ${med.label} is already open.`);
      this.store.insertRefillRequest({ medication_id: med.id, requested_by: actor.name, created_at: nowIso });
      return true;
    });
    void result;
    const pharmacyMessage =
      `Hello${med.pharmacy ? ` ${med.pharmacy}` : ""}, this is ${actor.name}, caregiver for ${med.personName}. ` +
      `Please refill ${med.label} (${this.doseText(med)} at ${med.times.map(formatTime12).join(" and ")}). ` +
      (med.refillsRemaining > 0 ? "The prescription shows refills remaining." : "No refills remain; please contact the prescriber for authorization.") +
      " Thank you.";
    this.activity(actor, "refill_requested", `${actor.name} requested a refill of ${med.label} for ${med.personName}.`);
    return {
      actionId: row.id,
      type: row.type,
      message: `Done. The refill request for ${med.personName}'s ${med.label} is recorded and the care circle can see it. I drafted the message for ${med.pharmacy || "the pharmacy"}.`,
      pharmacyMessage,
    };
  }

  cancelAction(input: { actionId: string }, actor: Actor): { actionId: string; message: string } {
    this.requireWrite(actor);
    const row = this.store.getPendingAction(input.actionId);
    if (!row) throw new CareError("NOT_FOUND", "That pending action doesn't exist.");
    if (!this.store.resolvePendingAction(row.id, "cancelled")) throw new CareError("CONFLICT", `That action was already ${row.status}.`);
    return { actionId: row.id, message: "Okay, I cancelled that. Nothing was requested." };
  }

  recordRefillPickup(input: { medication: string; person?: string; quantity: number }, actor: Actor): { message: string; quantityOnHand: number; refillsRemaining: number } {
    this.requireWrite(actor);
    if (!(input.quantity > 0 && input.quantity <= 1000)) throw new CareError("INVALID", "Quantity must be between 1 and 1000.");
    const { med, person } = this.resolveMedication(input.medication, input.person);
    const nowIso = this.now().toISOString();
    this.store.tx(() => {
      this.store.adjustStock(med.id, input.quantity, med.refillsRemaining > 0 ? -1 : 0);
      this.store.fulfillRefillRequests(med.id, nowIso);
    });
    const after = this.view(this.store.getMedication(med.id)!, person.name);
    const days = Math.floor(after.quantityOnHand / (after.doseUnits * after.times.length));
    this.activity(actor, "refill_picked_up", `${actor.name} picked up ${input.quantity} ${med.unitLabel}s of ${med.label} for ${person.name}.`);
    return {
      message: `Added ${input.quantity} ${med.unitLabel}s of ${med.label}. ${person.name} now has ${after.quantityOnHand}, about ${days} days of supply.`,
      quantityOnHand: after.quantityOnHand,
      refillsRemaining: after.refillsRemaining,
    };
  }

  // ---------- notes & handoff ----------

  addNote(input: { person?: string; text: string; category?: string }, actor: Actor, opts: { at?: string } = {}): { message: string; noteId: string } {
    this.requireWrite(actor);
    const person = this.resolvePerson(input.person);
    const text = input.text.trim();
    if (!text || text.length > 1000) throw new CareError("INVALID", "A note must be 1-1000 characters.");
    const category = input.category ?? "observation";
    const at = opts.at ?? this.now().toISOString();
    const row = this.store.insertNote({ person_id: person.id, category, text, recorded_at: at, logged_by: actor.name });
    this.activity(actor, "note_added", `${actor.name} noted for ${person.name}: "${text}"`, at);
    return { message: `Noted for ${person.name}. It'll be in the next handoff report.`, noteId: row.id };
  }

  handoffReport(input: { person?: string; days?: number } = {}): HandoffReport {
    const days = Math.min(Math.max(Math.floor(input.days ?? 7), 1), 31);
    const now = this.now();
    const today = zonedParts(now, this.tz).date;
    const fromDate = addDays(today, -(days - 1));
    const people = input.person ? [this.resolvePerson(input.person)] : this.people();
    const sinceIso = this.slotInstant(fromDate, "00:00").toISOString();
    const report: HandoffPerson[] = people.map((p) => {
      const meds = this.store.listMedications(p.id);
      const adherence: AdherenceLine[] = [];
      const missedDoses: HandoffPerson["missedDoses"] = [];
      let totScheduled = 0;
      let totTaken = 0;
      for (const row of meds) {
        const med = this.view(row, p.name);
        const line: AdherenceLine = { medication: med.label, scheduled: 0, taken: 0, skipped: 0, missed: 0, adherencePct: null };
        for (let i = 0; i <= daysBetween(fromDate, today); i++) {
          const date = addDays(fromDate, i);
          for (const time of med.times) {
            const s = this.slotState(med, date, time, row.created_at, now);
            if (!s || s.state === "due" || s.state === "upcoming") continue;
            line.scheduled++;
            if (s.state === "taken") line.taken++;
            else if (s.state === "skipped") line.skipped++;
            else {
              line.missed++;
              missedDoses.push({ medication: med.label, date, time });
            }
          }
        }
        line.adherencePct = line.scheduled > 0 ? Math.round((line.taken / line.scheduled) * 100) : null;
        totScheduled += line.scheduled;
        totTaken += line.taken;
        adherence.push(line);
      }
      const notes = this.store.notesSince([p.id], sinceIso).map((n) => ({ at: n.recorded_at, category: n.category, text: n.text, loggedBy: n.logged_by }));
      missedDoses.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      return {
        personId: p.id,
        name: p.name,
        overallAdherencePct: totScheduled > 0 ? Math.round((totTaken / totScheduled) * 100) : null,
        adherence,
        missedDoses,
        notes,
      };
    });
    const open = this.store.openRefillRequests().map((r) => {
      const m = this.store.getMedication(r.medication_id);
      const v = m ? this.view(m) : undefined;
      return { medication: v?.label ?? "Unknown", personName: v?.personName ?? "Unknown", requestedBy: r.requested_by, requestedAt: r.created_at };
    });
    return {
      fromDate,
      toDate: today,
      days,
      generatedAt: now.toISOString(),
      people: report,
      supplyAlerts: this.forecastRefills({ person: input.person, withinDays: 7 }).filter((f) => f.urgency !== "ok"),
      openRefillRequests: open,
      recentActivity: this.store.recentActivity(8).map((a) => ({ at: a.at, actor: a.actor, message: a.message })),
    };
  }

  recentActivity(limit = 20): { at: string; actor: string; kind: string; message: string }[] {
    return this.store.recentActivity(Math.min(Math.max(limit, 1), 100)).map((a) => ({ at: a.at, actor: a.actor, kind: a.kind, message: a.message }));
  }
}
