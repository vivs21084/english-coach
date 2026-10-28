// app.js: router + screens for English Coach. Single page (hash routes) so iOS does not re-ask for the mic.
import { SUPABASE_URL, SUPABASE_ANON_KEY, FUNCTIONS_URL, DAILY_TARGET_DAYS, SPEECH_LANG, ALLOWED_EMAILS,
  MODELS, DEFAULT_MODEL, VOICES, MIC_CHECK_MS, MIC_SILENT_RMS, VOICE_ENGINES, DEFAULT_ENGINE, FREE_LIMIT_MSG } from "./config.js";
import { CoachCall, webrtcConnect, TokenExpiredError, NetworkError, fmt } from "./realtime.js";
import { GeminiCall, QuotaError } from "./gemini-live.js";
import * as store from "./session-store.js";
import { MOCK, MOCK_MIC, mockClock, mockConnect, mockMint, mockGrade, mockData, MockGeminiWS } from "./mock.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LS = { get: (k, d = null) => { try { return JSON.parse(localStorage.getItem("evc." + k)) ?? d; } catch (_) { return d; } },
             set: (k, v) => localStorage.setItem("evc." + k, JSON.stringify(v)) };
const TZ = "Australia/Sydney";
const dayIso = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = (iso) => (new Date(iso + "T12:00:00Z").getUTCDay() + 6) % 7; // Mon=0
const mondayOf = (iso) => addDays(iso, -weekday(iso));

// ---------------------------------------------------------------------------------------------
// Data layer: Supabase in real mode, fake rows in ?mock=1
// ---------------------------------------------------------------------------------------------
let sb = null, user = null;
const PROFILE_COLS = ["display_name", "coach_name", "voice", "model", "session_minutes", "nudge_time", "trigger_note", "voice_engine", "about_me_public"];
const V03_COLS = ["voice_engine", "about_me_public"]; // CONTRACT v2.0 (migration 0004)
// v0.3: a 429 from mint-session (or the Gemini socket) that is the FREE voice quota, not our own daily cap.
const isFreeQuota = (e) => e instanceof QuotaError || (e && e.status === 429 && (/gemini|free|quota/i.test(String((e.body && e.body.cap) || "")) ||
  /quota|resource.?exhausted|free voice/i.test(String(e.message || ""))));
const api = {
  async init() {
    if (MOCK) { user = mockData.user; return; }
    try {
      const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
      sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      const { data: { session } } = await sb.auth.getSession();
      user = session ? session.user : null;
      sb.auth.onAuthStateChange((_e, s) => { const was = !!user; user = s ? s.user : null; if (was !== !!user) route(); });
    } catch (e) { console.warn("Supabase did not load", e); }
  },
  async token() {
    if (MOCK) return "mock";
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw Object.assign(new Error("Signed out"), { status: 401 });
    return session.access_token;
  },
  async post(fn, body) {
    if (!MOCK && !navigator.onLine) throw new NetworkError("You're offline");
    let r;
    try {
      r = await fetch(`${FUNCTIONS_URL}/${fn}`, { method: "POST",
        headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + await api.token() },
        body: JSON.stringify(body || {}) });
    } catch (e) { throw new NetworkError("Could not reach the server"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || j.message || `${fn} failed (${r.status})`), { status: r.status, body: j });
    return j;
  },
  // New session: {kind:"full"|"quick3"}. The server may still answer with plan.kind "work" (1 session in 5).
  // Resume: {resume_session_id} only; the server keeps the original kind.
  mint(resumeId, kind = "full") {
    const body = resumeId ? { resume_session_id: resumeId } : { kind };
    if (MOCK) window.__mock.mintBodies.push(body);
    return MOCK ? mockMint(resumeId, kind) : api.post("mint-session", body);
  },
  async todayPlan() {
    if (MOCK) return mockData.todayPlan();
    const { data, error } = await sb.from("v_today_plan").select("local_date,scenario_title,scenario_goal,kind,produce_count")
      .order("local_date", { ascending: false }).limit(1);
    if (error) throw error; return (data || [])[0] || null;
  },
  async phraseCounts() {
    if (MOCK) return mockData.phraseCounts();
    const { data, error } = await sb.from("v_phrase_status_counts").select("used_count,automatic_count,learning_count").limit(1);
    if (error) throw error; return (data || [])[0] || null;
  },
  async scoreLedger() {
    if (MOCK) return mockData.scoreLedger();
    const { data, error } = await sb.from("score_ledger").select("scored_at,score_total").order("scored_at", { ascending: true }).limit(52);
    if (error) throw error; return data || [];
  },
  async getProfile() {
    if (MOCK) return mockData.getProfile();
    const { data, error } = await sb.from("profiles").select(PROFILE_COLS.join(",")).eq("user_id", user.id).maybeSingle();
    if (error) { // voice_engine (v0.3) or trigger_note (0002) may not exist yet: read without them
      let r = await sb.from("profiles").select(PROFILE_COLS.filter(c => !V03_COLS.includes(c)).join(",")).eq("user_id", user.id).maybeSingle();
      if (r.error) r = await sb.from("profiles").select(PROFILE_COLS.filter(c => c !== "trigger_note" && !V03_COLS.includes(c)).join(",")).eq("user_id", user.id).maybeSingle();
      if (r.error) throw r.error; return r.data || {};
    }
    return data || {};
  },
  // All 7 columns are update-granted (model + trigger_note since migration 0003).
  async saveProfile(patch) {
    if (MOCK) return mockData.saveProfile(patch);
    const { error } = await sb.from("profiles").update(patch).eq("user_id", user.id);
    if (error && /voice_engine|about_me_public/.test(error.message || "")) { // 0004 not applied yet: save the rest
      const rest = Object.fromEntries(Object.entries(patch).filter(([k]) => !V03_COLS.includes(k)));
      const r = await sb.from("profiles").update(rest).eq("user_id", user.id);
      return { error: r.error, skipped: V03_COLS };
    }
    return { error };
  },
  grade(payload) { return MOCK ? mockGrade(payload) : api.post("grade-session", payload); },
  async dailyLog(fromIso) {
    if (MOCK) return mockData.dailyLog(fromIso);
    const { data, error } = await sb.from("daily_log").select("date,practised,real_person,source").gte("date", fromIso);
    if (error) throw error; return data || [];
  },
  async weekBoard() {
    if (MOCK) return mockData.weekBoard();
    const { data, error } = await sb.from("v_week_board").select("*");
    if (error) throw error; return data || [];
  },
  async reviews() {
    if (MOCK) return mockData.reviews();
    let { data, error } = await sb.from("session_reviews").select("*").order("created_at", { ascending: false }).limit(150);
    if (error) ({ data, error } = await sb.from("session_reviews").select("*").limit(150));
    if (error) throw error; return data || [];
  },
  async insertPhraseEvent(row) {
    if (MOCK) return mockData.insertPhraseEvent(row);
    return sb.from("phrase_events").insert(row);
  },
  async markRealPerson(date) {
    if (MOCK) return mockData.markRealPerson(date);
    return sb.from("daily_log").upsert({ user_id: user.id, date, real_person: true, source: "app" }, { onConflict: "user_id,date" });
  },
};

