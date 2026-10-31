// realtime.js: one coaching call over WebRTC to the OpenAI Realtime API.
//
// Flow (OpenAI realtime-webrtc guide, checked 21 Oct 2026):
//   1. mint-session (our Supabase Edge Function) returns {session_id, client_secret, expires_at, model, plan}.
//      The session config (instructions, voice, tools, transcription, VAD) is baked in server-side.
//   2. RTCPeerConnection + mic track + data channel "oai-events".
//   3. POST the SDP offer to https://api.openai.com/v1/realtime/calls with
//      "Authorization: Bearer <client secret>", "Content-Type: application/sdp"; the body back is the SDP answer.
//
// Server events used (all names checked against the server-events API reference page on 21 Oct 2026):
//   input_audio_buffer.speech_started / speech_stopped           -> user turn timing + state
//   conversation.item.input_audio_transcription.delta / completed -> user transcript
//   response.output_audio_transcript.delta / done                -> coach transcript
//   output_audio_buffer.started / stopped (WebRTC only)          -> coach speaking state
//   response.function_call_arguments.done {call_id,name,arguments} -> tools phrase_event, end_session
//   response.done, error, session.created
// Client events sent: response.create, conversation.item.create (function_call_output, system message).
//
// Transport is injectable so ?mock=1 can run the whole Session screen against a scripted fake data channel.

import { REALTIME_CALLS_URL, TIME_CHECKS, HARD_STOP_S } from "./config.js";
import { ReplayGate, isReplay } from "./replay.js";
const FINAL_WAIT_MS = 40000; // v1.5: hang up this long after the final note if the coach has not replied

