// Demo household: two siblings (Priya, Arjun) caring for their parents.
// History is generated through CareService (not raw SQL) relative to "now",
// with realistic gaps so status, adherence and forecasts have something to say.
import type { Actor, CareService } from "./domain/care.ts";
import { addDays, zonedParts, zonedToUtc } from "./domain/time.ts";

const PRIYA: Actor = { id: "priya", name: "Priya", role: "caregiver" };
const ARJUN: Actor = { id: "arjun", name: "Arjun", role: "caregiver" };

interface SeedMed {
  person: string;
  name: string;
  strength: string;
  times: string[];
  instructions: string;
  finalStock: number;
  refills: number;
  pharmacy: string;
  /** [daysAgo, "HH:MM"] slots to leave unlogged (missed). */
  missed: [number, string][];
  skipped?: [number, string][];
}

const MEDS: SeedMed[] = [
  { person: "Lakshmi", name: "Metformin", strength: "500 mg", times: ["08:00", "20:00"], instructions: "with food", finalStock: 7, refills: 2, pharmacy: "Walgreens on 5th Ave", missed: [[3, "20:00"]] },
  { person: "Lakshmi", name: "Lisinopril", strength: "10 mg", times: ["08:00"], instructions: "", finalStock: 24, refills: 3, pharmacy: "Walgreens on 5th Ave", missed: [] },
  { person: "Lakshmi", name: "Atorvastatin", strength: "20 mg", times: ["21:00"], instructions: "at bedtime", finalStock: 40, refills: 5, pharmacy: "Walgreens on 5th Ave", missed: [[5, "21:00"]] },
  { person: "Ravi", name: "Levothyroxine", strength: "50 mcg", times: ["06:30"], instructions: "empty stomach, 30 min before breakfast", finalStock: 20, refills: 1, pharmacy: "CVS on Elm St", missed: [] },
  { person: "Ravi", name: "Amlodipine", strength: "5 mg", times: ["09:00"], instructions: "", finalStock: 5, refills: 0, pharmacy: "CVS on Elm St", missed: [[2, "09:00"], [4, "09:00"]], skipped: [[1, "09:00"]] },
];

const HISTORY_DAYS = 6;

export function seedDemo(care: CareService, opts: { reset?: boolean; now?: Date } = {}): void {
  const store = care.store;
  if (opts.reset) store.reset();
  if (store.listPeople().length > 0) return;
  const now = opts.now ?? new Date();
  const tz = care.tz;
  const today = zonedParts(now, tz).date;
  const createdAt = zonedToUtc(addDays(today, -(HISTORY_DAYS + 1)), "00:00", tz).toISOString();

  care.addPerson({ name: "Lakshmi", aliases: ["Mom", "Amma"] }, PRIYA);
  care.addPerson({ name: "Ravi", aliases: ["Dad", "Appa"] }, ARJUN);

  for (const m of MEDS) {
    const med = care.addMedication(
      { person: m.person, name: m.name, strength: m.strength, times: m.times, instructions: m.instructions, quantityOnHand: 500, refillsRemaining: m.refills, pharmacy: m.pharmacy },
      PRIYA,
      { createdAt },
    );
    let i = 0;
    for (let daysAgo = HISTORY_DAYS; daysAgo >= 0; daysAgo--) {
      const date = addDays(today, -daysAgo);
      for (const time of m.times) {
        const instant = zonedToUtc(date, time, tz);
        // Leave today's not-yet-reached doses (and the most recent one) open for the live demo.
        if (instant.getTime() > now.getTime() - 30 * 60_000) continue;
        if (daysAgo === 0 && m.name === "Amlodipine") continue;
        if (m.missed.some(([d, t]) => d === daysAgo && t === time)) continue;
        const skipped = m.skipped?.some(([d, t]) => d === daysAgo && t === time);
        const at = new Date(instant.getTime() + ((i++ * 7) % 25) * 60_000).toISOString();
        care.logDose(
          { medication: med.id, person: m.person, status: skipped ? "skipped" : "taken", at, slotTime: time, note: skipped ? "Felt lightheaded, held the dose" : "" },
          i % 3 === 0 ? ARJUN : PRIYA,
          { allowBackfill: true },
        );
      }
    }
    store.db.prepare("UPDATE medications SET quantity_on_hand = ? WHERE id = ?").run(m.finalStock, med.id);
  }

  care.addNote(
    { person: "Ravi", text: "Dad felt dizzy after standing up quickly this morning.", category: "symptom" },
    ARJUN,
    { at: zonedToUtc(addDays(today, -2), "10:15", tz).toISOString() },
  );
  care.addNote(
    { person: "Lakshmi", text: "Cardiology follow-up booked for Friday at 10 AM.", category: "appointment" },
    PRIYA,
    { at: zonedToUtc(addDays(today, -1), "17:40", tz).toISOString() },
  );
}