// Phrase bank (cached by the service worker for the offline Phrases tab)
let bank = null, bankById = new Map();
async function loadBank() {
  if (bank) return bank;
  try { bank = await (await fetch("phrases.json")).json(); } catch (_) { bank = []; }
  bank = bank.filter(p => !p.duplicate_of);
  for (const p of bank) bankById.set(p.id, p);
  return bank;
}
const phraseText = (id, fallback) => (bankById.get(id) || {}).text || fallback || id;

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------
const SCREENS = ["signin", "home", "session", "review", "phrases", "stats", "settings"];
function show(name) {
  for (const s of SCREENS) $("scr-" + s).hidden = s !== name;
  $("tabs").hidden = name === "session" || name === "signin";
  for (const a of document.querySelectorAll(".tabs a")) a.classList.toggle("on", a.dataset.tab === name);
  window.scrollTo(0, 0);
}
async function route() {
  const name = (location.hash.replace(/^#\/?/, "") || "home").split("?")[0];
  if (!user && !MOCK) return show("signin");
  if (call && !call.closed && name !== "session") { location.hash = "#/session"; return; } // never leave a live call
  if (name === "session") return show("session");
  if (name === "review") { show("review"); return renderReview(currentReviewId || (await store.lastGraded() || {}).session_id); }
  if (name === "phrases") { show("phrases"); return renderPhrases(); }
  if (name === "stats") { show("stats"); return renderStats(); }
  if (name === "settings") { show("settings"); return renderSettings(); }
  show("home"); return renderHome();
}
window.addEventListener("hashchange", route);

// ---------------------------------------------------------------------------------------------
// Sign in (Google, or a 6-digit email code that works inside the home-screen app)
// ---------------------------------------------------------------------------------------------
function wireSignin() {
  const msg = (t) => { $("signinMsg").textContent = t; };
  $("btnGoogle").onclick = async () => {
    if (!sb) return msg("Could not load sign-in. Check your connection.");
    const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
    if (error) msg("Error: " + error.message);
  };
  $("btnSendCode").onclick = async () => {
    const email = $("inEmail").value.trim().toLowerCase();
    if (!email) return msg("Type your email first.");
    if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email)) return msg("This email is not on the list for this app.");
    if (!sb) return msg("Could not load sign-in. Check your connection.");
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
    if (error) return msg("Error: " + error.message);
    $("codeBox").hidden = false; msg("Check your email for the code and type it here.");
  };
  $("btnVerify").onclick = async () => {
    const email = $("inEmail").value.trim().toLowerCase(), token = $("inCode").value.trim();
    const { error } = await sb.auth.verifyOtp({ email, token, type: "email" });
    msg(error ? "That code did not work: " + error.message : "Signed in.");
  };
}

// ---------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------
export function computeStreak(practisedSet, today) {
  // Counts practised days back from today. One missed day is forgiven; two missed days in a row end it.
  // Today not done yet does not break anything.
  let d = practisedSet.has(today) ? today : addDays(today, -1), count = 0, misses = 0, forgiven = 0;
  for (let i = 0; i < 800; i++) {
    if (practisedSet.has(d)) { count++; if (misses) forgiven++; misses = 0; }
    else { misses++; if (misses >= 2) break; }
    d = addDays(d, -1);
  }
  return { count, forgiven, doneToday: practisedSet.has(today), yesterdayMissed: !practisedSet.has(addDays(today, -1)) };
}

