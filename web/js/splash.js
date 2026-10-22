// Startup screen controller. The screen is static markup in index.html, so it
// paints before any JavaScript; this module decides when it leaves. It never
// outlasts real startup work except to finish the short first-entry
// introduction, and it never hides a failure behind animation.

/** Length of the first-entry introduction (the orb forming, the wordmark arriving). */
export const INTRO_MS = 1600;
/** After this long, say that startup is slow and offer a retry, while still trying. */
export const SLOW_MS = 6000;
/** After this long, treat startup as failed. */
export const TIMEOUT_MS = 20000;
/** Return visits only show the screen if startup is still running after this long (see styles.css). */
export const RETURN_REVEAL_MS = 350;

/**
 * How long to keep the screen up once Tend is ready.
 * First entry: only what remains of the introduction. Return visits and
 * reduced motion: nothing.
 */
export function exitDelay({ entry, reducedMotion, elapsedMs, introMs = INTRO_MS }) {
  if (entry !== "first" || reducedMotion) return 0;
  return Math.max(0, Math.round(introMs - elapsedMs));
}

/** How the screen should leave: a fade, or straight away if it was never visible or motion is reduced. */
export function exitStyle({ entry, reducedMotion, elapsedMs }) {
  if (reducedMotion) return "instant";
  if (entry === "return" && elapsedMs < RETURN_REVEAL_MS) return "instant";
  return "fade";
}

/** Startup phase at a given time, for status text. */
export function phase(elapsedMs) {
  if (elapsedMs >= TIMEOUT_MS) return "timeout";
  if (elapsedMs >= SLOW_MS) return "slow";
  return "loading";
}

export function createSplash(root, { entry = "first", reducedMotion = false, now = () => performance.now(), timers = globalThis } = {}) {
  const $ = (sel) => root?.querySelector(sel);
  const doc = root?.ownerDocument ?? globalThis.document;
  const orb = $(".orb");
  let state = root ? "loading" : "gone";
  let onTimeout = null;
  let skip = null;

  const setStatus = (text) => {
    const el = $("#splashStatus");
    if (el) el.textContent = text;
  };
  const slowTimer = timers.setTimeout(() => {
    if (state !== "loading") return;
    root.classList.add("slow");
    setStatus("Still connecting. This is taking longer than usual.");
  }, Math.max(0, SLOW_MS - now()));
  const timeoutTimer = timers.setTimeout(() => {
    if (state === "loading") onTimeout?.();
  }, Math.max(0, TIMEOUT_MS - now()));

  function clear() {
    timers.clearTimeout(slowTimer);
    timers.clearTimeout(timeoutTimer);
  }

  return {
    get state() { return state; },
    status: setStatus,
    /** Called if startup hasn't finished by TIMEOUT_MS. */
    onTimeout(fn) { onTimeout = fn; },
    /** Tend is ready: finish the introduction (if any), then leave. Resolves once the screen is gone. */
    ready() {
      if (state !== "loading") return Promise.resolve();
      state = "leaving";
      clear();
      root.classList.remove("slow");
      root.setAttribute("aria-busy", "false");
      setStatus("Ready");
      const elapsedMs = now();
      const wait = exitDelay({ entry, reducedMotion, elapsedMs });
      return new Promise((resolve) => {
        let t;
        const leave = () => {
          if (state !== "leaving") return resolve();
          root.removeEventListener("pointerdown", skip);
          doc.removeEventListener("keydown", skip);
          const style = exitStyle({ entry, reducedMotion, elapsedMs: now() });
          state = "gone";
          if (style === "instant") { root.remove(); resolve(); return; }
          root.classList.add("done");
          timers.setTimeout(() => { root.remove(); resolve(); }, 600);
        };
        // The introduction can be skipped once Tend is ready.
        skip = () => { timers.clearTimeout(t); leave(); };
        root.addEventListener("pointerdown", skip);
        doc.addEventListener("keydown", skip);
        t = timers.setTimeout(leave, wait);
      });
    },
    /** Startup failed: stop any introduction and say so, with a way to retry. */
    fail(message) {
      if (!root || state === "gone") return;
      state = "failed";
      clear();
      root.classList.remove("slow");
      root.classList.add("failed");
      root.setAttribute("aria-busy", "false");
      if (orb) {
        orb.dataset.state = "error";
        orb.setAttribute("aria-label", "Tend couldn't start");
      }
      const err = $("#splashError");
      if (err) err.textContent = message;
      $("#splashRetry")?.focus();
    },
  };
}
