import { state, canWrite } from "../api.js";
import { h, icon, monogram, hhmmLabel, fmtDay, fmtTime, urgencyChip, listJoin, relTime } from "../ui.js";
import { addNote, addMedication, viewOnlyReason } from "../actions.js";
import { adherenceGrid, stateLegend } from "../charts.js";

function supplyCell(med, f) {
  const days = f?.daysLeft ?? Math.floor(med.quantityOnHand / (med.doseUnits * med.times.length));
  const pct = Math.min(days / 30, 1) * 100;
  const color = f?.urgency === "critical" ? "var(--st-missed)" : f?.urgency === "soon" ? "var(--st-skipped)" : "var(--forest-2)";
  return h("td", {},
    h("b", { class: "num" }, `${med.quantityOnHand}`), ` ${med.unitLabel}${med.quantityOnHand === 1 ? "" : "s"}`,
    h("div", { class: "tiny muted num" }, `≈ ${days} days`),
    h("div", { class: "mini-supply", role: "img", "aria-label": `${days} days of supply` }, h("span", { style: `width:${pct}%;background:${color}` })));
}

function profile(person, status, handoffPerson, forecast) {
  const today = status?.slots ?? [];
  const given = today.filter((s) => s.state === "taken").length;
  const next = today.find((s) => s.state === "due" || s.state === "upcoming");
  const fc = new Map(forecast.filter((f) => f.personName === person.name).map((f) => [f.medicationId, f]));
  const caregivers = [...new Set(today.map((s) => s.loggedBy).filter(Boolean))];
  const notes = [...(handoffPerson?.notes ?? [])].reverse();

  const actions = canWrite()
    ? [h("button", { class: "btn btn-secondary btn-sm", onclick: () => addNote(person.name) }, icon("note", "sm"), "Add note"),
      h("button", { class: "btn btn-secondary btn-sm", onclick: () => addMedication(person.name) }, icon("plus", "sm"), "Add medication")]
    : h("span", { class: "tiny muted" }, viewOnlyReason());

  return h("article", { class: "card", id: `person-${person.personId}` },
    h("div", { class: "profile-head" },
      monogram(person.name, "lg"),
      h("div", {},
        h("h2", { class: "display display-l" }, person.name),
        h("div", { class: "aka" }, person.aliases.length ? `Also called ${listJoin(person.aliases)}` : "", caregivers.length ? ` · Today's doses given by ${listJoin(caregivers)}` : "")),
      h("div", { style: "margin-left:auto;display:flex;gap:8px;flex-wrap:wrap" }, actions)),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("div", { class: "v" }, handoffPerson?.overallAdherencePct == null ? "—" : `${handoffPerson.overallAdherencePct}%`), h("div", { class: "k" }, `Doses given, last ${state.handoffDays} days`)),
      h("div", { class: "stat" }, h("div", { class: "v" }, `${given}/${today.length}`), h("div", { class: "k" }, "Given today")),
      h("div", { class: "stat" }, h("div", { class: "v" }, String(person.medications.length)), h("div", { class: "k" }, "Active medications")),
      h("div", { class: "stat" }, h("div", { class: "v" }, next ? hhmmLabel(next.time) : "—"), h("div", { class: "k" }, next ? `Next: ${next.medication.split(" ")[0]}` : "Nothing else today"))),
    h("div", { class: "grid-2 profile-grid" },
      h("section", {},
        h("h3", { class: "eyebrow", style: "margin:4px 0 12px" }, "Medications"),
        h("table", { class: "meds" },
          h("thead", {}, h("tr", {}, ["Medication", "Schedule", "Supply", "Refills"].map((t) => h("th", { scope: "col" }, t)))),
          h("tbody", {}, person.medications.map((m) => {
            const f = fc.get(m.id);
            return h("tr", {},
              h("td", {}, h("b", {}, m.label), h("div", { class: "tiny muted" }, [`${m.doseUnits} ${m.unitLabel}${m.doseUnits === 1 ? "" : "s"}`, m.instructions].filter(Boolean).join(" · "))),
              h("td", {}, h("div", { class: "times" }, m.times.map((t) => h("span", { class: "time-tag" }, hhmmLabel(t))))),
              supplyCell(m, f),
              h("td", {}, h("div", { class: "num" }, String(m.refillsRemaining)), m.pharmacy ? h("div", { class: "tiny muted" }, m.pharmacy) : null, f && f.urgency !== "ok" ? h("div", { style: "margin-top:6px" }, urgencyChip(f.urgency)) : null));
          }))),
        handoffPerson?.adherence.length ? h("div", { style: "margin-top:24px" },
          h("h3", { class: "eyebrow", style: "margin:0 0 12px" }, `Dose history · last ${state.handoffDays} days`),
          adherenceGrid(handoffPerson.adherence, state.data.handoff.toDate), stateLegend()) : null),
      h("section", {},
        h("h3", { class: "eyebrow", style: "margin:4px 0 14px" }, `Notes · last ${state.handoffDays} days`),
        notes.length
          ? h("ul", { class: "notes" }, notes.map((n) => h("li", { class: `note ${n.category}` }, h("p", {}, n.text), h("div", { class: "by" }, `${n.category[0].toUpperCase() + n.category.slice(1)} · ${n.loggedBy} · ${fmtDay(n.at)}, ${fmtTime(n.at)}`))))
          : h("p", { class: "muted small" }, "No notes in this period."))));
}