async function renderHome() {
  $("whoami").textContent = user ? user.email : "";
  $("mockBadge").hidden = !MOCK;
  // Install hint: iOS Safari only, not already standalone, shown once.
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  if (isIOS && !standalone && !LS.get("installHintShown")) { $("installHint").hidden = false; LS.set("installHintShown", true); }
  $("btnInstallOk").onclick = () => { $("installHint").hidden = true; };

  // Today's scenario: v_today_plan first (known before Start), else the last plan this phone saw.
  let tp = null;
  try { tp = await api.todayPlan(); } catch (_) { tp = null; }
  const plan = LS.get("lastPlan");
  if (tp && tp.scenario_title) {
    $("scTitle").textContent = tp.scenario_title; $("scGoal").textContent = tp.scenario_goal ? "Goal: " + tp.scenario_goal : "";
    const meta = [tp.kind === "work" ? "Work chat" : "", tp.produce_count ? `${tp.produce_count} phrases to try` : ""].filter(Boolean);
    $("scMeta").textContent = meta.join(" · ");
    document.body.dataset.planSrc = "today";
  } else if (plan && plan.scenario) {
    $("scTitle").textContent = plan.scenario.title; $("scGoal").textContent = "Goal: " + (plan.scenario.goal || ""); $("scMeta").textContent = "";
    document.body.dataset.planSrc = "last";
  } else document.body.dataset.planSrc = "none";

  const res = await store.findResumable().catch(() => null);
  $("resumeCard").hidden = !res;
  if (res) {
    $("resumeAt").textContent = fmt(res.elapsed_ms || 0);
    $("btnResume").onclick = () => startSession(res);
    $("btnResumeFinish").onclick = () => finishAndGrade(res.session_id);
  }
  gradePending();
  // v0.3: small "free" / "paid" label for the voice engine (profile first, else what the last mint said).
  api.getProfile().then(pr => pr.voice_engine || LS.get("voiceEngine") || DEFAULT_ENGINE).catch(() => LS.get("voiceEngine") || DEFAULT_ENGINE)
    .then(e => { const v = VOICE_ENGINES.find(x => x.id === e) || VOICE_ENGINES[0]; $("engineTag").textContent = v.tag; $("engineTag").dataset.engine = v.id; });

  const today = dayIso();
  try {
    const rows = await api.dailyLog(addDays(today, -400));
    const set = new Set(rows.filter(r => r.practised).map(r => r.date));
    const s = computeStreak(set, today);
    $("streakNum").textContent = s.count;
    $("streakNote").textContent = s.doneToday ? "Done for today. Nice one." :
      s.yesterdayMissed && s.count ? "You missed yesterday. Practise today to keep the streak." : (s.count ? "Practise today to keep it going." : "Start one today.");
    const mon = mondayOf(today), names = ["M", "T", "W", "T", "F", "S", "S"];
    $("weekDots").innerHTML = names.map((n, i) => {
      const d = addDays(mon, i), cls = [set.has(d) ? "done" : "", d === today ? "today" : "", d < today && !set.has(d) ? "missed" : ""].join(" ");
      return `<div class="dot ${cls}" title="${d}"><i></i>${n}</div>`;
    }).join("");
    const realToday = rows.some(r => r.date === today && r.real_person);
    if (realToday) LS.set("realPerson", today);
  } catch (e) { $("streakNote").textContent = "Could not load your days (" + (e.message || e) + ")."; }
  try {
    const board = await api.weekBoard();
    const yours = board.filter(isYours).length;
    $("weekLine").textContent = board.length ? `This week: ${yours} of ${board.length} phrases are yours` : "This week's phrases arrive with your first session.";
  } catch (e) { $("weekLine").textContent = "This week: could not load the board."; }
}
const YOURS = new Set(["used", "automatic", "maintained"]);
const isYours = (r) => r.is_yours === true || YOURS.has(String(r.status || "").toLowerCase());

async function gradePending() {
  const list = await store.findUngraded().catch(() => []);
  if (!list.length) { $("pendingCard").hidden = true; return; }
  $("pendingCard").hidden = false;
  $("pendingText").textContent = `${list.length} session${list.length > 1 ? "s" : ""} saved but not reviewed yet.`;
  $("btnRetryGrade").onclick = async () => {
    for (const s of list) { await store.patchSession(s.session_id, { status: "ended" }); try { await store.gradeSession(s.session_id, api.grade); } catch (_) {} }
    renderHome();
  };
  if (navigator.onLine) for (const s of list) {
    if (s.status === "grading") continue;
    if (s.status === "dropped" || s.status === "live") await store.patchSession(s.session_id, { status: "ended" });
    store.gradeSession(s.session_id, api.grade).then(() => gradePending()).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------
let call = null, mic = null, actx = null, wakeLock = null, meterRaf = 0, currentReviewId = null, lastResumeRec = null, lastKind = "full";
const STATE_TEXT = { connecting: "Connecting…", listening: "Your turn", you: "Listening…", thinking: "Thinking…",
  speaking: "Coach is talking", closing: "Wrapping up", ended: "Done", dropped: "Call dropped" };

function setOrb(state) {
  $("orb").className = "orb " + state;
  $("stateLabel").textContent = STATE_TEXT[state] || state;
  $("stateSub").textContent = state === "listening" ? "Just talk. Take your time." : "";
  document.body.dataset.callState = state;
}

function showErr(title, text, opts = {}) {
  $("errBox").hidden = false; $("errTitle").textContent = title; $("errText").textContent = text || "";
  $("btnErrResume").hidden = !opts.resume; $("btnErrRetry").hidden = !opts.retry; $("btnErrFinish").hidden = !opts.finish;
  document.body.dataset.err = opts.code || "error";
  $("btnEnd").hidden = true;
}
function clearErr() { $("errBox").hidden = true; delete document.body.dataset.err; $("btnEnd").hidden = false; }

async function requestWakeLock() {
  try { if ("wakeLock" in navigator && document.visibilityState === "visible") { wakeLock = await navigator.wakeLock.request("screen"); } }
  catch (e) { console.warn("wake lock", e.message); }
}
async function resumeAudio() {
  if (actx && actx.state !== "running") {
    try { await actx.resume(); } catch (e) { try { await actx.suspend(); await actx.resume(); } catch (_) {} }
  }
  const a = $("remoteAudio"); if (a.srcObject) a.play().catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && call && !call.closed) { requestWakeLock(); resumeAudio(); }
});

function startMeter() {
  if (!actx || !mic) return;
  const src = actx.createMediaStreamSource(mic), an = actx.createAnalyser(); an.fftSize = 512; src.connect(an);
  const buf = new Uint8Array(an.fftSize);
  const loop = () => {
    an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128));
    if (document.body.dataset.callState === "you") $("orb").style.setProperty("--lvl", (1 + Math.min(m / 128, 1) * 0.25).toFixed(3));
    else $("orb").style.removeProperty("--lvl");
    meterRaf = requestAnimationFrame(loop);
  };
  loop();
}

function releaseDevices() {
  cancelAnimationFrame(meterRaf);
  if (mic) { for (const t of mic.getTracks()) t.stop(); mic = null; }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  if (actx) { actx.close().catch(() => {}); actx = null; }
  const a = $("remoteAudio"); a.srcObject = null;
}

