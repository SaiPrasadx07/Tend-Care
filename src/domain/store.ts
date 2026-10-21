// Persistence for Tend, on Node's built-in SQLite (node:sqlite, no native deps).
// All state survives restarts, which is what lets the Alexa+ add-on keep
// context across sessions and across caregivers.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type Role = "caregiver" | "viewer";

export interface PersonRow {
  id: string;
  name: string;
  aliases: string; // comma-separated, e.g. "Mom,Amma"
  created_at: string;
}

export interface MedicationRow {
  id: string;
  person_id: string;
  name: string;
  strength: string;
  dose_units: number;
  unit_label: string;
  times: string; // JSON array of "HH:MM"
  instructions: string;
  quantity_on_hand: number;
  refills_remaining: number;
  pharmacy: string;
  active: number;
  created_at: string; // ISO instant; schedule slots before this are not counted
}

export type DoseStatus = "taken" | "skipped";

export interface DoseEventRow {
  id: string;
  medication_id: string;
  slot_date: string;
  slot_time: string;
  status: DoseStatus;
  recorded_at: string;
  logged_by: string;
  note: string;
}

export interface NoteRow {
  id: string;
  person_id: string;
  category: string;
  text: string;
  recorded_at: string;
  logged_by: string;
}

export interface PendingActionRow {
  id: string;
  type: string;
  payload: string; // JSON
  summary: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  status: "pending" | "confirmed" | "cancelled" | "expired";
}

export interface RefillRequestRow {
  id: string;
  medication_id: string;
  status: "open" | "fulfilled";
  requested_by: string;
  created_at: string;
  fulfilled_at: string | null;
}

