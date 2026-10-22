import { test } from "node:test";
import assert from "node:assert/strict";
import { CareError } from "../src/domain/care.ts";
import { ARJUN, Clock, MARIA, PRIYA, makeCare, seedBasic } from "./helpers.ts";

function setup(time = "08:10") {
  const clock = new Clock("2026-10-21", time);
  const care = makeCare(clock);
  seedBasic(care, clock);
  return { clock, care };
}

const stockOf = (care: ReturnType<typeof setup>["care"], name: string) =>
  care.listRecipients().flatMap((p) => p.medications).find((m) => m.name === name)!.quantityOnHand;

test("log_dose matches the nearest scheduled slot and decrements stock", () => {
  const { care } = setup("08:10");
  const r = care.logDose({ medication: "metformin", person: "Mom" }, PRIYA);
  assert.equal(r.outcome, "logged");
  assert.equal(r.slotDate, "2026-10-21");
  assert.equal(r.slotTime, "08:00");
  assert.equal(r.quantityOnHand, 9);
  assert.equal(stockOf(care, "Metformin"), 9);
});

test("person is inferred when the medication name is unique in the household", () => {
  const { care } = setup("09:05");
  const r = care.logDose({ medication: "Amlodipine" }, ARJUN);
  assert.equal(r.personName, "Ravi");
  assert.equal(r.slotTime, "09:00");
});

test("double-dose guard: a second caregiver logging the same slot is stopped, nothing saved", () => {
  const { care, clock } = setup("08:05");
  care.logDose({ medication: "metformin", person: "Mom" }, PRIYA);
  clock.advanceMinutes(20);
  const dup = care.logDose({ medication: "metformin", person: "Mom" }, ARJUN);
  assert.equal(dup.outcome, "needs_confirmation");
  assert.equal(dup.previous?.loggedBy, "Priya");
  assert.match(dup.message, /already logged as taken at 8:05 AM by Priya/);
  assert.equal(stockOf(care, "Metformin"), 9, "stock must not change on a blocked duplicate");

  const forced = care.logDose({ medication: "metformin", person: "Mom", confirmDuplicate: true }, ARJUN);
  assert.equal(forced.outcome, "logged");
  assert.equal(stockOf(care, "Metformin"), 8);
  assert.equal(care.recentActivity(1)[0]!.kind, "extra_dose");
});

test("evening log at 00:30 maps to yesterday's 20:00 slot, not tomorrow's 08:00", () => {
  const { care } = setup("00:30");
  const r = care.logDose({ medication: "metformin", person: "Mom" }, PRIYA);
  assert.equal(r.slotDate, "2026-10-20");
  assert.equal(r.slotTime, "20:00");
});

test("explicit slot_time and skipped status; skipping after taken restores stock", () => {
  const { care } = setup("08:20");
  care.logDose({ medication: "metformin", person: "Mom" }, PRIYA);
  assert.equal(stockOf(care, "Metformin"), 9);
  const s = care.logDose({ medication: "metformin", person: "Mom", status: "skipped", slotTime: "08:00" }, PRIYA);
  assert.equal(s.status, "skipped");
  assert.equal(stockOf(care, "Metformin"), 10);
  assert.throws(() => care.logDose({ medication: "metformin", person: "Mom", slotTime: "13:00" }, PRIYA), /scheduled at 8:00 AM and 8:00 PM/);
});

test("rejects future and stale timestamps", () => {
  const { care, clock } = setup("08:20");
  const future = new Date(clock.t.getTime() + 60 * 60_000).toISOString();
  assert.throws(() => care.logDose({ medication: "metformin", person: "Mom", at: future }, PRIYA), /future/);
  const stale = new Date(clock.t.getTime() - 48 * 3_600_000).toISOString();
  assert.throws(() => care.logDose({ medication: "metformin", person: "Mom", at: stale }, PRIYA), /36 hours/);
});

test("viewer role cannot write", () => {
  const { care } = setup();
  assert.throws(
    () => care.logDose({ medication: "metformin", person: "Mom" }, MARIA),
    (e: unknown) => e instanceof CareError && e.code === "FORBIDDEN",
  );
  assert.throws(() => care.addNote({ person: "Mom", text: "hi" }, MARIA), /view-only/);
});