// 1-second level check on the mic track before any network call. Returns {ok, rms}.
// If the AudioContext is not running (iOS can hold it suspended) the level cannot be read: pass rather than false-alarm.
async function micLevelCheck(stream) {
  if (!actx || actx.state !== "running" || !stream) return { ok: true, rms: null };
  const src = actx.createMediaStreamSource(stream), an = actx.createAnalyser(); an.fftSize = 2048; src.connect(an);
  const buf = new Float32Array(an.fftSize); let peak = 0; const t0 = performance.now();
  while (performance.now() - t0 < MIC_CHECK_MS) {
    an.getFloatTimeDomainData(buf); let sum = 0; for (const v of buf) sum += v * v;
    peak = Math.max(peak, Math.sqrt(sum / buf.length));
    if (peak > MIC_SILENT_RMS) break;
    await new Promise(r => setTimeout(r, 50));
  }
  try { src.disconnect(); } catch (_) {}
  window.__micRms = peak; LS.set("micRms", { rms: Number(peak.toFixed(5)), at: new Date().toISOString() });
  return { ok: peak > MIC_SILENT_RMS, rms: peak };
}

// Called ONLY from a tap (Start / Quick 3 / Resume / Try again): that tap is the user gesture iOS needs for mic + audio.
async function startSession(resumeRec = null, kind = "full") {
  lastResumeRec = resumeRec; lastKind = kind;
  location.hash = "#/session"; show("session"); clearErr(); setOrb("connecting");
  $("elapsed").textContent = fmt(resumeRec ? resumeRec.elapsed_ms || 0 : 0);
  $("capCoach").textContent = ""; $("capYou").textContent = "";
  const audioEl = $("remoteAudio");
  audioEl.muted = false; audioEl.play().catch(() => {}); // unlock playback inside the gesture

  // 1. Mic, from this tap only.
  if (!MOCK || MOCK_MIC) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      const denied = e.name === "NotAllowedError" || e.name === "SecurityError";
      return showErr(denied ? "The microphone is blocked" : "No microphone", denied
        ? "Allow the mic for this app: iPhone Settings → Safari → Microphone (or Settings → English Coach), then tap Try again."
        : (e.message || e.name), { retry: true, code: denied ? "mic_denied" : "mic_error" });
    }
  }
  try { actx = new (window.AudioContext || window.webkitAudioContext)(); await actx.resume(); } catch (_) {}
  if (mic) {
    $("stateLabel").textContent = "Checking your mic…";
    const lv = await micLevelCheck(mic);
    if (!lv.ok) {
      releaseDevices();
      return showErr("I can't hear you", "Check the mic switch (or the mute on your AirPods or headset), then tap Try again.", { retry: true, code: "mic_silent" });
    }
  }
  startMeter();
  await requestWakeLock();
  if (!MOCK && !navigator.onLine) { releaseDevices(); return showErr("No internet", "Connect to Wi-Fi or mobile data, then tap Try again.", { retry: true, code: "offline" }); }

  // 2. Mint (or re-mint for a resume) and connect. One automatic retry on an expired token.
  let mint, attempt = 0;
  for (;;) {
    try {
      mint = await api.mint(resumeRec && resumeRec.session_id, kind);
      if (mint.plan) LS.set("lastPlan", { ...mint.plan, day: dayIso() });
      await runCall(mint, resumeRec);
      return;
    } catch (e) {
      if (call) { call.cleanup(); call = null; }
      if (e instanceof TokenExpiredError && attempt++ < 1) continue;
      releaseDevices();
      if (isFreeQuota(e)) return showErr("Free voice limit", FREE_LIMIT_MSG, { code: "free_quota" });
      if (e instanceof TokenExpiredError) return showErr("The session key expired", "Tap Try again for a fresh one.", { retry: true, code: "token_expired" });
      if (e instanceof NetworkError) return showErr("No connection", e.message + ". Check your internet and tap Try again.", { retry: true, code: "offline" });
      if (e.status === 401) return showErr("Signed out", "Sign in again, then start.", { code: "signed_out" });
      if (e.status === 403) return showErr("Not on the list", "This account is not allowed to use the coach.", { code: "forbidden" });
      if (e.status === 429) return showErr("That's enough for today", "Two sessions a day is the limit. Come back tomorrow.", { code: "daily_cap" });
      return showErr("Could not start", e.message || String(e), { retry: true, code: "start_failed" });
    }
  }
}

