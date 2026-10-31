// replay.js: CONTRACT v3.0 REPLAY half, shared by gemini-live.js and realtime.js.
// The plan's time_checks carry {kind:"replay", text:null, at_s, max_items?}. About PREFETCH_S before at_s the call asks
// replay-plan for his lines (opts.replayPlan(max_items) -> {items}); at at_s it waits up to LATE_WAIT_S more for the
// answer, then queues the note built here (the usual quiet-line wait still applies before it goes).
export const PREFETCH_S = 15;
export const LATE_WAIT_S = 6;
export const REPLAY_NONE = "[Producer note: replay time. Same topic. No list came through: pick three things he said and do your replay steps.]";

export const isReplay = (c) => !!c && c.kind === "replay";

// max_items from the check, else 5 full/work and 3 quick3 (CONTRACT v3.0).
export function replayMax(c, plan) {
  const n = Number(c && c.max_items);
  if (n > 0) return n;
  return (plan && plan.kind === "quick3") ? 3 : 5;
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim().replace(/"/g, "'");
export function cleanItems(items, max) {
  return (Array.isArray(items) ? items : []).filter(i => i && i.you_said && i.natural)
    .slice(0, max || 99).map(i => ({ you_said: clean(i.you_said), natural: clean(i.natural), phrase_id: i.phrase_id || null, why: i.why ? String(i.why) : "" }));
}

// Sent verbatim (CONTRACT v3.0): numbered items `He said: "…" Natural: "…"`, or the no-items text.
export function replayNote(items) {
  if (!items || !items.length) return REPLAY_NONE;
  const list = items.map((it, i) => `${i + 1}) He said: "${it.you_said}" Natural: "${it.natural}"`).join(" ");
  return `[Producer note: replay time. Same topic. Go through these one at a time as in your replay steps. ${list}]`;
}

// UI: has the coach's line got to this item yet? Share of the natural line's words that appear in the coach's text.
const words = (s) => String(s || "").toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter(Boolean);
export function overlap(coachText, natural) {
  const want = words(natural); if (!want.length) return 0;
  const have = new Set(words(coachText));
  return want.filter(w => have.has(w)).length / want.length;
}
export const mentions = (coachText, natural) => overlap(coachText, natural) >= 0.6;

// Per-call state machine. host = the call (elapsedMs, log, plan, o.replayPlan, o.store). Returns the check to queue, if any.
export class ReplayGate {
  constructor(host, opts) {
    this.h = host;
    this.items = opts.replayItems ? cleanItems(opts.replayItems) : null; // a resume after the note keeps the same list
    this.atMs = opts.replayAtMs ?? null;
    this.req = null;            // {done, items, failed}
  }
  fetch(c) {
    if (this.req) return;
    const max = replayMax(c, this.h.plan), t = this.h.elapsedMs();
    this.req = { done: false, items: [], failed: false, max };
    const fn = this.h.o.replayPlan;
    if (!fn) { this.req.done = true; this.req.failed = true; return; }
    this.h.log(`replay-plan asked at ${Math.round(t / 1000)}s (max ${max})`);
    Promise.resolve().then(() => fn(max)).then(r => {
      this.req.items = cleanItems(r && r.items, max); this.req.done = true;
      this.h.log(`replay-plan answered: ${this.req.items.length} items`);
    }).catch(e => { this.req.done = true; this.req.failed = true; this.h.log("replay-plan failed: " + (e && e.message || e)); });
  }
  // Called on every tick for a replay check not yet sent/queued. True = queue it now.
  ready(c, ms) {
    if (ms >= (c.at - PREFETCH_S) * 1000) this.fetch(c);
    if (ms < c.at * 1000) return false;
    if (this.req && !this.req.done && ms < (c.at + LATE_WAIT_S) * 1000) return false;
    this.items = this.req && this.req.done ? this.req.items : [];
    if (this.req && !this.req.done) this.h.log("replay-plan too slow: sending the no-list note");
    this.h.log(`replay note queued at ${Math.round(ms)}ms with ${this.items.length} items`);
    return true;
  }
  // At send time: the note text; stores items + replay_at_ms and tells the UI.
  text() {
    this.atMs = Math.round(this.h.elapsedMs());
    const items = this.items || [];
    this.h.o.store && this.h.o.store.patch({ replay_items: items, replay_at_ms: this.atMs });
    this.h.on.replay && this.h.on.replay(items);
    return replayNote(items);
  }
}