const ROLE_TEXT = {
  caregiver: "Can log doses, add notes and medications, and request refills.",
  viewer: "Can see everything. Can't change the care record.",
};

function careCircle(recipients, activity) {
  const last = new Map();
  for (const a of activity) if (!last.has(a.actor)) last.set(a.actor, a);
  const me = state.actorId;
  return h("section", { class: "circle" },
    h("div", { class: "circle-recipients" },
      h("p", { class: "eyebrow" }, "Caring for"),
      h("div", { class: "circle-people" }, recipients.map((p) => h("a", { class: "circle-person", href: `#/people`, onclick: (e) => { e.preventDefault(); document.getElementById(`person-${p.personId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); } },
        monogram(p.name, "md"), h("span", {}, h("b", {}, p.name), h("small", {}, [p.aliases.join(" · "), `${p.medications.length} medications`].filter(Boolean).join(" · "))))))),
    h("div", { class: "circle-team" },
      h("p", { class: "eyebrow" }, "The care circle"),
      h("ul", { class: "team" }, state.config.caregivers.map((c) => {
        const a = last.get(c.name);
        return h("li", { class: c.id === me ? "me" : "" },
          monogram(c.name),
          h("div", {},
            h("div", { class: "team-name" }, c.name, c.id === me ? h("span", { class: "you" }, "you") : null, h("span", { class: `role ${c.role}` }, c.role === "viewer" ? "View only" : "Caregiver")),
            h("p", {}, ROLE_TEXT[c.role]),
            h("p", { class: "tiny muted" }, a ? `Last update ${relTime(a.at)}: ${a.message}` : "No recent updates in the care record.")));
      }))));
}

export function renderPeople() {
  const { recipients, status, handoff, forecast, activity } = state.data;
  return h("div", { class: "view" },
    h("header", { class: "hero" },
      h("div", {}, h("p", { class: "eyebrow" }, "People"), h("h1", { class: "display display-xl" }, "The care circle"),
        h("p", { class: "lede" }, "Who we look after, who helps, and what each person is allowed to do. Medications, supply and notes are kept in one shared record."))),
    careCircle(recipients, activity),
    h("div", { class: "stack", style: "margin-top:28px" }, recipients.map((p) => profile(p, status.people.find((x) => x.personId === p.personId), handoff.people.find((x) => x.personId === p.personId), forecast))));
}