async function runCall(mint, resumeRec) {
  const sid = mint.session_id;
  const sameSession = resumeRec && resumeRec.session_id === sid;
  if (resumeRec && !sameSession) await store.patchSession(resumeRec.session_id, { status: "ended" }); // backend gave a new id: grade the old part separately
  const prev = sameSession ? await store.getSession(sid) : null;
  const rec = prev || { session_id: sid, plan: mint.plan, model: mint.model, started_at: Date.now(), elapsed_ms: 0, next_idx: 0, sent_checks: [] };
  // A resume mint may come back without time_checks/hard_stop_s: keep the stored plan's, the mint's wins otherwise.
  rec.status = "live"; rec.plan = mint.plan ? { ...(prev && prev.plan || {}), ...mint.plan } : rec.plan;
  // Session kind: the server's word wins (mint.kind or plan.kind: full | quick3 | work), else what was asked for.
  rec.kind = mint.kind || (mint.plan && mint.plan.kind) || rec.kind || lastKind;
  document.body.dataset.kind = rec.kind;
  const walk = workWalk(rec.kind === "work", (rec.plan && (rec.plan.walkthrough && rec.plan.walkthrough.prompt)) || "");
  await store.putSession(rec);
  const resumeTurns = sameSession ? (await store.getTurns(sid)).map(t => ({ role: t.role, text: t.text })) : [];

  // Debounced session patches (elapsed, next_idx, sent_checks) so a crash keeps the clock.
  let patchBuf = {}, patchT = 0;
  const patch = (p) => { Object.assign(patchBuf, p); clearTimeout(patchT); patchT = setTimeout(() => { const b = patchBuf; patchBuf = {}; store.patchSession(sid, b).catch(() => {}); }, 300); };

  // v0.3: the server picks the engine (profiles.voice_engine); a mint with a Gemini token/ws_url and no engine is Gemini too.
  const engine = mint.engine || (mint.ws_url || mint.token ? "gemini" : "openai");
  rec.engine = engine; LS.set("voiceEngine", engine); document.body.dataset.engine = engine;
  await store.patchSession(sid, { engine });
  const Call = engine === "gemini" ? GeminiCall : CoachCall;
  call = new Call({
    mint: { ...mint, plan: rec.plan }, connect: MOCK ? mockConnect : webrtcConnect, micStream: mic, audioEl: $("remoteAudio"),
    audioCtx: actx, WebSocketImpl: MOCK ? MockGeminiWS : undefined,
    resumeHandle: sameSession && rec.engine === "gemini" ? rec.gemini_handle || null : null,
    remint: async () => { const m = await api.mint(sid); if (m.session_id && m.session_id !== sid) (window.__callLog = window.__callLog || []).push("remint gave a new session_id " + m.session_id + ": kept " + sid); return m; },
    clock: MOCK ? mockClock : undefined,
    startElapsedMs: sameSession ? rec.elapsed_ms || 0 : 0,
    nextIdx: sameSession ? rec.next_idx || 0 : 0,
    sentChecks: sameSession ? rec.sent_checks || [] : [],
    touchedIds: sameSession ? (await store.getEvents(sid)).map(e => e.phrase_id) : [],
    switchSuffix: sameSession ? rec.switch_suffix ?? null : null,
    noteEchoCuts: sameSession ? rec.note_echo_cuts || 0 : 0,
    resumeTurns,
    store: { saveTurn: (t) => store.saveTurn(sid, t), saveEvent: (e) => store.saveEvent(sid, e), patch },
    on: {
      state: (st) => { setOrb(st); walk.state(st); },
      elapsed: (ms) => { window.__elapsedMs = ms; $("elapsed").textContent = fmt(ms); if (ms % 5000 < 300) patch({ elapsed_ms: ms }); },
      tally: (n, m) => { $("tally").textContent = `${n} of ${m}`; },
      caption: (role, text) => { $(role === "user" ? "capYou" : "capCoach").textContent = text; walk.caption(role, text); },
      log: (m) => { (window.__callLog = window.__callLog || []).push(m); },
      ended: async (reason, ms) => {
        clearTimeout(patchT); await store.patchSession(sid, { ...patchBuf, elapsed_ms: ms, status: "ended", end_reason: reason, ended_at: Date.now() });
        walk.off(); releaseDevices(); call = null; finishAndGrade(sid);
      },
      dropped: async (reason, ms) => {
        clearTimeout(patchT); await store.patchSession(sid, { ...patchBuf, elapsed_ms: ms, status: "dropped", drop_reason: reason });
        walk.off(); releaseDevices(); call = null;
        const r = await store.getSession(sid);
        if (/free voice limit/i.test(reason)) {
          showErr("Free voice limit", FREE_LIMIT_MSG + " Everything you said is saved.", { finish: true, code: "free_quota" });
          $("btnErrFinish").onclick = () => finishAndGrade(sid);
          return;
        }
        showErr("The call dropped", `${reason.charAt(0).toUpperCase() + reason.slice(1)}. Everything you said is saved. Resume within 10 minutes to carry on.`, { resume: true, finish: true, code: "dropped" });
        $("btnErrResume").onclick = () => startSession(r);
        $("btnErrFinish").onclick = () => finishAndGrade(sid);
      },
    },
  });
  await call.start();
}

// Work session: the 2-minute "walk me through X" monologue. Calm indicator, no clock, no score.
// On when the coach says "walk me through"; off when the coach speaks again after he has talked.
function workWalk(isWork, topic) {
  let on = false, heard = false;
  const set = (v) => { on = v; $("walkBox").hidden = !v; $("elapsed").style.visibility = v ? "hidden" : ""; document.body.dataset.walk = v ? "on" : "off"; };
  set(false);
  if (!isWork) return { state() {}, caption() {}, off() {} };
  return {
    caption(role, text) {
      if (role !== "user" && !on && /walk (me|us) through/i.test(text || "")) {
        const m = /walk (?:me|us) through ([^.?!]+)/i.exec(text);
        $("walkTopic").textContent = topic || (m ? m[1].trim() : "");
        heard = false; set(true);
      }
    },
    state(st) { if (!on) return; if (st === "you") heard = true; else if (st === "speaking" && heard) set(false); },
    off() { set(false); },
  };
}

function wireSession() {
  $("tglCaptions").checked = !!LS.get("captions", false);
  $("captions").hidden = !$("tglCaptions").checked;
  $("tglCaptions").onchange = () => { LS.set("captions", $("tglCaptions").checked); $("captions").hidden = !$("tglCaptions").checked; };
  let armed = 0;
  $("btnEnd").onclick = () => {
    if (!call) { location.hash = "#/home"; return; }
    if (Date.now() - armed < 3000) { call.hangUp("user"); armed = 0; $("btnEnd").textContent = "End"; $("btnEnd").classList.remove("confirm"); return; }
    armed = Date.now(); call.endTapped = true; // v2.1: a user_ended from the coach is honoured after he tapped End
    $("btnEnd").textContent = "Tap again to end"; $("btnEnd").classList.add("confirm");
    setTimeout(() => { if (Date.now() - armed >= 3000) { $("btnEnd").textContent = "End"; $("btnEnd").classList.remove("confirm"); } }, 3100);
  };
  $("btnErrRetry").onclick = () => startSession(lastResumeRec, lastKind);
  $("btnErrHome").onclick = () => { clearErr(); location.hash = "#/home"; };
  $("btnStart").onclick = async () => {
    const res = await store.findResumable().catch(() => null);
    startSession(res || null, "full"); // a recent dropped call is resumed rather than starting a second session
  };
  $("btnQuick3").onclick = async () => {
    const res = await store.findResumable().catch(() => null);
    startSession(res || null, "quick3");
  };
}