test("status classifies taken / missed / due / upcoming by time of day", () => {
  const { care, clock } = setup("08:05");
  care.logDose({ medication: "metformin", person: "Mom" }, PRIYA);
  clock.set("2026-10-21", "11:00");
  const s = care.getStatus();
  const mom = s.people.find((p) => p.name === "Lakshmi")!;
  const dad = s.people.find((p) => p.name === "Ravi")!;
  assert.deepEqual(mom.slots.map((x) => [x.time, x.state]), [["08:00", "taken"], ["20:00", "upcoming"]]);
  assert.equal(mom.slots[0]!.loggedBy, "Priya");
  assert.deepEqual(dad.slots.map((x) => [x.time, x.state]), [["09:00", "missed"]]);
  clock.set("2026-10-21", "19:30");
  assert.equal(care.getStatus({ person: "Mom" }).people[0]!.slots[1]!.state, "due");
});

test("slots before a medication was added are not counted", () => {
  const clock = new Clock("2026-10-21", "12:00");
  const care = makeCare(clock);
  care.addPerson({ name: "Lakshmi", aliases: ["Mom"] }, PRIYA);
  care.addMedication({ person: "Mom", name: "Vitamin D", times: ["08:00"], quantityOnHand: 30 }, PRIYA);
  assert.equal(care.getStatus().people[0]!.slots.length, 0);
  assert.equal(care.handoffReport({ days: 3 }).people[0]!.overallAdherencePct, null);
});

test("refill forecast computes runout date and urgency", () => {
  const { care } = setup();
  const items = care.forecastRefills({ withinDays: 7 });
  const met = items.find((i) => i.medication.startsWith("Metformin"))!;
  assert.equal(met.unitsPerDay, 2);
  assert.equal(met.daysLeft, 5);
  assert.equal(met.runoutDate, "2026-10-26");
  assert.equal(met.urgency, "soon");
  assert.match(met.advice, /2 refills left/);
  const aml = items.find((i) => i.medication.startsWith("Amlodipine"))!;
  assert.equal(aml.urgency, "ok");
  assert.equal(items[0]!.medication, met.medication, "sorted by days left");
});

test("refill is two-phase: pending, confirm once, conflict on duplicates", () => {
  const { care } = setup();
  const pending = care.requestRefill({ medication: "metformin" }, PRIYA);
  assert.match(pending.summary, /Request a refill of Metformin 500 mg for Lakshmi from Maple Street Pharmacy/);
  assert.equal(care.store.openRefillRequests().length, 0, "nothing happens before confirmation");
  const done = care.confirmAction({ actionId: pending.actionId }, PRIYA);
  assert.match(done.pharmacyMessage!, /Please refill Metformin 500 mg/);
  assert.equal(care.store.openRefillRequests().length, 1);
  assert.throws(() => care.confirmAction({ actionId: pending.actionId }, PRIYA), /already confirmed/);
  assert.throws(() => care.requestRefill({ medication: "metformin" }, ARJUN), /already requested a refill/);
  assert.equal(care.forecastRefills().find((i) => i.medication.startsWith("Metformin"))!.openRefillRequest, true);

  const pickup = care.recordRefillPickup({ medication: "metformin", quantity: 60 }, ARJUN);
  assert.equal(pickup.quantityOnHand, 70);
  assert.equal(pickup.refillsRemaining, 1);
  assert.equal(care.store.openRefillRequests().length, 0);
});

test("pending actions expire and can be cancelled", () => {
  const { care, clock } = setup();
  const a = care.requestRefill({ medication: "metformin" }, PRIYA);
  clock.advanceMinutes(16);
  assert.throws(() => care.confirmAction({ actionId: a.actionId }, PRIYA), (e: unknown) => e instanceof CareError && e.code === "EXPIRED");
  const b = care.requestRefill({ medication: "metformin" }, PRIYA);
  assert.match(care.cancelAction({ actionId: b.actionId }, PRIYA).message, /cancelled/);
  assert.throws(() => care.confirmAction({ actionId: b.actionId }, PRIYA), /already cancelled/);
});