export interface ActivityRow {
  id: string;
  at: string;
  actor: string;
  kind: string;
  message: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS medications (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  name TEXT NOT NULL,
  strength TEXT NOT NULL DEFAULT '',
  dose_units REAL NOT NULL,
  unit_label TEXT NOT NULL DEFAULT 'tablet',
  times TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  quantity_on_hand REAL NOT NULL,
  refills_remaining INTEGER NOT NULL DEFAULT 0,
  pharmacy TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dose_events (
  id TEXT PRIMARY KEY,
  medication_id TEXT NOT NULL REFERENCES medications(id),
  slot_date TEXT NOT NULL,
  slot_time TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('taken','skipped')),
  recorded_at TEXT NOT NULL,
  logged_by TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_dose_slot ON dose_events(medication_id, slot_date, slot_time);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  logged_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refill_requests (
  id TEXT PRIMARY KEY,
  medication_id TEXT NOT NULL REFERENCES medications(id),
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  fulfilled_at TEXT
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` atomically. node:sqlite is synchronous, so a plain BEGIN/COMMIT is safe. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  reset(): void {
    this.db.exec(
      "DELETE FROM activity; DELETE FROM refill_requests; DELETE FROM pending_actions; DELETE FROM notes; DELETE FROM dose_events; DELETE FROM medications; DELETE FROM people;",
    );
  }

  // --- people ---
  insertPerson(p: Omit<PersonRow, "id"> & { id?: string }): PersonRow {
    const row: PersonRow = { id: p.id ?? randomUUID(), name: p.name, aliases: p.aliases, created_at: p.created_at };
    this.db.prepare("INSERT INTO people (id, name, aliases, created_at) VALUES (?, ?, ?, ?)").run(row.id, row.name, row.aliases, row.created_at);
    return row;
  }

  listPeople(): PersonRow[] {
    return this.db.prepare("SELECT * FROM people ORDER BY created_at, name").all() as unknown as PersonRow[];
  }

  // --- medications ---
  insertMedication(m: Omit<MedicationRow, "id"> & { id?: string }): MedicationRow {
    const row: MedicationRow = { ...m, id: m.id ?? randomUUID() };
    this.db
      .prepare(
        `INSERT INTO medications (id, person_id, name, strength, dose_units, unit_label, times, instructions,
          quantity_on_hand, refills_remaining, pharmacy, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.person_id, row.name, row.strength, row.dose_units, row.unit_label, row.times,
        row.instructions, row.quantity_on_hand, row.refills_remaining, row.pharmacy, row.active, row.created_at,
      );
    return row;
  }

  listMedications(personId?: string): MedicationRow[] {
    if (personId) {
      return this.db.prepare("SELECT * FROM medications WHERE active = 1 AND person_id = ? ORDER BY name").all(personId) as unknown as MedicationRow[];
    }
    return this.db.prepare("SELECT * FROM medications WHERE active = 1 ORDER BY person_id, name").all() as unknown as MedicationRow[];
  }

  getMedication(id: string): MedicationRow | undefined {
    return this.db.prepare("SELECT * FROM medications WHERE id = ?").get(id) as unknown as MedicationRow | undefined;
  }

  adjustStock(medicationId: string, deltaUnits: number, deltaRefills = 0): void {
    this.db
      .prepare(
        "UPDATE medications SET quantity_on_hand = MAX(0, quantity_on_hand + ?), refills_remaining = MAX(0, refills_remaining + ?) WHERE id = ?",
      )
      .run(deltaUnits, deltaRefills, medicationId);
  }

  // --- dose events ---
  insertDose(e: Omit<DoseEventRow, "id">): DoseEventRow {
    const row: DoseEventRow = { ...e, id: randomUUID() };
    this.db
      .prepare(
        "INSERT INTO dose_events (id, medication_id, slot_date, slot_time, status, recorded_at, logged_by, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.medication_id, row.slot_date, row.slot_time, row.status, row.recorded_at, row.logged_by, row.note);
    return row;
  }

  dosesForSlot(medicationId: string, date: string, time: string): DoseEventRow[] {
    return this.db
      .prepare("SELECT * FROM dose_events WHERE medication_id = ? AND slot_date = ? AND slot_time = ? ORDER BY recorded_at")
      .all(medicationId, date, time) as unknown as DoseEventRow[];
  }

  dosesInRange(medicationIds: string[], fromDate: string, toDate: string): DoseEventRow[] {
    if (medicationIds.length === 0) return [];
    const marks = medicationIds.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM dose_events WHERE medication_id IN (${marks}) AND slot_date >= ? AND slot_date <= ? ORDER BY recorded_at`)
      .all(...medicationIds, fromDate, toDate) as unknown as DoseEventRow[];
  }

  // --- notes ---
  insertNote(n: Omit<NoteRow, "id">): NoteRow {
    const row: NoteRow = { ...n, id: randomUUID() };
    this.db
      .prepare("INSERT INTO notes (id, person_id, category, text, recorded_at, logged_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, row.person_id, row.category, row.text, row.recorded_at, row.logged_by);
    return row;
  }

  notesSince(personIds: string[], sinceIso: string): NoteRow[] {
    if (personIds.length === 0) return [];
    const marks = personIds.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM notes WHERE person_id IN (${marks}) AND recorded_at >= ? ORDER BY recorded_at`)
      .all(...personIds, sinceIso) as unknown as NoteRow[];
  }

  // --- pending actions (two-phase confirmation) ---
  insertPendingAction(a: Omit<PendingActionRow, "id" | "status">): PendingActionRow {
    const row: PendingActionRow = { ...a, id: randomUUID(), status: "pending" };
    this.db
      .prepare(
        "INSERT INTO pending_actions (id, type, payload, summary, created_by, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.type, row.payload, row.summary, row.created_by, row.created_at, row.expires_at, row.status);
    return row;
  }

  getPendingAction(id: string): PendingActionRow | undefined {
    return this.db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id) as unknown as PendingActionRow | undefined;
  }

  listPendingActions(): PendingActionRow[] {
    return this.db.prepare("SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC").all() as unknown as PendingActionRow[];
  }

  /** Compare-and-set so a pending action can only be resolved once. */
  resolvePendingAction(id: string, status: PendingActionRow["status"]): boolean {
    const res = this.db.prepare("UPDATE pending_actions SET status = ? WHERE id = ? AND status = 'pending'").run(status, id);
    return Number(res.changes) === 1;
  }

  // --- refill requests ---
  insertRefillRequest(r: Omit<RefillRequestRow, "id" | "status" | "fulfilled_at">): RefillRequestRow {
    const row: RefillRequestRow = { ...r, id: randomUUID(), status: "open", fulfilled_at: null };
    this.db
      .prepare("INSERT INTO refill_requests (id, medication_id, status, requested_by, created_at, fulfilled_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, row.medication_id, row.status, row.requested_by, row.created_at, row.fulfilled_at);
    return row;
  }

  openRefillRequests(medicationId?: string): RefillRequestRow[] {
    if (medicationId) {
      return this.db
        .prepare("SELECT * FROM refill_requests WHERE status = 'open' AND medication_id = ? ORDER BY created_at")
        .all(medicationId) as unknown as RefillRequestRow[];
    }
    return this.db.prepare("SELECT * FROM refill_requests WHERE status = 'open' ORDER BY created_at").all() as unknown as RefillRequestRow[];
  }

  fulfillRefillRequests(medicationId: string, at: string): number {
    const res = this.db
      .prepare("UPDATE refill_requests SET status = 'fulfilled', fulfilled_at = ? WHERE medication_id = ? AND status = 'open'")
      .run(at, medicationId);
    return Number(res.changes);
  }

  // --- activity feed ---
  insertActivity(a: Omit<ActivityRow, "id">): void {
    this.db.prepare("INSERT INTO activity (id, at, actor, kind, message) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), a.at, a.actor, a.kind, a.message);
  }

  recentActivity(limit: number): ActivityRow[] {
    return this.db.prepare("SELECT * FROM activity ORDER BY at DESC LIMIT ?").all(limit) as unknown as ActivityRow[];
  }
}
