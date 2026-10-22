// Small DOM toolkit: element builders, icons, formatters, toasts, tooltips, dialogs.
// Everything renders through text nodes (never innerHTML with data).

const SVG_NS = "http://www.w3.org/2000/svg";

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, kids);
  return el;
}

export function s(tag, props, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  append(el, kids);
  return el;
}

function applyProps(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false || k === "") continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

// ---------- icons (24px grid, 1.75 stroke) ----------
const PATHS = {
  check: "M5 12.5l4.2 4.2L19 7",
  x: "M6 6l12 12M18 6L6 18",
  alert: "M12 8v5M12 16.5v.5M10.3 3.9L2.6 17.5A2 2 0 004.3 20.5h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  skip: "M5 12h14M13 6l6 6-6 6",
  clock: "M12 7v5l3 2M12 21a9 9 0 110-18 9 9 0 010 18z",
  pill: "M10.5 20.5a5 5 0 01-7-7l6-6a5 5 0 017 7l-6 6zM8.5 8.5l7 7",
  refill: "M20 11a8 8 0 00-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0014.3 4.9L20 16M20 20v-4h-4",
  note: "M5 4h10l4 4v12H5zM15 4v4h4M8 12h8M8 16h5",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  users: "M9 11a4 4 0 100-8 4 4 0 000 8zM2 21a7 7 0 0114 0M16 3.5a4 4 0 010 7.5M18 14.5a7 7 0 014 6.5",
  mic: "M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM5.5 11.5a6.5 6.5 0 0013 0M12 18v3",
  send: "M5 12h13M13 6l6 6-6 6",
  chevron: "M9 6l6 6-6 6",
  down: "M6 9l6 6 6-6",
  print: "M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  code: "M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16",
  activity: "M3 12h4l3 8 4-16 3 8h4",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z M8.5 12l2.5 2.5 4.5-5",
  box: "M3 7.5L12 3l9 4.5v9L12 21l-9-4.5zM3 7.5L12 12l9-4.5M12 12v9",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 12a8 8 0 11-2.3-5.7M20 4v5h-5",
  close: "M6 6l12 12M18 6L6 18",
  info: "M12 11v6M12 7.5v.5M12 21a9 9 0 110-18 9 9 0 010 18z",
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  doc: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7",
  heart: "M12 20s-7.5-4.6-9-9.3C2 7.4 4.2 4.5 7.3 4.5c2 0 3.6 1.1 4.7 2.8 1.1-1.7 2.7-2.8 4.7-2.8 3.1 0 5.3 2.9 4.3 6.2C19.5 15.4 12 20 12 20z",
  sparkle: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  terminal: "M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  panel: "M4 4h16v16H4zM15 4v16",
};

export function icon(name, cls = "") {
  const svg = s("svg", { class: `icon ${cls}`, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
  svg.append(s("path", { d: PATHS[name] ?? PATHS.info }));
  return svg;
}

export function brandMark() {
  // Two arcs meeting: a care circle. Forest ring, teal inner arc.
  return s("svg", { class: "brand-mark", viewBox: "0 0 32 32", "aria-hidden": "true" },
    s("circle", { cx: 16, cy: 16, r: 12.5, fill: "none", stroke: "#1f4a37", "stroke-width": 4 }),
    s("path", { d: "M9.5 17.5a6.6 6.6 0 0013 0", fill: "none", stroke: "#237a76", "stroke-width": 3, "stroke-linecap": "round" }),
    s("circle", { cx: 16, cy: 11, r: 2.2, fill: "#237a76" }));
}

export const STATE_META = {
  taken: { label: "Given", icon: "check" },
  missed: { label: "Missed", icon: "alert" },
  skipped: { label: "Skipped", icon: "skip" },
  due: { label: "Due now", icon: "clock" },
  upcoming: { label: "Upcoming", icon: "clock" },
  untracked: { label: "Not tracked", icon: "info" },
};

export function stateChip(state) {
  const m = STATE_META[state] ?? STATE_META.upcoming;
  return h("span", { class: `chip ${state}` }, icon(m.icon), m.label);
}

export function urgencyChip(urgency) {
  const label = { critical: "Critical", soon: "Refill soon", ok: "Stocked" }[urgency];
  const ic = { critical: "alert", soon: "clock", ok: "check" }[urgency];
  return h("span", { class: `chip ${urgency}` }, icon(ic), label);
}

export function monogram(name, cls = "") {
  const initials = String(name ?? "?").replace(/^(Nurse|Dr\.?)\s+/i, "").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return h("span", { class: `monogram ${cls}`, "aria-hidden": "true" }, initials);
}

// ---------- formatting (always in the household timezone) ----------
let TZ = "UTC";
export function setTimezone(tz) { TZ = tz; }
export function tz() { return TZ; }

export function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
}
export function fmtDay(iso) {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
}
export function fmtDateLong(ymd) {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
export function fmtDateShort(ymd) {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
export function weekdayLetter(ymd) {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "narrow", timeZone: "UTC" });
}
export function localYmd(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return p;
}
export function localMinutes(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(date);
  const get = (t) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}
export function hhmmLabel(hhmm) {
  const [hr, mi] = hhmm.split(":").map(Number);
  return `${hr % 12 === 0 ? 12 : hr % 12}:${String(mi).padStart(2, "0")} ${hr < 12 ? "AM" : "PM"}`;
}
export function relTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400 && localYmd(new Date(iso)) === localYmd()) return fmtTime(iso);
  return fmtDay(iso);
}
export function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}
export function listJoin(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// ---------- toasts ----------
export function toast(message, kind = "info") {
  const host = document.getElementById("toasts");
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, icon(kind === "error" ? "alert" : "check", "sm"), message);
  host.append(t);
  setTimeout(() => t.remove(), kind === "error" ? 6000 : 3800);
}

// ---------- tooltip ----------
let tipEl;
export function showTip(target, title, body) {
  if (!tipEl) tipEl = document.getElementById("tooltip");
  tipEl.replaceChildren(h("b", {}, title), body ? h("span", {}, body) : null);
  const r = target.getBoundingClientRect();
  tipEl.style.left = `${Math.min(Math.max(r.left + r.width / 2, 140), window.innerWidth - 140)}px`;
  tipEl.style.top = `${r.top}px`;
  tipEl.classList.add("show");
}
export function hideTip() {
  tipEl?.classList.remove("show");
}
export function withTip(el, title, body) {
  el.addEventListener("mouseenter", () => showTip(el, title, body));
  el.addEventListener("mouseleave", hideTip);
  el.addEventListener("focus", () => showTip(el, title, body));
  el.addEventListener("blur", hideTip);
  return el;
}

// ---------- dialog ----------
/** Open a modal sheet. `build(close)` returns the body content. Resolves with the value passed to close(). */
export function openSheet(build) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "sheet" });
    let result;
    const close = (value) => {
      result = value;
      dlg.close();
    };
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(result);
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) close(undefined);
    });
    dlg.append(h("div", { class: "sheet-body" }, build(close)));
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function busy(button, fn) {
  return async (...args) => {
    if (button.disabled) return;
    const label = button.textContent;
    button.disabled = true;
    try {
      return await fn(...args);
    } finally {
      button.disabled = false;
      if (!button.isConnected) return;
      if (button.textContent !== label && !button.querySelector("svg")) button.textContent = label;
    }
  };
}