test("handoff report computes adherence, missed doses and notes over the window", () => {
  const { care, clock } = setup("08:05");
  // Yesterday: both metformin doses taken; amlodipine missed.
  for (const [time, at] of [["08:00", "08:03"], ["20:00", "20:10"]] as const) {
    const c2 = new Clock("2026-10-20", at);
    care.logDose({ medication: "metformin", person: "Mom", at: c2.t.toISOString(), slotTime: time }, PRIYA);
  }
  care.logDose({ medication: "metformin", person: "Mom" }, PRIYA); // today 08:00
  care.addNote({ person: "Dad", text: "Felt dizzy after lunch", category: "symptom" }, ARJUN);
  clock.set("2026-10-21", "12:00");
  const r = care.handoffReport({ days: 2 });
  assert.equal(r.fromDate, "2026-10-20");
  const mom = r.people.find((p) => p.name === "Lakshmi")!;
  // Counted slots: 10/20 08:00, 10/20 20:00, 10/21 08:00 (today's 20:00 not yet due) = 3/3.
  assert.equal(mom.adherence[0]!.scheduled, 3);
  assert.equal(mom.overallAdherencePct, 100);
  const dad = r.people.find((p) => p.name === "Ravi")!;
  assert.equal(dad.adherence[0]!.missed, 2);
  assert.equal(dad.overallAdherencePct, 0);
  assert.deepEqual(dad.missedDoses.map((m) => m.date), ["2026-10-20", "2026-10-21"]);
  assert.equal(dad.notes[0]!.text, "Felt dizzy after lunch");
});

test("name resolution: aliases, ambiguity and helpful not-found errors", () => {
  const { care } = setup();
  assert.equal(care.resolvePerson("mom").name, "Lakshmi");
  assert.equal(care.resolvePerson("RAVI").name, "Ravi");
  assert.throws(() => care.resolvePerson(), /Which person\? I'm tracking Lakshmi and Ravi/);
  assert.throws(() => care.resolvePerson("Grandpa"), /couldn't match "Grandpa"/);
  care.addMedication({ person: "Dad", name: "Metformin", times: ["08:00"], quantityOnHand: 10 }, PRIYA);
  assert.throws(() => care.resolveMedication("metformin"), (e: unknown) => e instanceof CareError && e.code === "AMBIGUOUS");
  assert.equal(care.resolveMedication("metformin", "dad").person.name, "Ravi");
});

test("add_medication validates schedule and duplicates", () => {
  const { care } = setup();
  assert.throws(() => care.addMedication({ person: "Mom", name: "X", times: ["8am"], quantityOnHand: 5 }, PRIYA), /HH:MM/);
  assert.throws(() => care.addMedication({ person: "Mom", name: "metformin", times: ["08:00"], quantityOnHand: 5 }, PRIYA), /already has/);
  const m = care.addMedication({ person: "Mom", name: "Aspirin", times: ["09:00", "09:00"], quantityOnHand: 5 }, PRIYA);
  assert.deepEqual(m.times, ["09:00"]);
});

test("handoff report includes a per-day slot grid for adherence visualisation", () => {
  const { care, clock } = setup("08:05");
  care.logDose({ medication: "metformin", person: "Mom" }, PRIYA); // today 08:00 taken
  clock.set("2026-10-21", "12:00");
  const r = care.handoffReport({ days: 5 });
  const met = r.people.find((p) => p.name === "Lakshmi")!.adherence[0]!;
  assert.deepEqual(met.times, ["08:00", "20:00"]);
  assert.equal(met.daily.length, 5);
  assert.deepEqual(met.daily.map((d) => d.date), ["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]);
  // Medication was added 3 days before "now" (10/18 12:00): earlier slots are untracked, later ones count.
  assert.deepEqual(met.daily[0]!.slots.map((s) => s.state), ["untracked", "untracked"]);
  assert.deepEqual(met.daily[1]!.slots.map((s) => s.state), ["untracked", "missed"]);
  assert.deepEqual(met.daily[4]!.slots, [{ time: "08:00", state: "taken" }, { time: "20:00", state: "upcoming" }]);
  // Grid and aggregates agree.
  const missedInGrid = met.daily.flatMap((d) => d.slots).filter((s) => s.state === "missed").length;
  assert.equal(missedInGrid, met.missed);
});

test("pending refill actions name their medication, so UIs can show them in place", () => {
  const { care } = setup();
  const met = care.listRecipients()[0]!.medications.find((m) => m.name === "Metformin")!;
  const pending = care.requestRefill({ medication: "metformin" }, PRIYA);
  assert.equal(pending.medicationId, met.id);
  assert.equal(care.getStatus().pendingActions[0]!.medicationId, met.id);
});
