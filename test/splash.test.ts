// Startup screen behaviour (web/js/splash.js), run against a fake DOM and a
// fake clock: it leaves when Tend is ready, plays the introduction only on a
// first entry, reports slow starts, and never hides a failure.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

interface SplashApi {
  readonly state: string;
  status(text: string): void;
  onTimeout(fn: () => void): void;
  ready(): Promise<void>;
  fail(message: string): void;
}
interface SplashModule {
  INTRO_MS: number;
  SLOW_MS: number;
  TIMEOUT_MS: number;
  exitDelay(o: { entry: string; reducedMotion: boolean; elapsedMs: number }): number;
  exitStyle(o: { entry: string; reducedMotion: boolean; elapsedMs: number }): string;
  phase(elapsedMs: number): string;
  createSplash(root: unknown, opts: Record<string, unknown>): SplashApi;
}
const mod: SplashModule = await import(new URL("../web/js/splash.js", import.meta.url).href);

/** Timers driven by hand: advance() runs everything due, in order. */
function fakeTime() {
  let t = 0;
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn: () => void, ms: number) => { const id = ++seq; queue.set(id, { at: t + ms, fn }); return id; },
      clearTimeout: (id: number) => { queue.delete(id); },
    },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...queue].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        queue.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await Promise.resolve();
      }
      t = end;
    },
  };
}

function fakeRoot() {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const nodes = new Map<string, { textContent: string; dataset: Record<string, string>; focused?: boolean; setAttribute(k: string, v: string): void; focus(): void }>();
  const node = () => ({ textContent: "", dataset: {} as Record<string, string>, focused: false, setAttribute() {}, focus() { this.focused = true; } });
  for (const sel of ["#splashStatus", "#splashError", "#splashRetry", ".orb"]) nodes.set(sel, node());
  const listeners = new Map<string, () => void>();
  const root = {
    removed: false,
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    querySelector: (sel: string) => nodes.get(sel) ?? null,
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    remove() { this.removed = true; },
    ownerDocument: { addEventListener() {}, removeEventListener() {} },
  };
  return { root, classes, attrs, nodes, listeners };
}

describe("startup screen timing rules", () => {
  test("first entry finishes only what remains of the introduction; return visits and reduced motion don't wait", () => {
    assert.equal(mod.exitDelay({ entry: "first", reducedMotion: false, elapsedMs: 300 }), mod.INTRO_MS - 300);
    assert.equal(mod.exitDelay({ entry: "first", reducedMotion: false, elapsedMs: mod.INTRO_MS + 500 }), 0, "slow startup adds no extra delay");
    assert.equal(mod.exitDelay({ entry: "return", reducedMotion: false, elapsedMs: 50 }), 0);
    assert.equal(mod.exitDelay({ entry: "first", reducedMotion: true, elapsedMs: 50 }), 0);
    assert.equal(mod.exitStyle({ entry: "return", reducedMotion: false, elapsedMs: 120 }), "instant", "a return visit that loads fast never shows the screen");
    assert.equal(mod.exitStyle({ entry: "return", reducedMotion: false, elapsedMs: 900 }), "fade");
    assert.equal(mod.exitStyle({ entry: "first", reducedMotion: true, elapsedMs: 900 }), "instant");
    assert.equal(mod.phase(1000), "loading");
    assert.equal(mod.phase(mod.SLOW_MS), "slow");
    assert.equal(mod.phase(mod.TIMEOUT_MS), "timeout");
  });
});

describe("startup screen controller", () => {
  test("first entry: stays for the introduction, then fades out and is removed", async () => {
    const time = fakeTime();
    const { root, classes, attrs } = fakeRoot();
    const s = mod.createSplash(root, { entry: "first", now: time.now, timers: time.timers });
    await time.advance(200);
    let gone = false;
    void s.ready().then(() => { gone = true; });
    assert.equal(attrs.get("aria-busy"), "false");
    await time.advance(mod.INTRO_MS - 200 - 1);
    assert.equal(classes.has("done"), false, "still introducing");
    await time.advance(1);
    assert.equal(classes.has("done"), true, "fading out");
    await time.advance(600);
    assert.equal(root.removed, true);
    assert.equal(gone, true);
  });

  test("the introduction can be skipped once Tend is ready", async () => {
    const time = fakeTime();
    const { root, listeners } = fakeRoot();
    const s = mod.createSplash(root, { entry: "first", now: time.now, timers: time.timers });
    void s.ready();
    listeners.get("pointerdown")!();
    await time.advance(600);
    assert.equal(root.removed, true);
  });

  test("return visit that is ready quickly removes the screen at once", async () => {
    const time = fakeTime();
    const { root } = fakeRoot();
    const s = mod.createSplash(root, { entry: "return", now: time.now, timers: time.timers });
    await time.advance(80);
    const done = s.ready();
    await time.advance(0);
    await done;
    assert.equal(root.removed, true);
  });

  test("a slow start says so and offers a retry, while still loading", async () => {
    const time = fakeTime();
    const { root, classes, nodes } = fakeRoot();
    mod.createSplash(root, { entry: "first", now: time.now, timers: time.timers });
    await time.advance(mod.SLOW_MS);
    assert.equal(classes.has("slow"), true);
    assert.match(nodes.get("#splashStatus")!.textContent, /taking longer than usual/);
    assert.equal(root.removed, false);
  });

  test("a start that never finishes times out instead of animating forever", async () => {
    const time = fakeTime();
    const { root } = fakeRoot();
    const s = mod.createSplash(root, { entry: "first", now: time.now, timers: time.timers });
    let timedOut = false;
    s.onTimeout(() => { timedOut = true; s.fail("Tend didn't respond."); });
    await time.advance(mod.TIMEOUT_MS);
    assert.equal(timedOut, true);
    assert.equal(s.state, "failed");
  });

  test("failure stops the introduction, shows the message, focuses retry and is never dismissed by ready()", async () => {
    const time = fakeTime();
    const { root, classes, nodes, attrs } = fakeRoot();
    const s = mod.createSplash(root, { entry: "first", now: time.now, timers: time.timers });
    s.fail("Tend couldn't load the care record: offline");
    assert.equal(classes.has("failed"), true);
    assert.equal(attrs.get("aria-busy"), "false");
    assert.equal(nodes.get(".orb")!.dataset.state, "error");
    assert.equal(nodes.get("#splashError")!.textContent, "Tend couldn't load the care record: offline");
    assert.equal(nodes.get("#splashRetry")!.focused, true);
    await s.ready();
    await time.advance(mod.TIMEOUT_MS);
    assert.equal(root.removed, false, "the failure stays on screen");
  });
});
