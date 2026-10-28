// mock.js: ?mock=1 runs the app with no OpenAI and no Supabase.
//   - a fake data channel replays a scripted coaching call (OpenAI Realtime event shapes)
//   - mint/grade come from eval/mock-mint.json and eval/mock-grade.json
//   - Home/Phrases/Stats read fake rows
// URL options: speed=N (time runs N x faster, default 1), drop=S (simulate a dropped call at S seconds),
//              nohangup=1 (coach never calls end_session, so the 11:00 hard stop fires), mic=1 (really open the mic),
//              work=1 (the server answers with a work session: plan.kind "work" + a "walk me through" monologue),
//              noplan=1 (v_today_plan is empty, Home falls back to the last plan),
//              allset=1 (the coach logs a phrase_event for every produce phrase early, so the switch note has no suffix),
//              echo=1 (the coach reads producer notes aloud: "Sure thing. [Producer note: wrap up now.] How was swimming?" and a
//                      line starting "Producer note: …"), earlyend=1 (the coach calls end_session right after the close note,
//                      which must be refused, then again in its final reply, refused too),
//              mute=1 (the coach never replies after the final note: the client's 40 s timeout must end the call),
//              noteecho=1 (the coach's first reply after the switch note streams "Producer note acknowledged.": the client
//                      must send response.cancel + output_audio_buffer.clear, then one response.create).
//              gemini=1 (v0.3: the mint says engine "gemini" and a fake Gemini Live WebSocket replays the same script in Gemini
//                      message shapes: setupComplete, toolCall/toolResponse, modelTurn inlineData PCM 24 kHz, input/output
//                      transcription, turnComplete, sessionResumptionUpdate, ONE interrupted (3rd coach turn) and ONE goAway
//                      at goaway=S seconds, default 300). As PROVEN in CONTRACT v2.0 the fake refuses a reused token (close 1011
//                      "Token has been used too many times") and a non-Constrained URL (close 1008), so every reconnect must re-mint.
//                      quota=1 (mint-session answers 429 {cap:"free_tier"}: the free-limit message must show),
//                      userended=1 (the coach calls end_session user_ended with no leaving phrase: must be refused, call goes on),
//                      userended=2 (he says "Sorry mate, I have to go now." and the coach calls end_session user_ended: honoured),
//                      think=1 (the 2nd coach turn thinks aloud "Thinking Process: …": muted, never graded), think=2 (same with "/thought"),
//                      (v2.2: userended=1's end_session carries quote "Talk later", the coach's own words: still refused)
//                      remintfail=1 (the reconnect mint fails with 500: the client ends and grades, end_reason "dropped").
// v0.4 sign-in: the app signs in anonymously on load (window.__mock.anonSignIns counts the calls; user id window.__mock.userId).
//              approved=0 (v_my_access.allowlisted false: Home shows the waiting card with the device code, Start disabled,
//                      and mint-session answers 403 "no profile: email not in public.allowlist"); default approved.
//              anonfail=1 (signInAnonymously fails: Home shows the one-line Retry). Set window.__mock.approved = true to approve.
// nohangup=1 now mints a plan with no final note (old plan), so only the hard stop can end the call.
// The coach says goodbye + calls end_session only once the client has sent the "final" producer note.
// Everything the client sends is recorded in window.__mock for tests.

const q = new URLSearchParams(location.search);
export const MOCK = q.get("mock") === "1";
export const SPEED = Math.max(1, Number(q.get("speed") || 1));
const DROP_AT = q.get("drop") ? Number(q.get("drop")) : null;
const NO_HANGUP = q.get("nohangup") === "1";
export const MOCK_MIC = q.get("mic") === "1";

export const mockClock = { now: () => performance.now() * SPEED };
const wait = (mockMs) => new Promise(r => setTimeout(r, mockMs / SPEED));

