import { Store } from "../src/domain/store.ts";
import { CareService, type Actor } from "../src/domain/care.ts";
import { zonedToUtc } from "../src/domain/time.ts";

export const TZ = "America/Los_Angeles";
export const PRIYA: Actor = { id: "priya", name: "Priya", role: "caregiver" };
export const ARJUN: Actor = { id: "arjun", name: "Arjun", role: "caregiver" };
export const MARIA: Actor = { id: "maria", name: "Nurse Maria", role: "viewer" };

/** A controllable clock pinned to a local wall-clock time in TZ. */
export class Clock {
  t: Date;
  constructor(date: string, time: string) {
    this.t = zonedToUtc(date, time, TZ);
  }
  set(date: string, time: string): void {
    this.t = zonedToUtc(date, time, TZ);
  }
  advanceMinutes(m: number): void {
    this.t = new Date(this.t.getTime() + m * 60_000);
  }
  now = (): Date => this.t;
}

export function makeCare(clock: Clock): CareService {
  const store = new Store(":memory:");
  return new CareService(store, { timezone: TZ, now: clock.now });
}

/** Mom with metformin twice daily (8:00, 20:00), 10 tablets, 2 refills; added the day before. */
export function seedBasic(care: CareService, clock: Clock): void {
  care.addPerson({ name: "Lakshmi", aliases: ["Mom"] }, PRIYA);
  care.addPerson({ name: "Ravi", aliases: ["Dad"] }, PRIYA);
  const createdAt = new Date(clock.t.getTime() - 3 * 86_400_000).toISOString();
  care.addMedication(
    { person: "Mom", name: "Metformin", strength: "500 mg", times: ["20:00", "08:00"], quantityOnHand: 10, refillsRemaining: 2, pharmacy: "Maple Street Pharmacy" },
    PRIYA,
    { createdAt },
  );
  care.addMedication({ person: "Dad", name: "Amlodipine", strength: "5 mg", times: ["09:00"], quantityOnHand: 30, refillsRemaining: 0 }, PRIYA, { createdAt });
}
