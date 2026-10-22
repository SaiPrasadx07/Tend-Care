// App shell: header, router, caregiver switcher, live sync and the Alexa+ rail.
import { state, subscribe, loadConfig, refresh, setActor, actor, canWrite, resetDemo } from "./api.js";
import { h, icon, brandMark, monogram, setTimezone, toast } from "./ui.js";
import { renderToday, slotKey } from "./views/today.js";
import { renderPeople } from "./views/people.js";
import { renderSupply } from "./views/supply.js";
import { renderHandoff } from "./views/handoff.js";
import { renderDeveloper } from "./views/developer.js";
import { mountAssistant, renderSuggestions, newSession, updateEngine, focusInput, setAvailability, mirrorOrb } from "./assistant.js";
import { createOrb } from "./orb.js";
import { createSplash } from "./splash.js";

const ROUTES = {
  today: { label: "Today", icon: "home", render: renderToday },
  people: { label: "People", icon: "users", render: renderPeople },
  supply: { label: "Supply", icon: "box", render: renderSupply },
  handoff: { label: "Handoff", icon: "doc", render: renderHandoff },
  developer: { label: "Developer", icon: "code", render: renderDeveloper },
};
const CARE_ROUTES = ["today", "people", "supply", "handoff"];

const $ = (id) => document.getElementById(id);
const content = $("content");
const layout = $("layout");
const rail = $("rail");
const railToggle = $("railToggle");
const compact = matchMedia("(max-width: 1180px)");

function route() {
  const r = location.hash.replace(/^#\/?/, "").split("?")[0];
  return ROUTES[r] ? r : "today";
}

// ---------- header ----------
let actorMenu;
function renderHeader() {
  const cfg = state.config;
  const live = cfg.engine === "bedrock";
  const me = actor();
  actorMenu = h("div", { class: "menu", role: "menu", hidden: true },
    h("p", { class: "eyebrow menu-label" }, "Acting as"),
    cfg.caregivers.map((c) => h("button", {
      role: "menuitemradio", "aria-checked": String(c.id === state.actorId), type: "button",
      onclick: () => { closeMenu(); if (c.id !== state.actorId) switchActor(c.id); },
    }, monogram(c.name, "xs"), h("span", {}, c.name, h("span", { class: "tiny muted" }, c.role === "viewer" ? " · view only" : " · caregiver")), c.id === state.actorId ? h("span", { class: "check" }, icon("check", "sm")) : null)),
    canWrite() ? [h("hr", { class: "hr", style: "margin:6px 0" }), h("button", {
      role: "menuitem", type: "button", onclick: async () => {
        closeMenu();
        try { await resetDemo(); newSession(); await refresh("reset"); toast("Demo data reset"); } catch (err) { toast(err.message, "error"); }
      },
    }, icon("refresh", "sm"), "Reset demo data")] : null);
  const btn = h("button", { class: "actor-btn", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", onclick: (e) => { e.stopPropagation(); toggleMenu(); } },
    monogram(me?.name), h("span", { class: "actor-meta" }, h("b", {}, me?.name), h("span", {}, me?.role === "viewer" ? "View only" : "Caregiver")), icon("down", "sm"));
  const current = route();
  $("header").replaceChildren(
    h("a", { class: "brand", href: "#/today", "aria-label": "Tend home" }, brandMark(), h("span", { class: "brand-name" }, "Tend"), h("span", { class: "brand-sub" }, "Care circle", h("br"), "for Alexa+")),
    h("nav", { class: "main-nav", "aria-label": "Main" }, CARE_ROUTES.map((r) => h("a", { href: `#/${r}`, "aria-current": current === r ? "page" : null }, ROUTES[r].label))),
    h("div", { class: "header-right" },
      h("span", {
        class: `engine-pill ${live ? "live" : ""}`,
        title: live ? `Alexa+ reasoning runs on Amazon Bedrock (${cfg.model}).` : "No AWS credentials configured: the Alexa+ simulator uses a local intent router. Every action still goes through Tend's MCP tools.",
      }, h("span", { class: "dot" }), h("span", { class: "label" }, live ? `Amazon Bedrock · ${cfg.model.replace(/^us\.|-v\d.*$/g, "")}` : "Offline router (no LLM)")),
      h("a", { class: "dev-link", href: "#/developer", "aria-current": current === "developer" ? "page" : null }, icon("code", "sm"), h("span", { class: "label" }, "Developer")),
      h("div", { class: "actor-switch" }, btn, actorMenu)));
  $("bottomNav").replaceChildren(...CARE_ROUTES.map((r) => h("a", { href: `#/${r}`, "aria-current": current === r ? "page" : null }, icon(ROUTES[r].icon), ROUTES[r].label)));
}
function toggleMenu() {
  const open = actorMenu.hidden;
  actorMenu.hidden = !open;
  actorMenu.previousSibling.setAttribute("aria-expanded", String(open));
}
function closeMenu() {
  if (actorMenu && !actorMenu.hidden) toggleMenu();
}
document.addEventListener("click", (e) => { if (actorMenu && !actorMenu.contains(e.target)) closeMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); if (compact.matches) closeRail(); } });

async function switchActor(id) {
  newSession();
  await setActor(id);
  renderHeader();
  updateEngine();
  toast(`Now acting as ${actor().name}${actor().role === "viewer" ? " (view only)" : ""}`);
}