const WORK = q.get("work") === "1";
const NO_PLAN = q.get("noplan") === "1";
const EARLY_END = q.get("earlyend") === "1";
const MUTE = q.get("mute") === "1";
const NOTE_ECHO = q.get("noteecho") === "1";
let MINT_KIND = "full";
const M = (window.__mock = { sent: [], emitted: [], calls: {}, answered: {}, connects: 0, log: [], mintBodies: [], profileSaves: [], sentMs: [],
  anonSignIns: 0, userId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", approved: q.get("approved") !== "0", deviceLabelSaves: [], linkEmails: [], accessReads: 0 });

// Script: coach line, then learner line, with tool calls attached.
// tools: [{name, args}] are emitted at the start of the coach turn that follows the learner's use.
const SCRIPT = [
  { coach: "Hey Vivek, how ya going? Good weekend?", tools: [{ name: "phrase_event", args: { phrase_id: "bcf570d33e4b", kind: "heard", quote: "how ya going" } }] },
  { user: "Yeah good, you? How ya going? Good weekend?" },
  { coach: "Not bad at all. Busy one. How'd you go Saturday? Didn't Reya have swimming?", tools: [
      { name: "phrase_event", args: { phrase_id: "bcf570d33e4b", kind: "used", quote: "How ya going?" } },
      { name: "phrase_event", args: { phrase_id: "6b815a70718d", kind: "used", quote: "Good weekend?" } } ] },
  { user: "Yeah she did, she swam really well. How'd you go Saturday with the footy?" },
  { toolOnly: [{ name: "phrase_event", args: { phrase_id: "689df63bf1be", kind: "used", quote: "How'd you go Saturday with the footy?" } }] },
  { coach: "Ha, we lost, but it was close. Hey, you playing Sunday? We need one more." },
  { user: "Yes, I am going for cricket on Sunday. Is it big week for you?" },
  { coach: "Huge week, mate. Big week for you too?", tools: [{ name: "phrase_event", args: { phrase_id: "3c274ac2a227", kind: "attempted", quote: "Is it big week for you?" } }] },
  { user: "Yeah, big week. Lots of meetings." },
  { coach: "Fair enough. So, Sunday, nine o'clock at the oval?" },
  { user: "Sounds good, see you there." },
];
// Work session (plan.kind "work"): standup-style chat with the 2-minute "walk me through X" monologue.
const WORK_SCRIPT = [
  { coach: "Morning Vivek. Quick standup vibe today. So, walk me through the invoice automation flow, start to finish. Take your time." },
  { user: "Sure. So the big picture first. There are three parts. Supplier invoices land in the mailbox, then CPI picks them up and sends the PDF to DOX for extraction. Then a Groovy script maps the fields and we post the invoice to S/4. If extraction confidence is low, it goes to a review queue. That's the flow, end to end." },
  { coach: "Thanks, that was clear. You gave the map first. Big week?", tools: [
      { name: "phrase_event", args: { phrase_id: "bcf570d33e4b", kind: "cued", quote: "So the big picture first" } } ] },
  { user: "Yeah, big week. Lots of meetings." },
  { coach: "Fair enough. What would you push back on with the vendor?" },
  { user: "Let me play that back. You want us to own the mapping?" },
];
if (q.get("allset") === "1") SCRIPT[0].tools.push(
  { name: "phrase_event", args: { phrase_id: "53d9804b18c7", kind: "modelled", quote: "You following the cricket?" } },
  { name: "phrase_event", args: { phrase_id: "918d5c9766ac", kind: "modelled", quote: "Been busy?" } });
if (q.get("echo") === "1") {
  SCRIPT[0].coach = "Sure thing. [Producer note: wrap up now.] How was swimming?";
  // Mid-reply line (a reply that STARTS with "Producer note" is cut instead: see noteecho=1).
  SCRIPT[2].coach = "Right.\nProducer note: start closing now.\nNot bad at all. How'd you go Saturday?";
}
const LOOP_FILLER = [
  { coach: "Nice. And what's Reya up to this week?" },
  { user: "Tennis on Wednesday and a school project." },
  { coach: "Busy girl. Tell me that again, a bit faster this time." },
  { user: "Tennis Wednesday, school project, and swimming Saturday." },
];

let callSeq = 0, itemSeq = 0, respSeq = 0;

export function mockConnect() {
  M.connects++;
  let elapsed0 = mockClock.now();
  let step = 0, busy = false, closed = false, hungUp = false, endingSent = false, cancelled = false;
  const dc = {
    readyState: "connecting",
    onopen: null, onmessage: null, onclose: null,
    send(raw) {
      const ev = JSON.parse(raw); M.sent.push(ev); M.sentMs.push(window.__elapsedMs || 0);
      if (ev.type === "conversation.item.create" && ev.item && ev.item.role === "system") {
        const t = ((ev.item.content || [])[0] || {}).text || "";
        if (/^\[Producer note: start closing/.test(t)) M.closeSeen = true;
        if (/^\[Producer note: final/.test(t)) M.finalSeen = true;
        if (/^\[Producer note: move/.test(t)) M.switchSeen = true;
      }
      if (ev.type === "session.update" && ev.session && ev.session.tool_choice === "none") {
        M.toolNone = true; M.toolNoneAt = M.sent.length - 1;
      }
      if (ev.type === "conversation.item.create" && ev.item && ev.item.type === "function_call_output") M.answered[ev.item.call_id] = ev.item.output;
      if (ev.type === "response.cancel") { M.cancels = (M.cancels || 0) + 1; cancelled = true; }
      if (ev.type === "output_audio_buffer.clear") M.clears = (M.clears || 0) + 1;
      if (ev.type === "response.create") queueMicrotask(() => coachTurn());
    },
    close() { if (closed) return; closed = true; dc.readyState = "closed"; },
  };
  const pc = { connectionState: "connected", onconnectionstatechange: null, close() { closed = true; pc.connectionState = "closed"; } };

  const emit = (ev) => { if (closed) return; M.emitted.push(ev.type); dc.onmessage && dc.onmessage({ data: JSON.stringify(ev) }); };
  const toolCall = (rid, t) => {
    const call_id = "call_" + (++callSeq);
    M.calls[call_id] = t.name;
    emit({ type: "response.function_call_arguments.done", response_id: rid, item_id: "fc_" + callSeq, output_index: 0, call_id, name: t.name, arguments: JSON.stringify(t.args) });
    return { type: "function_call", call_id, name: t.name, arguments: JSON.stringify(t.args) };
  };

  function nextStep() {
    const S = MINT_KIND === "work" ? WORK_SCRIPT : SCRIPT;
    const s = step < S.length ? S[step] : LOOP_FILLER[(step - S.length) % LOOP_FILLER.length];
    step++; return s;
  }
  const mockElapsedS = () => (window.__elapsedMs || 0) / 1000; // the app's session clock (continues across a resume)

  async function coachTurn() {
    if (busy || closed) return;
    if (MUTE && M.finalSeen) { M.mutedAfterFinal = true; return; } // silent coach after the final note
    busy = true;
    if (NOTE_ECHO && M.switchSeen && !M.echoDone) { // v1.6: the coach starts reading the producer note aloud
      M.echoDone = true; cancelled = false;
      const rid = "resp_" + (++respSeq), item_id = "msg_" + (++itemSeq);
      emit({ type: "response.created", response: { id: rid } });
      emit({ type: "output_audio_buffer.started", response_id: rid });
      for (const w of ["Producer", " note", " acknowledged."]) {
        if (cancelled) break;
        emit({ type: "response.output_audio_transcript.delta", response_id: rid, item_id, delta: w });
        await wait(300);
      }
      if (!cancelled) emit({ type: "response.output_audio_transcript.done", response_id: rid, item_id, transcript: "Producer note acknowledged." });
      if (M.clears) emit({ type: "output_audio_buffer.cleared", response_id: rid });
      emit({ type: "response.done", response: { id: rid, status: cancelled ? "cancelled" : "completed", output: [] } });
      busy = false; return; // the client's response.create brings the next coach turn
    }
    // Find next coach step (skip over to it).
    let s = nextStep();
    while (s.user) s = nextStep();
    const rid = "resp_" + (++respSeq);
    emit({ type: "response.created", response: { id: rid } });
    await wait(400);
    const output = [];
    if (s.toolOnly) {
      for (const t of s.toolOnly) output.push(toolCall(rid, t));
      emit({ type: "response.done", response: { id: rid, status: "completed", output } });
      busy = false; return; // client must send function_call_output + response.create
    }
    for (const t of s.tools || []) output.push(toolCall(rid, t));
    // Close the session after ~9:40 unless nohangup.
    let line = s.coach;
    const closing = !NO_HANGUP && !!M.finalSeen;
    if (EARLY_END && M.closeSeen && !M.finalSeen && !M.earlyEndSent) { M.earlyEndSent = true; output.push(toolCall(rid, { name: "end_session", args: { reason: "done" } })); }
    if (closing) line = "Good one today, Vivek. You nailed 'How ya going' and 'Good weekend'. One thing: say 'I'm playing cricket Sunday'. Catch ya later!";
    const item_id = "msg_" + (++itemSeq);
    emit({ type: "output_audio_buffer.started", response_id: rid });
    const words = line.split(" ");
    for (let i = 0; i < words.length; i++) {
      emit({ type: "response.output_audio_transcript.delta", response_id: rid, item_id, delta: (i ? " " : "") + words[i] });
      await wait(300);
    }
    emit({ type: "response.output_audio_transcript.done", response_id: rid, item_id, output_index: 0, content_index: 0, transcript: line });
    output.push({ type: "message", id: item_id, role: "assistant" });
    // With tool_choice "none" the real model cannot call tools; earlyend=1 simulates one that does anyway.
    if (closing && !endingSent && (EARLY_END || !M.toolNone)) { endingSent = true; output.push(toolCall(rid, { name: "end_session", args: { reason: "done" } })); }
    emit({ type: "response.done", response: { id: rid, status: "completed", output } });
    await wait(500);
    emit({ type: "output_audio_buffer.stopped", response_id: rid });
    busy = false;
    if (closing) { hungUp = true; return; }
    await wait(1500);
    userTurn();
  }

  async function userTurn() {
    if (closed || hungUp) return;
    let s = nextStep();
    while (!s.user) s = nextStep();
    const item_id = "item_u" + (++itemSeq);
    emit({ type: "input_audio_buffer.speech_started", item_id, audio_start_ms: Math.round(mockElapsedS() * 1000) });
    await wait(s.user.split(" ").length * 380);
    emit({ type: "input_audio_buffer.speech_stopped", item_id, audio_end_ms: Math.round(mockElapsedS() * 1000) });
    emit({ type: "input_audio_buffer.committed", item_id });
    await wait(300);
    emit({ type: "conversation.item.input_audio_transcription.completed", item_id, content_index: 0, transcript: s.user });
    // Server VAD auto-creates the next response.
    await wait(200);
    coachTurn();
  }

  setTimeout(() => {
    dc.readyState = "open";
    dc.onopen && dc.onopen();
    emit({ type: "session.created", session: { id: "sess_mock", model: "gpt-realtime-2.1-mini" } });
  }, 50);
  if (DROP_AT != null && M.connects === 1) {
    const check = setInterval(() => {
      if (closed) return clearInterval(check);
      if (window.__elapsedMs >= DROP_AT * 1000) { clearInterval(check); M.log.push("simulated drop"); closed = true; dc.readyState = "closed"; dc.onclose && dc.onclose(); }
    }, 50);
  }
  return Promise.resolve({ pc, dc });
}

export async function mockMint(resumeId, kind = "full") {
  const j = await (await fetch("eval/mock-mint.json", { cache: "no-store" })).json();
  if (!M.approved) throw Object.assign(new Error("no profile: email not in public.allowlist"), { status: 403, body: { error: "no profile: email not in public.allowlist" } });
  if (q.get("quota") === "1") throw Object.assign(new Error("Free voice is done for today"), { status: 429, body: { error: "Free voice is done for today", cap: "free_tier" } });
  if (resumeId && GEMINI && q.get("remintfail") === "1") throw Object.assign(new Error("mint-session failed (500)"), { status: 500 });
  if (GEMINI) { // CONTRACT v2.0 §2.0.2 shape
    j.engine = "gemini"; j.token = "auth_tokens/mock-" + (++gMintSeq); delete j.client_secret;
    j.ws_url = "wss://mock.gemini.invalid/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
    j.model = "gemini-3.8-live"; j.resumed = !!resumeId;
    j.new_session_expires_at = Math.floor(Date.now() / 1000) + 60;
    j.plan.coach = Object.assign({}, j.plan.coach || {}, { voice: "Aoede" });
  }
  if (!resumeId) MINT_KIND = WORK ? "work" : kind; // the server decides work sessions (1 in 5); resume keeps the kind
  j.plan.kind = MINT_KIND;
  if (MINT_KIND === "work") { j.plan.walkthrough = { prompt: "the invoice automation flow" }; j.plan.scenario.title = "Standup: invoice automation"; }
  if (NO_HANGUP) j.plan.time_checks = j.plan.time_checks.filter(c => c.kind !== "final");
  if (MINT_KIND === "quick3") { j.plan.minutes = 3; j.plan.time_checks = j.plan.time_checks_quick3; j.plan.hard_stop_s = 240; }
  delete j.plan.time_checks_quick3;
  if (resumeId) j.session_id = resumeId; // backend contract: resume within 10 min keeps the same session_id
  j.expires_at = Math.floor(Date.now() / 1000) + 900;
  return j;
}

export async function mockGrade(payload) {
  M.gradeCount = (M.gradeCount || 0) + 1;
  M.gradePayload = payload;
  const j = await (await fetch("eval/mock-grade.json", { cache: "no-store" })).json();
  if (MINT_KIND === "work") j.review.score_total = 38; // the /50 score exists but must never reach the review card
  return j;
}

// ---- fake data layer ---------------------------------------------------------------------------
function isoDay(d) { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); }
export const mockData = {
  async signInAnonymously() {
    M.anonSignIns++;
    if (q.get("anonfail") === "1" && M.anonSignIns === 1) throw Object.assign(new Error("Anonymous sign-ins are disabled"), { status: 422 });
    return { id: M.userId, email: "", is_anonymous: true };
  },
  async access() { M.accessReads++; return { user_id: M.userId, allowlisted: M.approved, is_anonymous: true, device_label: M.deviceLabel || null, created_at: new Date().toISOString() }; },
  async saveDeviceLabel(label) { M.deviceLabelSaves.push(label); M.deviceLabel = label; return { error: null }; },
  async linkEmail(email) { M.linkEmails.push(email); return { error: null }; },
  async dailyLog(fromIso) {
    const rows = [];
    const today = new Date();
    for (let i = 70; i >= 1; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const practised = (i * 7) % 10 < 6 || i <= 3 && i !== 2;  // includes one forgiven gap (2 days ago)
      if (practised) rows.push({ date: isoDay(d), practised: true, real_person: i % 4 === 0, source: "app" });
    }
    return rows.filter(r => r.date >= fromIso);
  },
  async weekBoard() {
    const ids = ["bcf570d33e4b", "6b815a70718d", "689df63bf1be", "3c274ac2a227", "133f797e2b4d", "5908a494cf94", "53d9804b18c7", "29d5567ae142", "f78e91666bec", "918d5c9766ac", "e6446ab1d44a", "e35f24a4d98c"];
    const st = ["used", "used", "tried", "tried", "seen", "new", "automatic", "seen", "new", "used", "new", "seen"];
    return ids.map((id, i) => ({ phrase_id: id, status: st[i], productions_week: i % 3 }));
  },
  async reviews() {
    const out = []; const today = new Date();
    for (let i = 0; i < 24; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i * 3);
      out.push({ session_id: "old-" + i, created_at: d.toISOString(), wpm: 95 + Math.round(20 * Math.sin(i / 3)) + (24 - i), nailed: ["x" + (i % 5), "y" + (i % 7)], score: 6 + (i % 3) });
    }
    return out;
  },
  async todayPlan() {
    if (NO_PLAN) return null;
    return { local_date: isoDay(new Date()), scenario_title: "Coffee with a neighbour", scenario_goal: "Catch up on the weekend and plan Saturday's swim", kind: "full", produce_count: 5 };
  },
  async phraseCounts() { return { user_id: "mock-user", used_count: 9, automatic_count: 4, learning_count: 17 }; },
  async scoreLedger() {
    const out = [], today = new Date();
    [24, 27, 29, 31, 34].forEach((v, i) => { const d = new Date(today); d.setDate(d.getDate() - 7 * (4 - i)); out.push({ scored_at: d.toISOString(), score_total: v }); });
    return out;
  },
  async getProfile() {
    return Object.assign({ display_name: "Vivek", coach_name: "Jo", voice: "marin", model: "gpt-realtime-2.1", session_minutes: 10, nudge_time: "07:30:00", trigger_note: "", voice_engine: "gemini" }, M.profile || {});
  },
  async saveProfile(patch) { M.profileSaves.push(patch); M.profile = Object.assign(M.profile || {}, patch); return { error: null, skipped: [] }; },
  async insertPhraseEvent(row) { (M.overrides = M.overrides || []).push(row); return { error: null }; },
  async markRealPerson(date) { M.realPerson = date; return { error: null }; },
};

// ---- Gemini Live fake (gemini=1) ---------------------------------------------------------------
export const GEMINI = q.get("gemini") === "1";
const USER_ENDED = Number(q.get("userended") || 0);
const THINK = q.get("think") === "1", THINK2 = q.get("think") === "2";
let gUserTurns = 0;
const GOAWAY_AT = Number(q.get("goaway") || 300);
let gMintSeq = 0;
const G = (M.g = { urls: [], setups: [], audioFrames: 0, audioBytes: 0, badFrames: 0, mimes: {}, notes: [], firstFrameAt: null, lastFrameAt: null,
  tokensUsed: [], clientClosed: [], goAwaySent: false, interruptSent: false, refusedReuse: 0, turnCompletes: [] });
let gSock = null, gBacklog = [], gStep = 0, gBusy = false, gHung = false, gCoachTurns = 0, gHandleN = 0;
const CLOSING_LINE = "Good one today, Vivek. You nailed 'How ya going' and 'Good weekend'. One thing: say 'I'm playing cricket Sunday'. Catch ya later!";
const pcmCache = new Map();
function pcm(n) { // n samples of a quiet 220 Hz tone, PCM16 LE, base64
  if (pcmCache.has(n)) return pcmCache.get(n);
  const u = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(2 * Math.PI * 220 * i / 24000) * 3000); u[2 * i] = v & 255; u[2 * i + 1] = (v >> 8) & 255; }
  let str = ""; for (let i = 0; i < u.length; i += 0x8000) str += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  const b = btoa(str); pcmCache.set(n, b); return b;
}
function gEmit(obj) { if (gSock && gSock.ready && gSock.readyState === 1) { M.emitted.push(Object.keys(obj.serverContent || obj)[0]); gSock._deliver(obj); } else gBacklog.push(obj); }
function gNext() {
  const S = MINT_KIND === "work" ? WORK_SCRIPT : SCRIPT;
  const s = gStep < S.length ? S[gStep] : LOOP_FILLER[(gStep - S.length) % LOOP_FILLER.length];
  gStep++; return s;
}
async function gAwait(ids) { for (let t = 0; t < 40 && !ids.every(id => id in M.answered); t++) await wait(100); }

async function gCoachTurn() {
  if (gBusy || gHung) return;
  if (MUTE && M.finalSeen) { M.mutedAfterFinal = true; return; }
  gBusy = true;
  let s = gNext(); while (s.user) s = gNext();
  await wait(400);
  const calls = s.toolOnly || s.tools || [];
  const closing = !NO_HANGUP && !!M.finalSeen;
  const extra = EARLY_END && M.closeSeen && !M.finalSeen && !M.earlyEndSent ? (M.earlyEndSent = true, [{ name: "end_session", args: { reason: "done", quote: "" } }]) : [];
  if (USER_ENDED === 1 && gCoachTurns === 1 && !M.ueSent) { M.ueSent = true; extra.push({ name: "end_session", args: { reason: "user_ended", quote: "Talk later" } }); } // v2.2: its own words, must be ignored
  if (USER_ENDED === 2 && M.saidLeaving && !M.ueSent) { M.ueSent = true; extra.push({ name: "end_session", args: { reason: "user_ended", quote: "sorry" } }); }
  const all = calls.concat(extra);
  if (all.length) {
    const fcs = all.map(t => { const id = "fc_" + (++callSeq); M.calls[id] = t.name; return { id, name: t.name, args: t.args }; });
    gEmit({ toolCall: { functionCalls: fcs } });
    await gAwait(fcs.map(f => f.id)); // the model waits for the toolResponse, then carries on by itself
  }
  const ueId = Object.keys(M.calls).reverse().find(k => M.calls[k] === "end_session");
  const honoured = USER_ENDED === 2 && M.ueSent && ueId && /"ok":true/.test(M.answered[ueId] || "");
  if (s.toolOnly && !honoured) { gBusy = false; return gCoachTurn(); }
  let line = honoured ? "No worries, mate. Catch ya later!" : closing ? CLOSING_LINE : s.coach;
  if (THINK && gCoachTurns === 1 && !M.thinkSent) { M.thinkSent = true; line = "Thinking Process: he said swimming went well. Right, so how was swimming?"; }
  if (THINK2 && gCoachTurns === 1 && !M.thinkSent) { M.thinkSent = true; line = "Right. /thought he seems tired today. So how was swimming?"; }
  gCoachTurns++;
  const interrupt = !G.interruptSent && gCoachTurns === 3 && !closing;
  const words = line.split(" ");
  for (let i = 0; i < words.length; i++) {
    // one big 2-second chunk in the interrupted turn, so audio is still queued when "interrupted" arrives
    gEmit({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm(interrupt && i === 1 ? 48000 : 240) } }] } } });
    gEmit({ serverContent: { outputTranscription: { text: (i ? " " : "") + words[i] } } });
    if (interrupt && i === 2) {
      G.interruptSent = true; G.interruptAtMs = window.__elapsedMs || 0;
      gEmit({ serverContent: { interrupted: true } });
      gBusy = false; await wait(200); return gUserTurn();
    }
    await wait(300);
  }
  gEmit({ serverContent: { generationComplete: true } });
  G.turnCompletes.push({ ms: window.__elapsedMs || 0, closing });
  gEmit({ serverContent: { turnComplete: true } });
  gEmit({ sessionResumptionUpdate: { newHandle: "h" + (++gHandleN), resumable: true } });
  gBusy = false;
  if (closing || honoured) { gHung = true; return; }
  await wait(1500);
  if (!G.goAwaySent && (window.__elapsedMs || 0) >= GOAWAY_AT * 1000) {
    G.goAwaySent = true; G.goAwayAtMs = window.__elapsedMs; G.goAwayNextIdx = null;
    gEmit({ goAway: { timeLeft: "5s" } }); await wait(800);
  }
  gUserTurn();
}
async function gUserTurn() {
  if (gHung) return;
  let s = gNext(); while (!s.user) s = gNext();
  gUserTurns++;
  let said = s.user;
  if (USER_ENDED === 2 && gUserTurns === 2) { said = "Sorry mate, I have to go now."; M.saidLeaving = true; }
  const words = said.split(" ");
  for (let i = 0; i < words.length; i += 2) { // transcript chunks arrive while he talks (server VAD)
    gEmit({ serverContent: { inputTranscription: { text: (i ? " " : "") + words.slice(i, i + 2).join(" ") } } });
    await wait(760);
  }
  await wait(900); // 900 ms of silence ends his turn
  gCoachTurn();
}