// ---------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------
async function finishAndGrade(sid) {
  currentReviewId = sid;
  location.hash = "#/review";
  show("review");
  $("gradingBox").hidden = false; $("reviewBody").hidden = true; $("gradeFail").hidden = true;
  try { await store.gradeSession(sid, api.grade); }
  catch (e) { /* shown by renderReview */ }
  renderReview(sid);
}

async function renderReview(sid) {
  await loadBank();
  const rec = sid ? await store.getSession(sid) : null;
  if (!rec) { $("gradingBox").hidden = true; $("reviewBody").hidden = true; $("gradeFail").hidden = false; $("gradeFailText").textContent = "No session yet."; $("btnRegrade").hidden = true; return; }
  if (rec.status === "grading") { $("gradingBox").hidden = false; return; }
  $("gradingBox").hidden = true;
  if (rec.status !== "graded" || !rec.review) {
    $("gradeFail").hidden = false; $("btnRegrade").hidden = false;
    $("gradeFailText").textContent = (rec.grade_error || "Not graded yet.") + " Your turns are saved on this phone.";
    $("btnRegrade").onclick = () => finishAndGrade(sid);
    return;
  }
  $("gradeFail").hidden = true; $("reviewBody").hidden = false;
  const rv = rec.review, plan = rec.plan || {};
  const planText = new Map([...(plan.produce || []), ...(plan.hear || [])].map(p => [p.phrase_id, p.text]));
  const txt = (id) => planText.get(id) || phraseText(id);
  $("rvSummary").textContent = rv.summary || "";
  $("rvNailed").innerHTML = (rv.nailed || []).length ? rv.nailed.map(id => `<li>${esc(txt(id))}</li>`).join("") : `<li class="small">None this time. They'll come back soon.</li>`;
  // v0.2 card: ONE headline (his sentence re-said better), up to 2 corrections folded under "more",
  // carry_pattern as "Tomorrow: …", and the hook line. Fields may sit inside review or at the top of the grade result.
  // The /50 work score is never shown here (Stats only).
  const pick = (k) => rv[k] ?? rec[k] ?? null;
  const fixHtml = (f) => `<span class="fixSaid">${esc(f.said)}</span><br><span class="fixBetter">${esc(f.better)}</span>${f.why ? `<br><span class="small">${esc(f.why)}</span>` : ""}`;
  const corr = (rv.corrections || []).filter(c => c && c.better);
  const head = pick("headline") && pick("headline").better ? pick("headline") : corr[0] || null;
  const more = corr.filter(c => c !== head && !(head && c.said === head.said && c.better === head.better)).slice(0, 2);
  $("rvHeadCard").hidden = !head;
  $("rvHead").innerHTML = head ? fixHtml(head) : "";
  $("rvMore").hidden = !more.length; $("rvMore").open = false;
  $("rvMoreList").innerHTML = more.map(c => `<li>${fixHtml(c)}</li>`).join("");
  const carry = pick("carry_pattern"), hook = pick("hook");
  $("rvCarryCard").hidden = !carry; $("rvCarry").textContent = carry ? "Tomorrow: " + carry : "";
  $("rvHook").hidden = !hook; $("rvHook").textContent = hook || "";
  $("rvTip").textContent = rv.tip || "";
  const parts = [];
  if (rv.wpm) parts.push(`${Math.round(rv.wpm)} words a minute`);
  if (rv.talk_ratio != null) parts.push(`you talked ${Math.round(rv.talk_ratio * 100)}% of the time`);
  if (rv.longest_turn_s) parts.push(`longest turn ${Math.round(rv.longest_turn_s)}s`);
  $("rvFluency").textContent = parts.join(" · ") || "No fluency numbers this time.";

  const today = dayIso(), rp = $("btnRealPerson");
  rp.hidden = LS.get("showRealPerson", true) === false; // Settings: real-person tap on/off
  const setRp = () => { const done = LS.get("realPerson") === today; rp.disabled = done; rp.textContent = done ? "Real person today: ticked ✓" : "I said one to a real person today"; };
  setRp();
  rp.onclick = async () => {
    rp.disabled = true;
    const { error } = await api.markRealPerson(today) || {};
    if (error) { rp.disabled = false; rp.textContent = "Could not save. Tap again."; return; }
    LS.set("realPerson", today); setRp();
  };

  const evs = rec.phrase_events || [], overrides = rec.overrides || {};
  $("rvEvents").innerHTML = evs.length ? evs.map((ev, i) => `
    <li data-i="${i}"><div><b>${esc(txt(ev.phrase_id))}</b> <span class="st st-${ev.correct ? "used" : "tried"}">${esc(ev.kind)}${ev.correct === false ? ", not quite" : ""}</span></div>
      ${ev.quote ? `<div class="q">“${esc(ev.quote)}”</div>` : ""}
      <div class="btns"><button class="secondary ${overrides[i] === "agree" ? "on" : ""}" data-v="agree">Agree</button>
      <button class="secondary ${overrides[i] === "disagree" ? "on" : ""}" data-v="disagree">Disagree</button></div></li>`).join("")
    : `<li class="small">Nothing to check.</li>`;
  for (const btn of $("rvEvents").querySelectorAll("button")) btn.onclick = async () => {
    const li = btn.closest("li"), i = Number(li.dataset.i), ev = evs[i], v = btn.dataset.v;
    // The user's word is final: written as a phrase_events row with source 'user'.
    const row = { session_id: sid, phrase_id: ev.phrase_id, kind: ev.kind, correct: v === "agree" ? ev.correct : !ev.correct,
                  source: "user", quote: ev.quote || "", note: v };
    for (const b of li.querySelectorAll("button")) b.disabled = true;
    const { error } = await api.insertPhraseEvent(row) || {};
    for (const b of li.querySelectorAll("button")) { b.disabled = false; b.classList.toggle("on", !error && b.dataset.v === v); }
    if (!error) { overrides[i] = v; await store.patchSession(sid, { overrides }); } else btn.textContent = "Retry";
  };
  $("btnReviewHome").onclick = () => { location.hash = "#/home"; };
}

