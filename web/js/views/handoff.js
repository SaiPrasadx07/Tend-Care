import { state, setHandoffDays, actor } from "../api.js";
import { h, icon, fmtDateLong, fmtDateShort, fmtDay, fmtTime, hhmmLabel, toast, plural, monogram, listJoin } from "../ui.js";
import { adherenceGrid, stateLegend, stackBar } from "../charts.js";
import { refillStage } from "./supply.js";

const alias = (name) => state.data.recipients.find((r) => r.name === name)?.aliases[0];
const who = (name) => (alias(name) ? `${name} (${alias(name)})` : name);

/** The handful of things the next caregiver must know, in priority order. All from logged records. */
function keyPoints(r) {
  const points = [];
  for (const p of r.people) {
    if (p.missedDoses.length) {
      const items = p.missedDoses.slice(-3).map((m) => `${m.medication.split(" ")[0]} ${fmtDateShort(m.date).replace(/^\w+, /, "")} ${hhmmLabel(m.time)}`);
      points.push({ tone: "missed", icon: "alert", text: `${who(p.name)}: ${plural(p.missedDoses.length, "dose")} not logged (${listJoin(items)}${p.missedDoses.length > 3 ? ", …" : ""}).` });
    }
  }
  for (const p of r.people) {
    const n = p.notes.at(-1);
    if (n) points.push({ tone: n.category === "symptom" ? "missed" : "obs", icon: "note", text: `${who(p.name)}: “${n.text.replace(/[.!?]+$/, "")}” (${n.loggedBy}, ${fmtDay(n.at)})` });
  }
  const pendingByMed = new Map(state.data.status.pendingActions.map((a) => [a.medicationId, a]));
  const openByKey = new Map(r.openRefillRequests.map((o) => [`${o.personName}|${o.medication}`, o]));
  for (const f of state.data.forecast) {
    const stage = refillStage(f, pendingByMed.get(f.medicationId), openByKey.get(`${f.personName}|${f.medication}`));
    if (stage.key === "stocked") continue;
    const tone = stage.key === "requested" ? "task" : stage.key === "awaiting" ? "task" : "warn";
    points.push({ tone, icon: "box", text: `${f.personName}'s ${f.medication}: ${stage.label.toLowerCase()}, ${plural(f.daysLeft, "day")} of supply. ${stage.detail}` });
  }
  return points;
}

function person(p, toDate) {
  return h("section", { class: "doc-section" },
    h("h3", {}, monogram(p.name), who(p.name), h("span", { class: "pct num" }, p.overallAdherencePct == null ? "—" : `${p.overallAdherencePct}%`)),
    h("p", { class: "small muted", style: "margin:0" }, p.overallAdherencePct == null ? "No doses were due in this period." : "of scheduled doses were logged as given"),
    h("h4", {}, "By medication"),
    p.adherence.map((a) => h("div", { class: "bar-line" },
      h("span", {}, a.medication, h("span", { class: "tiny muted" }, ` · ${a.taken}/${a.scheduled} given${a.skipped ? `, ${a.skipped} skipped` : ""}${a.missed ? `, ${a.missed} not logged` : ""}`)),
      stackBar(a),
      h("span", { class: "num", style: "text-align:right;font-weight:600" }, a.adherencePct == null ? "—" : `${a.adherencePct}%`))),
    p.adherence.length ? h("div", { style: "margin-top:14px" }, adherenceGrid(p.adherence, toDate)) : null,
    h("div", { class: "doc-cols" },
      h("div", {},
        h("h4", {}, "Doses not logged"),
        p.missedDoses.length
          ? h("ul", { class: "plain" }, p.missedDoses.map((m) => h("li", {}, `${fmtDateShort(m.date)}, ${hhmmLabel(m.time)}: ${m.medication}`)))
          : h("p", { class: "small muted", style: "margin:0" }, "None in this period.")),
      h("div", {},
        h("h4", {}, "Observations"),
        p.notes.length
          ? h("ul", { class: "notes" }, p.notes.map((n) => h("li", { class: `note ${n.category}` }, h("p", {}, n.text), h("div", { class: "by" }, `${n.category[0].toUpperCase() + n.category.slice(1)} · recorded by ${n.loggedBy} · ${fmtDay(n.at)}, ${fmtTime(n.at)}`))))
          : h("p", { class: "small muted", style: "margin:0" }, "None recorded."))));
}

export function renderHandoff() {
  const r = state.data.handoff;
  const days = [3, 7, 14];
  const points = keyPoints(r);
  const contributors = [...new Set(r.recentActivity.map((a) => a.actor))];
  return h("div", { class: "view" },
    h("div", { class: "toolbar no-print" },
      h("div", { class: "segmented", role: "group", "aria-label": "Report period" }, days.map((d) => h("button", {
        "aria-pressed": String(r.days === d),
        onclick: async () => { await setHandoffDays(d); },
      }, `${d} days`))),
      h("div", { style: "display:flex;gap:8px" },
        h("button", {
          class: "btn btn-secondary btn-sm", onclick: async () => {
            try { await navigator.clipboard.writeText(state.data.handoffSpeech); toast("Summary copied"); } catch { toast("Clipboard isn't available here.", "error"); }
          },
        }, icon("copy", "sm"), "Copy summary"),
        h("button", { class: "btn btn-primary btn-sm", onclick: () => window.print() }, icon("print", "sm"), "Print or save PDF"))),
    h("article", { class: "doc" },
      h("header", { class: "doc-head" },
        h("div", {}, h("p", { class: "eyebrow" }, "Care handoff"), h("h1", { class: "display" }, `${fmtDateShort(r.fromDate)} – ${fmtDateShort(r.toDate)}`)),
        h("div", { class: "doc-meta" }, `Prepared ${fmtDateLong(r.toDate)}, ${fmtTime(r.generatedAt)}`, h("br"), `for the next caregiver, from records logged by ${listJoin(contributors) || "the care circle"}`)),
      h("section", { class: "doc-section glance-points" },
        h("h3", {}, "For the next caregiver"),
        points.length
          ? h("ul", { class: "points" }, points.map((p) => h("li", { class: p.tone }, icon(p.icon, "sm"), h("span", {}, p.text))))
          : h("p", { class: "small" }, "No missed doses, observations or open tasks in this period. Everything is on track.")),
      h("p", { class: "doc-summary" }, h("span", { class: "eyebrow", style: "display:block;margin-bottom:6px" }, "In brief"), state.data.handoffSpeech),
      r.people.map((p) => person(p, r.toDate)),
      h("section", { class: "doc-section" },
        h("h3", {}, "Record of care"),
        h("p", { class: "small muted", style: "margin:0 0 8px" }, "The most recent entries, exactly as logged."),
        h("ul", { class: "plain log" }, r.recentActivity.map((a) => h("li", {}, h("span", { class: "num tiny muted" }, `${fmtDay(a.at)}, ${fmtTime(a.at)}`), " ", a.message)))),
      stateLegend(),
      h("p", { class: "tiny muted", style: "margin-top:28px" }, `Prepared by Tend for ${actor()?.name ?? "the care circle"} from caregiver-logged records. Tend does not interpret symptoms or give medical advice; share this with the care team as a record of what was logged.`)));
}