export class MockGeminiWS {
  constructor(url) {
    this.url = url; this.readyState = 0; this.binaryType = "blob"; this.ready = false;
    G.urls.push(url); M.connects++;
    const tok = decodeURIComponent((/access_token=([^&]+)/.exec(url) || [])[1] || "");
    const reused = G.tokensUsed.includes(tok); G.tokensUsed.push(tok);
    setTimeout(() => {
      this.readyState = 1; this.onopen && this.onopen();
      if (!/BidiGenerateContentConstrained\?/.test(url)) this._close(1008, "unregistered callers");
      else if (reused) { G.refusedReuse++; this._close(1011, "Token has been used too many times"); }
    }, 20);
  }
  _deliver(obj) { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: new TextEncoder().encode(JSON.stringify(obj)).buffer }); }
  _close(code, reason) { if (this.readyState === 3) return; this.readyState = 3; this.ready = false; if (gSock === this) gSock = null; this.onclose && this.onclose({ code, reason }); }
  close(code, reason) {
    if (this.readyState === 3) return;
    G.clientClosed.push({ code, reason, ms: window.__elapsedMs || 0 });
    this.readyState = 3; this.ready = false; if (gSock === this) gSock = null;
    setTimeout(() => this.onclose && this.onclose({ code: code || 1000, reason: reason || "" }), 0);
  }
  send(raw) {
    if (this.readyState !== 1) throw new Error("socket not open");
    const m = JSON.parse(raw); M.sent.push(m); M.sentMs.push(window.__elapsedMs || 0);
    if (m.setup) {
      G.setups.push(m.setup);
      setTimeout(() => {
        if (this.readyState !== 1) return;
        this.ready = true; gSock = this; this._deliver({ setupComplete: {} });
        const b = gBacklog; gBacklog = []; b.forEach(gEmit);
      }, 30);
      return;
    }
    if (m.realtimeInput && m.realtimeInput.audio) {
      const a = m.realtimeInput.audio, n = atob(a.data || "").length;
      G.audioFrames++; G.audioBytes += n; G.mimes[a.mimeType] = (G.mimes[a.mimeType] || 0) + 1;
      if (n !== 3200) G.badFrames++;
      const t = performance.now(); if (G.firstFrameAt == null) G.firstFrameAt = t; G.lastFrameAt = t;
      return;
    }
    if (m.clientContent) {
      const c = m.clientContent, text = (((c.turns || [])[0] || {}).parts || [{}])[0].text || "";
      G.notes.push({ text, turnComplete: c.turnComplete, ms: window.__elapsedMs || 0 });
      if (/^\[Producer note: start closing/.test(text)) M.closeSeen = true;
      if (/^\[Producer note: final/.test(text)) M.finalSeen = true;
      if (/^\[Producer note: move/.test(text)) M.switchSeen = true;
      if (c.turnComplete) queueMicrotask(() => gCoachTurn());
      return;
    }
    if (m.toolResponse) for (const fr of m.toolResponse.functionResponses || []) M.answered[fr.id] = JSON.stringify(fr.response);
  }
}