// ---------------------------------------------------------------------------------------------
// Phrases
// ---------------------------------------------------------------------------------------------
let voices = [];
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\[[^\]]*\]/g, "")); u.lang = SPEECH_LANG; u.rate = 0.95;
  voices = voices.length ? voices : speechSynthesis.getVoices();
  const v = voices.find(v => v.lang === SPEECH_LANG) || voices.find(v => v.lang && v.lang.startsWith("en-GB")) || voices.find(v => v.lang && v.lang.startsWith("en"));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => { voices = speechSynthesis.getVoices(); };

const STATUS_LABEL = { new: "new", seen: "heard", tried: "tried", used: "yours", automatic: "automatic", maintained: "yours" };
const li = (id, text, note, status) => `<li data-say="${esc(text)}" data-id="${esc(id)}"><div><div class="t">${esc(text)}</div>${note ? `<div class="n">${esc(note)}</div>` : ""}</div>${status ? `<span class="st st-${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>` : ""}</li>`;

async function renderPhrases() {
  await loadBank();
  const seg = LS.get("phrSeg", "week");
  $("segWeek").classList.toggle("on", seg === "week"); $("segAll").classList.toggle("on", seg === "all");
  $("phWeek").hidden = seg !== "week"; $("phAll").hidden = seg !== "all";
  $("segWeek").onclick = () => { LS.set("phrSeg", "week"); renderPhrases(); };
  $("segAll").onclick = () => { LS.set("phrSeg", "all"); renderPhrases(); };
  if (seg === "week") {
    try {
      const board = await api.weekBoard();
      const order = { automatic: 0, maintained: 0, used: 1, tried: 2, seen: 3, new: 4 };
      board.sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5));
      $("weekBoard").innerHTML = board.map(r => li(r.phrase_id, r.text || phraseText(r.phrase_id), (bankById.get(r.phrase_id) || {}).note, String(r.status || "new").toLowerCase())).join("")
        || `<li class="small">No phrases planned yet this week.</li>`;
    } catch (e) { $("weekBoard").innerHTML = `<li class="small">Offline: the week board needs a connection. "All phrases" works offline.</li>`; }
  } else {
    const run = () => {
      const q = $("inSearch").value.trim().toLowerCase();
      const hits = q ? bank.filter(p => (p.text + " " + (p.variants || []).join(" ") + " " + (p.note || "") + " " + (p.part || "")).toLowerCase().includes(q)) : bank;
      $("searchCount").textContent = `${hits.length} of ${bank.length}`;
      $("bankList").innerHTML = hits.slice(0, 120).map(p => li(p.id, p.text, p.note || p.part, null)).join("");
    };
    $("inSearch").oninput = run; run();
  }
}
document.addEventListener("click", (e) => { const t = e.target.closest("[data-say]"); if (t) speak(t.dataset.say); });

// ---------------------------------------------------------------------------------------------
// Stats (few numbers, simple SVG)
// ---------------------------------------------------------------------------------------------
function bars(values, labels, { target = null, max = null, fmtV = (v) => v } = {}) {
  const W = 320, H = 140, pad = 18, n = values.length, top = Math.max(max ?? 0, ...values, target ?? 0, 1);
  const bw = (W - pad) / n;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  values.forEach((v, i) => {
    const h = (v / top) * (H - 34), x = pad + i * bw + 3, y = H - 18 - h;
    const col = target != null ? (v >= target ? "var(--good)" : "var(--accent)") : "var(--accent)";
    s += `<rect x="${x}" y="${y}" width="${bw - 6}" height="${Math.max(h, 1)}" rx="3" fill="${col}"/>`;
    if (v) s += `<text x="${x + (bw - 6) / 2}" y="${y - 3}" text-anchor="middle">${fmtV(v)}</text>`;
    s += `<text x="${x + (bw - 6) / 2}" y="${H - 4}" text-anchor="middle">${labels[i]}</text>`;
  });
  if (target != null) { const y = H - 18 - (target / top) * (H - 34); s += `<line x1="${pad}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--warn)" stroke-dasharray="4 3"/><text x="2" y="${y + 3}">${target}</text>`; }
  return s + "</svg>";
}

// Trend line for the weekly /50 score (score_ledger). Dots + line, dashed goal line.
function trend(values, labels, { min = 10, max = 50, target = null } = {}) {
  const W = 320, H = 140, padL = 22, padR = 10, n = values.length;
  const x = (i) => padL + (n === 1 ? (W - padL - padR) / 2 : i * (W - padL - padR) / (n - 1));
  const y = (v) => H - 18 - ((v - min) / (max - min)) * (H - 34);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  if (target != null) s += `<line x1="${padL}" x2="${W}" y1="${y(target)}" y2="${y(target)}" stroke="var(--warn)" stroke-dasharray="4 3"/><text x="2" y="${y(target) + 3}">${target}</text>`;
  if (n > 1) s += `<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}"/>`;
  values.forEach((v, i) => {
    s += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${target != null && v >= target ? "var(--good)" : "var(--accent)"}"/>`;
    s += `<text x="${x(i)}" y="${y(v) - 7}" text-anchor="middle">${v}</text><text x="${x(i)}" y="${H - 4}" text-anchor="middle">${labels[i]}</text>`;
  });
  return s + "</svg>";
}