// CONTRACT v2.1: end_session "user_ended" is honoured only if his words show he is leaving (or he tapped End).
export const LEAVING_RE = /\b(?:have to go|got ?ta go|got to go|gotta run|need to run|talk later|catch you later|catch ya later|(?:good)?bye|leave it there|i['’]?m off|heading off)\b/i;
export const REFUSE_NOT_LEAVING = { ok: false, reason: "he has not said he has to go; the producer ends the call" };
export function saidLeaving(...texts) { return texts.some(t => LEAVING_RE.test(String(t || ""))); }
// CONTRACT v2.2: the tool call's quote is IGNORED (the coach quoted its own "Talk later"). Only HIS words count: the last
// learner transcript, or the one before it if it arrived within 20 s. list = [{text, at (elapsed ms)}], oldest first.
export function heSaidLeaving(list, nowMs) {
  const n = (list || []).length; if (!n) return false;
  const last = list[n - 1], prev = list[n - 2];
  return saidLeaving(last.text) || !!(prev && nowMs - prev.at <= 20000 && saidLeaving(prev.text));
}

export class TokenExpiredError extends Error { constructor(m) { super(m || "token expired"); this.name = "TokenExpiredError"; } }
export class NetworkError extends Error { constructor(m) { super(m || "no network"); this.name = "NetworkError"; } }

// ---- Real WebRTC transport --------------------------------------------------------------------
export async function webrtcConnect({ clientSecret, micStream, audioEl }) {
  const pc = new RTCPeerConnection();
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0];
    audioEl.play().catch(() => {}); // already unlocked by the Start tap
  };
  for (const track of micStream.getAudioTracks()) pc.addTrack(track, micStream);
  const dc = pc.createDataChannel("oai-events");
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  let r;
  try {
    r = await fetch(REALTIME_CALLS_URL, {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${clientSecret}`, "Content-Type": "application/sdp" },
    });
  } catch (e) { pc.close(); throw new NetworkError("Could not reach OpenAI"); }
  if (r.status === 401 || r.status === 403) { pc.close(); throw new TokenExpiredError(`OpenAI said ${r.status}`); }
  if (!r.ok) { pc.close(); throw new Error(`OpenAI call setup failed (${r.status}): ${(await r.text()).slice(0, 200)}`); }
  await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
  return { pc, dc };
}

// ---- The call ---------------------------------------------------------------------------------
// opts: {
//   mint: {session_id, client_secret, expires_at, model, plan}
//   connect: transport fn (webrtcConnect or mock)
//   micStream, audioEl
//   clock: { now(): ms }            (mock mode speeds time up)
//   startElapsedMs: number          (resume continues the clock)
//   resumeTurns: [{role,text}]      (resume: last turns to brief the coach)
//   sentChecks: [at,...]            (resume: time checks already sent)
//   store: { saveTurn(turn), saveEvent(ev), patch(obj) }
//   on: { state(s), caption(role,text,final), tally(n,m), elapsed(ms), ended(reason), dropped(reason), log(msg) }
// }
export class CoachCall {
  constructor(opts) {
    this.o = opts;
    this.on = opts.on || {};
    this.clock = opts.clock || { now: () => performance.now() };
    this.plan = opts.mint.plan || {};
    this.produceIds = new Set((this.plan.produce || []).map(p => p.phrase_id));
    this.usedIds = new Set();
    // Time checks + hard stop come from the plan (CONTRACT v1.1); config values are the fallback.
    // Checks are keyed by their second mark (at_s), so a resume skips the ones already sent.
    const pcs = Array.isArray(this.plan.time_checks) ? this.plan.time_checks
      .map(c => ({ at: Number(c.at_s), kind: c.kind, text: String(c.text || ""), max_items: c.max_items })).filter(c => c.at > 0 && (c.text || isReplay(c))) : []; // v3.0: replay has text null
    this.timeChecks = pcs.length ? pcs : TIME_CHECKS;
    this.hardStopS = Number(this.plan.hard_stop_s) > 0 ? Number(this.plan.hard_stop_s) : HARD_STOP_S;
    // v1.5: the producer ends the call. After the "final" note (+ tool_choice "none") the client hangs up when the
    // coach's next reply completes, or FINAL_WAIT_MS after the note with no reply. A resumed call that already got the
    // final note starts in that state (tool_choice "none" is sent again on connect, the 40 s count restarts).
    const fin = this.timeChecks.find(c => this.isFinal(c));
    this.finalAt = fin ? fin.at : null;
    this.afterFinal = this.finalAt != null && (opts.sentChecks || []).map(Number).includes(this.finalAt);
    this.finalAtMs = this.afterFinal ? (opts.startElapsedMs || 0) : null;
    this.finalResps = new Set();
    // v1.6: responses cut because the coach started reading a producer note aloud.
    this.cutResps = new Set();
    this.noteEchoCuts = opts.noteEchoCuts || 0;
    this.sentChecks = new Set((opts.sentChecks || []).map(Number));
    // CONTRACT v1.2: produce phrases with any phrase_event this session (restored from IndexedDB on resume),
    // and the switch-note suffix once computed (stored, so a resumed call sends the same text).
    this.touchedIds = new Set(opts.touchedIds || []);
    this.switchSuffix = opts.switchSuffix ?? null;
    this.replay = new ReplayGate(this, opts); // v3.0
    this.nextIdx = opts.nextIdx || 0;
    this.items = new Map();          // item_id -> {idx, role, t_start_ms, t_end_ms, text}
    this.seenCalls = new Set();      // call_id dedupe
    this.responses = new Map();      // response_id -> {calls:0, audio:false}
    this.state = "connecting";
    this.userSpeaking = false;
    this.coachSpeaking = false;
    this.lastActivity = 0;
    this.ending = false;
    this.closed = false;
  }

  isFinal(c) { return c.kind ? c.kind === "final" : /^\[Producer note: final/.test(c.text || ""); }
  noTools() { return this.send({ type: "session.update", session: { type: "realtime", tool_choice: "none" } }); }

  elapsedMs() { return (this.o.startElapsedMs || 0) + (this.t0 == null ? 0 : this.clock.now() - this.t0); }
  log(m) { this.on.log && this.on.log(m); }
  setState(s) { if (this.state !== s) { this.state = s; this.on.state && this.on.state(s); } }
  send(obj) {
    if (this.dc && this.dc.readyState === "open") { this.dc.send(JSON.stringify(obj)); return true; }
    this.log("send skipped (channel not open): " + obj.type); return false;
  }

  async start() {
    const { mint, connect, micStream, audioEl } = this.o;
    if (mint.expires_at && mint.expires_at * 1000 < Date.now() + 5000) throw new TokenExpiredError("token expired before connect");
    const secret = typeof mint.client_secret === "string" ? mint.client_secret : (mint.client_secret && mint.client_secret.value);
    const { pc, dc } = await connect({ clientSecret: secret, micStream, audioEl, model: mint.model });
    this.pc = pc; this.dc = dc;
    dc.onmessage = (e) => { try { this.handle(JSON.parse(e.data)); } catch (err) { this.log("bad event: " + err.message); } };
    dc.onclose = () => { if (!this.ending && !this.closed) this.drop("data channel closed"); };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this.log("pc " + s);
      if (s === "failed") this.drop("connection failed");
      if (s === "disconnected") {
        clearTimeout(this.discTimer);
        this.discTimer = setTimeout(() => { if (pc.connectionState !== "connected") this.drop("connection lost"); }, 5000);
      }
    };
    if (micStream) for (const t of micStream.getAudioTracks()) {
      t.onended = () => { if (!this.ending && !this.closed) this.drop("microphone stopped (phone call or another app?)"); };
    }
    await new Promise((resolve, reject) => {
      if (dc.readyState === "open") return resolve();
      const to = setTimeout(() => reject(new NetworkError("Timed out opening the call")), 15000);
      dc.onopen = () => { clearTimeout(to); resolve(); };
    });
    this.t0 = this.clock.now();
    this.lastActivity = this.clock.now();
    this.tick = setInterval(() => this.onTick(), 250);
    this.on.tally && this.on.tally(this.usedIds.size, this.produceIds.size);
    this.setState("thinking");
    if (this.o.resumeTurns && this.o.resumeTurns.length) {
      const recap = this.o.resumeTurns.slice(-6).map(t => `${t.role === "user" ? "Learner" : "Coach"}: ${t.text}`).join("\n");
      this.systemNote(`The call dropped and has reconnected at ${fmt(this.elapsedMs())}. Do not greet again and do not restart. ` +
        `Say one short line like "Sorry, lost you there" and carry on from here. Last turns:\n${recap}`);
    }
    if (this.afterFinal) this.noTools();
    this.send({ type: "response.create" }); // coach opens (or picks up after a drop)
  }

  systemNote(text) {
    return this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
  }

  onTick() {
    if (this.closed) return;
    const ms = this.elapsedMs();
    this.on.elapsed && this.on.elapsed(ms);
    for (const c of this.timeChecks) {
      if (!this.sentChecks.has(c.at) && (isReplay(c) ? this.replay.ready(c, ms) : ms >= c.at * 1000)) {
        this.sentChecks.add(c.at);
        this.timeCheck(c);
      }
    }
    if (this.pendingCheckResponse && this.isIdle(2500)) { this.pendingCheckResponse = false; this.send({ type: "response.create" }); }
    if (this.afterFinal && !this.ending && ms - this.finalAtMs >= FINAL_WAIT_MS && !this.closed) { this.log("no reply after the final note"); this.hangUp("final_timeout"); return; }
    if (ms >= this.hardStopS * 1000 && !this.closed) { this.log("hard stop"); this.hangUp("hard_stop"); }
  }

  // Time check = a short system item in the conversation. If the line is quiet we also send response.create
  // so the coach acts on it now; if someone is talking, the next natural response already sees it
  // (sending response.create mid-speech would make the coach talk over the learner).
  timeCheck(c) {
    this.log("time check " + c.at + "s");
    // CONTRACT v1.3: the note goes verbatim; a switch note gets ` Still to set up: "a", "b"` just before its final "]".
    let text = isReplay(c) ? this.replay.text() : c.text; // v3.0: built from replay-plan's items
    const isSwitch = c.kind ? c.kind === "switch" : /^\[Producer note: move/.test(c.text);
    if (isSwitch) {
      if (this.switchSuffix == null) {
        const left = (this.plan.produce || []).filter(p => p.phrase_id && p.text && !this.touchedIds.has(p.phrase_id)).map(p => `"${p.text}"`);
        this.switchSuffix = left.length ? `Still to set up: ${left.join(", ")}` : "";
      }
      if (this.switchSuffix) {
        const k = text.lastIndexOf("]");
        text = k >= 0 ? text.slice(0, k) + " " + this.switchSuffix + text.slice(k) : text + " " + this.switchSuffix;
      }
    }
    if (this.isFinal(c)) { // v1.5: no more tools; the reply to this note is the coach's last turn
      this.noTools();
      this.afterFinal = true; this.finalAtMs = this.elapsedMs(); this.finalResps = new Set();
    }
    this.systemNote(text);
    this.on.phase && this.on.phase(c.kind || "");
    if (this.isIdle(2500)) this.send({ type: "response.create" });
    else this.pendingCheckResponse = true; // cleared by the next natural response.created, or sent when the line goes quiet
    this.o.store && this.o.store.patch({ sent_checks: [...this.sentChecks], ...(this.switchSuffix != null ? { switch_suffix: this.switchSuffix } : {}) });
  }

  isIdle(ms) { return !this.userSpeaking && !this.coachSpeaking && this.clock.now() - this.lastActivity >= ms && !this.responseActive; }

  item(id, role) {
    let it = this.items.get(id);
    if (!it) { it = { idx: this.nextIdx++, role, item_id: id, t_start_ms: this.elapsedMs(), t_end_ms: null, text: "" }; this.items.set(id, it); }
    return it;
  }

  async saveItem(it) {
    if (!this.o.store) return;
    try { await this.o.store.saveTurn({ idx: it.idx, role: it.role, text: it.text, ...(it.raw_text && it.raw_text !== it.text ? { raw_text: it.raw_text } : {}), t_start_ms: it.t_start_ms, t_end_ms: it.t_end_ms || this.elapsedMs(), item_id: it.item_id }); }
    catch (e) { this.log("save turn failed: " + e.message); }
    this.o.store.patch({ next_idx: this.nextIdx, elapsed_ms: this.elapsedMs() });
  }

  handle(ev) {
    this.lastActivity = this.clock.now();
    switch (ev.type) {
      case "session.created": case "session.updated": this.log(ev.type); break;
      case "input_audio_buffer.speech_started": {
        this.userSpeaking = true; this.setState("you");
        const it = this.item(ev.item_id || "u" + this.nextIdx, "user");
        it.t_start_ms = this.elapsedMs();
        break;
      }
      case "input_audio_buffer.speech_stopped": {
        this.userSpeaking = false; this.setState("thinking");
        if (ev.item_id) this.item(ev.item_id, "user").t_end_ms = this.elapsedMs();
        break;
      }
      case "conversation.item.input_audio_transcription.delta":
        this.on.caption && this.on.caption("user", (this.item(ev.item_id, "user").partial = (this.item(ev.item_id, "user").partial || "") + (ev.delta || "")), false);
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const it = this.item(ev.item_id, "user");
        it.text = (ev.transcript || "").trim();
        if (it.text) (this.userTexts = this.userTexts || []).push({ text: it.text, at: this.elapsedMs() });
        if (!it.t_end_ms) it.t_end_ms = this.elapsedMs();
        this.on.caption && this.on.caption("user", it.text, true);
        this.saveItem(it);
        break;
      }
      case "conversation.item.input_audio_transcription.failed":
        this.log("user transcription failed for " + ev.item_id); break;
      case "response.created": // a natural response already sees the note
        this.responseActive = true; this.pendingCheckResponse = false;
        if (this.afterFinal) this.finalResps.add((ev.response && ev.response.id) || "_");
        break;
      case "response.output_audio_transcript.delta": {
        const it = this.item(ev.item_id, "assistant");
        if (it.cut || this.cutResps.has(ev.response_id)) { it.cut = true; break; } // rest of a cut response: ignore
        it.partial = (it.partial || "") + (ev.delta || "");
        this.markResp(ev.response_id).audio = true;
        if (!it.echoChecked) {
          // v1.6: does this reply START with "producer note" (after quotes/brackets/spaces)? Decide once 13 letters are in.
          const head = it.partial.replace(/^[\s"'“”‘’\[\]()]+/, "").toLowerCase();
          if (head.startsWith("producer note")) { it.echoChecked = true; this.cutNoteEcho(it, ev.response_id); break; }
          if (head.length >= 13 || !"producer note".startsWith(head)) it.echoChecked = true;
        }
        this.on.caption && this.on.caption("assistant", stripNotes(it.partial), false);
        break;
      }
      case "response.output_audio_transcript.done": {
        const it = this.item(ev.item_id, "assistant");
        if (it.cut || this.cutResps.has(ev.response_id)) break; // v1.6: a cut response is never captioned or graded
        // Defensive (v1.3): a coach that reads a [producer note] aloud must not reach captions or the grader.
        it.raw_text = (ev.transcript || it.partial || "").trim();
        it.text = stripNotes(it.raw_text);
        if (it.text !== it.raw_text) this.log("dropped bracketed text from a coach turn");
        it.t_end_ms = this.elapsedMs();
        this.markResp(ev.response_id).audio = true;
        this.on.caption && this.on.caption("assistant", it.text, true);
        this.saveItem(it);
        break;
      }
      case "output_audio_buffer.started": this.coachSpeaking = true; this.setState("speaking"); break;
      case "output_audio_buffer.stopped": case "output_audio_buffer.cleared":
        this.coachSpeaking = false;
        if (this.ending) { this.finishSoon(600); break; }
        this.setState(this.userSpeaking ? "you" : "listening");
        break;
      case "response.function_call_arguments.done":
        this.toolCall(ev.call_id, ev.name, ev.arguments, ev.response_id); break;
      case "response.done": {
        this.responseActive = false;
        const r = ev.response || {};
        const out = r.output || [];
        // Fallback: some builds only report the call inside response.done.
        for (const o of out) if (o.type === "function_call" && o.call_id && !this.seenCalls.has(o.call_id)) this.toolCall(o.call_id, o.name, o.arguments, r.id);
        const rec = this.markResp(r.id);
        const hadCall = out.some(o => o.type === "function_call") || rec.calls > 0;
        const hadMsg = out.some(o => o.type === "message") || rec.audio;
        if (this.cutResps.has(r.id)) { // v1.6: the cancelled echo is over; one response.create so the coach carries on
          clearTimeout(this.recreateTimer); this.recreateCut(r.id);
          if (!this.coachSpeaking && !this.userSpeaking && !this.ending) this.setState("listening");
          break;
        }
        if (this.afterFinal && !this.ending && hadMsg && this.finalResps.has(r.id || "_")) {
          // v1.5: the coach's reply to the final note is complete: hang up once its audio has played (12 s safety).
          this.log("final reply complete"); this.ending = true; this.endReason = "final_reply"; this.setState("closing");
          clearTimeout(this.endTimer); this.endTimer = setTimeout(() => this.hangUp(this.endReason), 12000);
        }
        if (this.ending) { if (!this.coachSpeaking) this.finishSoon(1500); }
        else if (hadCall && !hadMsg) this.send({ type: "response.create" }); // tool-only turn: let the coach carry on
        if (!this.coachSpeaking && !this.userSpeaking && !this.ending) this.setState("listening");
        if (r.status === "failed") this.log("response failed: " + JSON.stringify(r.status_details || {}));
        break;
      }
      case "error": {
        const e = ev.error || {};
        this.log("error: " + (e.code || "") + " " + (e.message || ""));
        if (/expired|session_expired|invalid_api_key|token/i.test((e.code || "") + (e.message || ""))) this.drop("token expired");
        break;
      }
      default: break;
    }
  }

  markResp(id) { const k = id || "_"; let r = this.responses.get(k); if (!r) { r = { calls: 0, audio: false }; this.responses.set(k, r); } return r; }

  toolCall(call_id, name, argStr, response_id) {
    if (!call_id || this.seenCalls.has(call_id)) return;
    this.seenCalls.add(call_id);
    this.markResp(response_id).calls++;
    let args = {};
    try { args = typeof argStr === "string" ? JSON.parse(argStr || "{}") : (argStr || {}); } catch (_) { args = {}; }
    let output = { ok: true };
    if (name === "phrase_event") {
      const ev = { phrase_id: String(args.phrase_id || ""), kind: String(args.kind || "attempted"), quote: String(args.quote || ""), t_ms: this.elapsedMs() };
      if (ev.phrase_id) {
        this.touchedIds.add(ev.phrase_id);
        this.o.store && this.o.store.saveEvent(ev).catch(e => this.log("save event failed: " + e.message));
        if (ev.kind === "used" && this.produceIds.has(ev.phrase_id)) {
          this.usedIds.add(ev.phrase_id);
          this.on.tally && this.on.tally(this.usedIds.size, this.produceIds.size);
        }
      } else output = { ok: false, error: "phrase_id missing" };
    } else if (name === "end_session" && args.reason !== "user_ended") {
      // v1.5: only "user_ended" is honoured; the producer (this client) ends the call otherwise.
      this.log("end_session refused: " + (args.reason || ""));
      output = { ok: false, reason: "the producer ends the call" };
    } else if (name === "end_session" && !this.endTapped && !heSaidLeaving(this.userTexts, this.elapsedMs())) {
      this.log("end_session user_ended refused: no leaving phrase");
      output = REFUSE_NOT_LEAVING;
    } else if (name === "end_session") {
      this.log("end_session: " + (args.reason || ""));
      this.ending = true; this.endReason = "coach:" + (args.reason || "done");
      this.setState("closing");
      // Hang up once the goodbye has finished playing (output_audio_buffer.stopped), with a safety timeout.
      clearTimeout(this.endTimer);
      this.endTimer = setTimeout(() => this.hangUp(this.endReason), 12000);
    } else {
      output = { ok: false, error: "unknown tool " + name };
    }
    // Always answer a function call, even for an unknown tool, or the model waits for it.
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id, output: JSON.stringify(output) } });
  }

  // v1.6: the coach started speaking a producer note. Stop it (response.cancel + clear the WebRTC audio buffer), wipe the
  // caption, count it, and once the cancelled response has finished send ONE response.create so the coach continues.
  cutNoteEcho(it, responseId) {
    this.log("coach started reading a producer note: cutting it");
    it.cut = true; it.partial = ""; it.text = "";
    if (responseId) this.cutResps.add(responseId);
    this.send(responseId ? { type: "response.cancel", response_id: responseId } : { type: "response.cancel" });
    this.send({ type: "output_audio_buffer.clear" });
    this.noteEchoCuts++;
    this.o.store && this.o.store.patch({ note_echo_cuts: this.noteEchoCuts });
    this.on.caption && this.on.caption("assistant", "", false);
    this.recreated = this.recreated || new Set();
    clearTimeout(this.recreateTimer);
    this.recreateTimer = setTimeout(() => this.recreateCut(responseId), 2500); // safety if response.done never comes
  }
  recreateCut(responseId) {
    const k = responseId || "_";
    if (this.closed || this.ending || (this.recreated && this.recreated.has(k))) return;
    (this.recreated = this.recreated || new Set()).add(k);
    this.send({ type: "response.create" });
  }

  finishSoon(ms) { clearTimeout(this.finTimer); this.finTimer = setTimeout(() => this.hangUp(this.endReason || "coach"), ms); }

  cleanup() {
    clearInterval(this.tick); clearTimeout(this.endTimer); clearTimeout(this.finTimer); clearTimeout(this.discTimer);
    try { this.dc && this.dc.close(); } catch (_) {}
    try { this.pc && this.pc.close(); } catch (_) {}
  }

  hangUp(reason) {
    if (this.closed) return;
    this.closed = true; this.ending = true;
    this.cleanup();
    this.setState("ended");
    this.on.ended && this.on.ended(reason || "user", this.elapsedMs());
  }

  drop(reason) {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
    this.setState("dropped");
    this.on.dropped && this.on.dropped(reason, this.elapsedMs());
  }
}

// Remove [bracketed] segments (an unclosed "[" in a streaming partial hides the rest) and any line that starts
// with "Producer note" (v1.4, case-insensitive), then tidy the spaces.
export function stripNotes(s) {
  return String(s || "").replace(/\[[^\]]*(\]|$)/g, " ").split(/\r?\n/)
    .filter(l => { const t = l.trim().toLowerCase(); return !/^producer note\b/.test(t) && !(t.length >= 3 && "producer note".startsWith(t)); }).join(" ")
    .replace(/\s+([.,!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

export function fmt(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
