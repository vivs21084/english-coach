// session-store.js: every turn and live event goes to IndexedDB the moment it arrives,
// so a dropped call, a killed tab or a locked phone loses nothing.
// Stores:
//   sessions  key session_id  {session_id, plan, model, started_at, last_activity, elapsed_ms, status, review, phrase_events, grade_error}
//             status: live | dropped | ended | grading | graded | grade_failed
//   turns     key [session_id, idx]  {session_id, idx, role, text, t_start_ms, t_end_ms, item_id}
//   events    autoIncrement           {session_id, phrase_id, kind, quote, t_ms}

import { RESUME_WINDOW_MS } from "./config.js";

const DB_NAME = "english-coach";
const DB_VERSION = 1;
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("sessions")) d.createObjectStore("sessions", { keyPath: "session_id" });
      if (!d.objectStoreNames.contains("turns")) {
        const t = d.createObjectStore("turns", { keyPath: ["session_id", "idx"] });
        t.createIndex("by_session", "session_id");
      }
      if (!d.objectStoreNames.contains("events")) {
        const e = d.createObjectStore("events", { autoIncrement: true });
        e.createIndex("by_session", "session_id");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // Ask the browser not to evict our data (home-screen apps are exempt from the 7-day cap anyway).
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}
  return dbp;
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function getSession(id) {
  return tx("sessions", "readonly", s => reqP(s.get(id)));
}

export async function putSession(rec, touch = true) {
  if (touch || !rec.last_activity) rec.last_activity = Date.now();
  return tx("sessions", "readwrite", s => reqP(s.put(rec)));
}

// Read-modify-write inside ONE readwrite transaction. (Was get + put in two transactions: a turn saved at the
// same moment as the hang-up could write back a stale copy and wipe end_reason / sent_checks. Found 26 Oct 2026
// by the Quick 3 resume test, about 1 run in 7.) IndexedDB serialises readwrite transactions on a store.
export async function patchSession(id, patch, touch = true) {
  return tx("sessions", "readwrite", s => new Promise((res, rej) => {
    const g = s.get(id);
    g.onerror = () => rej(g.error);
    g.onsuccess = () => {
      const cur = g.result || { session_id: id };
      Object.assign(cur, patch);
      if (touch || !cur.last_activity) cur.last_activity = Date.now();
      const p = s.put(cur); p.onsuccess = () => res(p.result); p.onerror = () => rej(p.error);
    };
  }));
}

export async function saveTurn(session_id, turn) {
  // turn = {idx, role, text, t_start_ms, t_end_ms, item_id}
  await tx("turns", "readwrite", s => reqP(s.put({ session_id, ...turn })));
  await patchSession(session_id, {}); // bumps last_activity
}

export async function saveEvent(session_id, ev) {
  await tx("events", "readwrite", s => reqP(s.add({ session_id, ...ev })));
}

export async function getTurns(session_id) {
  const rows = await tx("turns", "readonly", s => reqP(s.index("by_session").getAll(session_id)));
  return (rows || []).filter(r => r.text && r.text.trim()).sort((a, b) => a.idx - b.idx);
}

export async function getEvents(session_id) {
  return (await tx("events", "readonly", s => reqP(s.index("by_session").getAll(session_id)))) || [];
}

export async function allSessions() {
  const rows = await tx("sessions", "readonly", s => reqP(s.getAll()));
  return (rows || []).sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
}

// A session that dropped (or was left "live" by a killed tab) less than 10 minutes ago can be resumed
// with the same session_id and plan.
const LIVE_STALE_MS = 30000;
export async function findResumable() {
  const now = Date.now();
  for (const s of await allSessions()) {
    // 31 Oct: a "live" session counts only when stale (no activity for 30 s = the page died mid-call). A fresh "live"
    // one is the call in progress; treating it as resumable opened a SECOND voice session on top of the first.
    const age = now - (s.last_activity || 0);
    if (s.status === "dropped" && age < RESUME_WINDOW_MS) return s;
    if (s.status === "live" && age > LIVE_STALE_MS && age < RESUME_WINDOW_MS) return s;
  }
  return null;
}

// Sessions that ended (or dropped and timed out) but were never graded: graded on the next app open.
export async function findUngraded() {
  const now = Date.now();
  return (await allSessions()).filter(s =>
    s.status === "ended" || s.status === "grade_failed" || s.status === "grading" ||
    ((s.status === "dropped" || s.status === "live") && now - (s.last_activity || 0) >= RESUME_WINDOW_MS));
}

// Build the grade-session payload from what is on disk (never from memory).
export async function buildGradePayload(session_id) {
  const turns = (await getTurns(session_id)).map((t, i) => ({
    idx: i, role: t.role, text: t.text.trim(), t_start_ms: Math.round(t.t_start_ms || 0), t_end_ms: Math.round(t.t_end_ms || 0),
  }));
  const live_events = (await getEvents(session_id)).map(e => ({
    phrase_id: e.phrase_id, kind: e.kind, quote: e.quote || "", t_ms: Math.round(e.t_ms || 0),
  }));
  // CONTRACT v3.0: the REPLAY list and when its note went, so the grader can tell echoes from cued uses.
  const rec = await getSession(session_id);
  const extra = rec && rec.replay_at_ms != null ? { replay_items: rec.replay_items || [], replay_at_ms: Math.round(rec.replay_at_ms) } : {};
  return { session_id, turns, live_events, ...extra };
}

// POST to grade-session. postFn(payload) -> {review, phrase_events}. Result is stored with the session.
export async function gradeSession(session_id, postFn) {
  await patchSession(session_id, { status: "grading" });
  try {
    const payload = await buildGradePayload(session_id);
    const res = await postFn(payload);
    await patchSession(session_id, { status: "graded", review: res.review || null, phrase_events: res.phrase_events || [], grade_error: null,
      headline: res.headline ?? null, carry_pattern: res.carry_pattern ?? null, hook: res.hook ?? null }); // v0.2 fields, if sent top-level
    return res;
  } catch (err) {
    await patchSession(session_id, { status: "grade_failed", grade_error: String(err && err.message || err) });
    throw err;
  }
}

export async function lastGraded() {
  return (await allSessions()).find(s => s.status === "graded") || null;
}