async function renderStats() {
  const today = dayIso(), mon = mondayOf(today);
  const weeks = Array.from({ length: 10 }, (_, i) => addDays(mon, -7 * (9 - i)));
  const labels = weeks.map(w => w.slice(8, 10) + "/" + w.slice(5, 7));
  const weekIdx = (iso) => weeks.findIndex(w => iso >= w && iso < addDays(w, 7));
  try {
    const rows = await api.dailyLog(weeks[0]);
    const days = weeks.map(() => 0); for (const r of rows) if (r.practised) { const i = weekIdx(r.date); if (i >= 0) days[i]++; }
    $("chDays").innerHTML = bars(days, labels, { target: DAILY_TARGET_DAYS, max: 7 });
  } catch (e) { $("chDays").textContent = "Could not load."; }
  try {
    const rv = await api.reviews();
    const nailed = weeks.map(() => new Set()), wpm = weeks.map(() => []);
    for (const r of rv) {
      const d = r.created_at ? dayIso(new Date(r.created_at)) : null; if (!d) continue;
      const i = weekIdx(d); if (i < 0) continue;
      for (const id of r.nailed || []) nailed[i].add(id);
      if (r.wpm) wpm[i].push(Number(r.wpm));
    }
    $("chYours").innerHTML = bars(nailed.map(s => s.size), labels);
    $("chWpm").innerHTML = bars(wpm.map(a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0), labels);
  } catch (e) { $("chYours").textContent = "Could not load."; $("chWpm").textContent = ""; }
  try {
    const c = await api.phraseCounts();
    const yours = c ? Number(c.used_count || 0) + Number(c.automatic_count || 0) : 0;
    $("yoursNum").textContent = String(yours);
    $("yoursSub").textContent = c ? `used or automatic · ${Number(c.automatic_count || 0)} automatic · ${Number(c.learning_count || 0)} still learning` : "none yet: they arrive with your sessions";
  } catch (e) { $("yoursNum").textContent = "–"; $("yoursSub").textContent = "Could not load."; }
  try {
    const sl = (await api.scoreLedger()).filter(r => r.score_total != null).slice(-10);
    $("scoreCard").hidden = !sl.length;
    if (sl.length) $("chScore").innerHTML = trend(sl.map(r => Number(r.score_total)), sl.map(r => { const d = dayIso(new Date(r.scored_at)); return d.slice(8, 10) + "/" + d.slice(5, 7); }), { target: 42 });
  } catch (e) { $("scoreCard").hidden = true; }
  $("btnSignOut").hidden = MOCK;
  $("btnSignOut").onclick = async () => { if (sb) await sb.auth.signOut(); location.hash = "#/home"; };
}

// ---------------------------------------------------------------------------------------------
// Settings (profiles row; the real-person tap preference lives on this phone only)
// ---------------------------------------------------------------------------------------------
async function renderSettings() {
  const msg = (t) => { $("setMsg").textContent = t; };
  $("setVoice").innerHTML = VOICES.map(v => `<option value="${v}">${v}${v === "marin" || v === "cedar" ? " (recommended)" : ""}</option>`).join("");
  let pr = {};
  try { pr = await api.getProfile(); msg(""); } catch (e) { msg("Could not load your settings (" + (e.message || e) + ")."); }
  $("setName").value = pr.display_name || "";
  $("setCoach").value = pr.coach_name || "Jo";
  $("setVoice").value = VOICES.includes(pr.voice) ? pr.voice : "marin";
  const model = MODELS.some(m => m.id === pr.model) ? pr.model : DEFAULT_MODEL;
  for (const r of document.querySelectorAll("input[name=setModel]")) r.checked = r.value === model;
  const eng = VOICE_ENGINES.some(v => v.id === pr.voice_engine) ? pr.voice_engine : DEFAULT_ENGINE;
  for (const r of document.querySelectorAll("input[name=setEngine]")) r.checked = r.value === eng;
  $("setAboutPublic").value = pr.about_me_public || "";
  $("setMinutes").value = pr.session_minutes || 10;
  $("setTrigger").value = pr.trigger_note || "";
  $("setNudge").value = String(pr.nudge_time || "07:30").slice(0, 5);
  $("setRealTap").checked = LS.get("showRealPerson", true) !== false;
  $("setForm").onsubmit = async (e) => {
    e.preventDefault();
    const mins = Math.min(15, Math.max(3, Math.round(Number($("setMinutes").value) || 10)));
    const patch = {
      display_name: $("setName").value.trim() || null,
      coach_name: $("setCoach").value.trim() || "Jo",
      voice: $("setVoice").value,
      model: (document.querySelector("input[name=setModel]:checked") || {}).value || DEFAULT_MODEL,
      session_minutes: mins,
      nudge_time: $("setNudge").value || "07:30",
      trigger_note: $("setTrigger").value.trim(),
      voice_engine: (document.querySelector("input[name=setEngine]:checked") || {}).value || DEFAULT_ENGINE,
      about_me_public: $("setAboutPublic").value.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join("\n"),
    };
    LS.set("voiceEngine", patch.voice_engine);
    LS.set("showRealPerson", $("setRealTap").checked);
    $("btnSaveSettings").disabled = true; msg("Saving…");
    let r;
    try { r = await api.saveProfile(patch) || {}; } catch (err) { r = { error: err }; }
    $("btnSaveSettings").disabled = false;
    if (r.error) return msg("Could not save: " + (r.error.message || r.error) + ". Tap Save again.");
    msg("Saved. The next session uses these.");
  };
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
async function boot() {
  wireSignin(); wireSession();
  if ("serviceWorker" in navigator && !new URLSearchParams(location.search).has("nosw")) navigator.serviceWorker.register("sw.js").catch(() => {});
  await api.init();
  loadBank();
  // A page reload while a call was "live" means the tab died mid-call: mark it dropped so Home offers Resume.
  for (const s of await store.allSessions().catch(() => [])) if (s.status === "live") await store.patchSession(s.session_id, { status: "dropped", drop_reason: "app was closed" }, false); // keep last_activity: the 10-min window counts from the last turn
  route();
}
boot();