// ---------- rail ----------
function openRail() {
  if (compact.matches) rail.classList.add("open");
  else { layout.classList.remove("no-rail"); rail.hidden = false; }
  try { localStorage.setItem("tend.rail", "open"); } catch { /* ignore */ }
  setTimeout(focusInput, 50);
}
function closeRail() {
  if (compact.matches) rail.classList.remove("open");
  else { layout.classList.add("no-rail"); rail.hidden = true; }
  if (!compact.matches) try { localStorage.setItem("tend.rail", "closed"); } catch { /* ignore */ }
}
const toggleOrb = createOrb(38);
railToggle.append(toggleOrb.el, h("span", { class: "label" }, "Ask Alexa+"));
railToggle.setAttribute("aria-label", "Open Alexa+");
railToggle.addEventListener("click", openRail);

// ---------- rendering ----------
function render(reason) {
  const r = route();
  if (r === "developer" && ["poll", "assistant", "action", "card", "handoff"].includes(reason)) return; // don't reset the workspace under the user
  if (!state.data) {
    content.replaceChildren(state.error
      ? h("div", { class: "card" }, h("h2", { class: "section-title" }, "Couldn't load the care circle"), h("p", { class: "muted" }, state.error), h("button", { class: "btn btn-primary", onclick: () => refresh() }, "Try again"))
      : h("p", { class: "muted" }, "Loading the care circle…"));
    return;
  }
  const view = ROUTES[r].render();
  if (reason === "route" || reason === "init") view.classList.add("enter");
  const banner = !canWrite() && r !== "developer"
    ? h("div", { class: "viewonly-banner", role: "note" }, icon("info", "sm"), `${actor().name} has view-only access. You can see everything; only caregivers can log doses, add notes or request refills.`)
    : null;
  content.replaceChildren(...[banner, view].filter(Boolean));
}

function diffSnapshots() {
  const prev = state.previous;
  const cur = state.data;
  state.changed = new Set();
  state.newActivity = new Set();
  if (!prev || !cur) return [];
  const before = new Map(prev.status.people.flatMap((p) => p.slots.map((s) => [slotKey(s), s.state + (s.loggedBy ?? "")])));
  for (const p of cur.status.people) for (const s of p.slots) if (before.has(slotKey(s)) && before.get(slotKey(s)) !== s.state + (s.loggedBy ?? "")) state.changed.add(slotKey(s));
  const seen = new Set(prev.activity.map((a) => a.at + a.message));
  const fresh = cur.activity.filter((a) => !seen.has(a.at + a.message));
  for (const a of fresh) state.newActivity.add(a.at + a.message);
  return fresh;
}

subscribe((reason) => {
  if (reason === "loading") return;
  setAvailability(!state.error);
  let fresh = [];
  if (["poll", "assistant", "card", "action"].includes(reason)) fresh = diffSnapshots();
  else { state.changed = new Set(); state.newActivity = new Set(); }
  // Live sync: tell the user when someone else in the care circle changed something.
  if (reason === "poll") for (const a of fresh.filter((x) => x.actor !== actor()?.name).slice(0, 2)) toast(a.message);
  if (reason === "assistant" && fresh[0]) toast(`Dashboard updated: ${fresh[0].message}`);
  render(reason);
  renderSuggestions();
});

window.addEventListener("hashchange", () => {
  renderHeader();
  render("route");
  window.scrollTo({ top: 0 });
  if (compact.matches) closeRail();
});

// Live sync with the rest of the care circle (other caregivers, other devices).
setInterval(() => {
  if (document.visibilityState === "visible" && !state.loading && state.data && !document.querySelector("dialog[open]")) refresh("poll");
}, 20_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.data) refresh("poll"); });

// ---------- startup: the splash leaves when Tend is genuinely ready ----------
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const splash = createSplash($("splash"), { entry: document.documentElement.dataset.entry ?? "first", reducedMotion: reduceMotion });
$("splashRetry")?.addEventListener("click", () => location.reload());

function startupFailed(message) {
  splash.fail(message);
  content.replaceChildren(h("div", { class: "card state-card" }, h("h2", { class: "section-title" }, "Tend couldn't start"), h("p", { class: "muted" }, message), h("button", { class: "btn btn-primary", onclick: () => location.reload() }, "Try again")));
}
splash.onTimeout(() => startupFailed("Tend didn't respond within 20 seconds. Check that the server is running, then try again."));

async function init() {
  splash.status("Connecting to your care record");
  const cfg = await loadConfig();
  setTimezone(cfg.timezone);
  let saved = null;
  try { saved = localStorage.getItem("tend.actor"); } catch { /* ignore */ }
  state.actorId = cfg.caregivers.some((c) => c.id === saved) ? saved : cfg.caregivers[0]?.id;
  renderHeader();
  mountAssistant(rail, { onClose: closeRail });
  mirrorOrb(toggleOrb);
  let railPref = null;
  try { railPref = localStorage.getItem("tend.rail"); } catch { /* ignore */ }
  if (!compact.matches && railPref === "closed") closeRail();
  splash.status("Loading today's doses, supply and notes");
  await refresh("init");
  if (splash.state === "failed") return;
  if (state.error) {
    startupFailed(`Tend couldn't load the care record: ${state.error}`);
    return;
  }
  try { sessionStorage.setItem("tend.entered", "1"); } catch { /* ignore */ }
  await splash.ready();
  if (!reduceMotion) {
    document.body.classList.add("entering");
    setTimeout(() => document.body.classList.remove("entering"), 900);
  }
}

init().catch((err) => startupFailed(`Tend couldn't start: ${err.message}. Check that the server is running.`));
