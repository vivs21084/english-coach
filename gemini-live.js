// gemini-live.js: one coaching call over a WebSocket to the Gemini Live API (design v0.3, CONTRACT v2.0).
// Same constructor options, methods (start, hangUp, cleanup, elapsedMs) and on.* callbacks as realtime.js's CoachCall,
// so app.js picks one or the other on mint.engine ("gemini" | "openai").
//
// Wire format (checked 26 Oct 2026 against ai.google.dev/api/live, /gemini-api/docs/live-session,
// /gemini-api/docs/ephemeral-tokens, /gemini-api/docs/live-api/get-started-websocket, and the live probes
// ~/evc-probe/live_probe.mjs + live_probe2.mjs on models/gemini-3.8-live):
//   connect   wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.
//             BidiGenerateContentConstrained?access_token=<ephemeral token>   (mint.ws_url, config fallback)
//   1st msg   {setup:{model}} or, on a reconnect, {setup:{model, sessionResumption:{handle}}} (docs: "the first message
//             must be a setup"; the config is locked inside the token by mint-session; mint.setup, if any, is merged in)
//   <- setupComplete
//   mic       {realtimeInput:{audio:{data:<base64 PCM16 LE 16 kHz mono>, mimeType:"audio/pcm;rate=16000"}}}  ~100 ms frames
//   notes     {clientContent:{turns:[{role:"user",parts:[{text}]}], turnComplete}}   (switch false, close/final/open true)
//   frames    JSON in text or binary frames; binaryType "arraybuffer" + TextDecoder (synchronous, keeps the order)
//   tools  <- {toolCall:{functionCalls:[{id,name,args}]}}  -> {toolResponse:{functionResponses:[{id,name,response}]}}
//   audio  <- serverContent.modelTurn.parts[].inlineData {mimeType:"audio/pcm;rate=24000", data:<base64 PCM16 LE>}
//   text   <- serverContent.inputTranscription.text (learner), serverContent.outputTranscription.text (coach)
//          <- serverContent.interrupted (barge-in: stop the play queue), serverContent.turnComplete
//          <- sessionResumptionUpdate {newHandle, resumable}, goAway {timeLeft}
// Reconnect (goAway, or an unexpected close): mint-session {resume_session_id} for a NEW token (CONTRACT v2.0, PROVEN:
// a used token is refused with 1011 even for a resumption, whatever the docs say), new socket, setup with
// sessionResumption.handle. Clock, turn numbering and sent notes carry on. Mint/socket failure -> end and grade.
//
// Timing for the grader: Gemini gives no speech_started/stopped events. A learner turn starts when its first
// inputTranscription chunk arrives and ends at its last chunk (server VAD decides the turn; transcription lags speech by
// roughly 0.3-1 s, so t_start_ms is late by about that much). Coach turns run from their first audio/transcript chunk
// to turnComplete (or interrupted).

import { GEMINI_WS_URL, TIME_CHECKS, HARD_STOP_S } from "./config.js";
import { TokenExpiredError, NetworkError, stripNotes, fmt, heSaidLeaving, REFUSE_NOT_LEAVING } from "./realtime.js";

const FINAL_WAIT_MS = 40000;    // hang up this long after the final note if the coach has not replied (as v1.5)
const ECHO_TAIL_S = 0.4;       // mic stays closed this long after the coach stops (room echo)
const NOTE_IDLE_MS = 1500;      // a producer note waits for this much quiet on the line...
const NOTE_MAX_WAIT_MS = 10000; // ...a switch note (turnComplete false) goes anyway after this, between coach turns
const NOTE_MAX_WAIT_SPEAK_MS = 25000; // a close/final note (turnComplete true makes the coach answer) waits up to this for quiet
const USER_QUIET_MS = 1200;     // no new learner transcript for this long = he has stopped talking
const LATE_TX_MS = 2500;        // learner transcript arriving this soon after the coach started still belongs to his turn
export const IN_RATE = 16000, OUT_RATE = 24000, FRAME_SAMPLES = 1600; // 1600 samples = 100 ms at 16 kHz

export class QuotaError extends Error { constructor(m) { super(m || "free voice limit reached"); this.name = "QuotaError"; } }
const QUOTA_RE = /quota|resource.?exhausted|rate.?limit|too many requests|\b429\b/i;
const AUTH_RE = /token|auth|api.?key|permission|unauthenticated|expired|credential|deadline exceeded|unregistered/i;
export const OPEN_NOTE = "[Producer note: the call has connected. Say your opening line.]"; // CONTRACT v2.1
// CONTRACT v2.1: a coach turn that thinks aloud is muted and dropped (counted in note_echo_cuts).
export function thinkingAloud(t) {
  const s = String(t || "").toLowerCase();
  return /thinking process|constraint check|analy|step 1|\*\*|\[the |\/thought|i['’]ve ended the session|ended the session as requested/.test(s) ||
    (s.match(/___/g) || []).length >= 2; // v2.2 adds /thought and the "ended the session" lines
}

// AudioWorklet (inline, so GitHub Pages needs no extra file): mono float at the context's real rate (iOS often 48 kHz)
// -> box-filter downsample to 16 kHz -> Int16 LE frames of FRAME_SAMPLES, posted as transferable ArrayBuffers.
const WORKLET_SRC = `
class EvcPcm16 extends AudioWorkletProcessor {
  constructor(o) {
    super(); const p = (o && o.processorOptions) || {};
    this.ratio = Math.max(1, (p.inRate || sampleRate) / ${IN_RATE}); this.frame = p.frame || ${FRAME_SAMPLES};
    this.buf = new Int16Array(this.frame); this.n = 0; this.acc = 0; this.cnt = 0; this.pos = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.cnt++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let v = this.acc / this.cnt; this.acc = 0; this.cnt = 0;
        v = v < -1 ? -1 : v > 1 ? 1 : v;
        this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.frame) { this.port.postMessage(this.buf.buffer, [this.buf.buffer]); this.buf = new Int16Array(this.frame); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("evc-pcm16", EvcPcm16);`;
const workletReady = new WeakMap(); // AudioContext -> Promise (addModule once per context)

export function bytesToB64(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToFloat32(b64) {
  const bin = atob(b64 || ""), n = bin.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 0x8000) v -= 0x10000; out[i] = v / 0x8000; }
  return out;
}
function durMs(d) { const m = /^([\d.]+)s$/.exec(String(d || "")); return m ? Number(m[1]) * 1000 : 0; }
function tokenOf(m) { return typeof m.token === "string" ? m.token : (m.token && (m.token.name || m.token.value)) || (typeof m.client_secret === "string" ? m.client_secret : ""); }
// A token must OPEN its socket before new_session_expires_at (60 s after the mint, CONTRACT v2.0).
function expired(m) { const t = m.new_session_expires_at || m.expires_at; return !!(t && t * 1000 < Date.now() + 3000); }

export class GeminiCall {
  constructor(opts) {
    this.o = opts;
    this.on = opts.on || {};
    this.clock = opts.clock || { now: () => performance.now() };
    this.mintCur = opts.mint;
    this.plan = opts.mint.plan || {};
    this.produceIds = new Set((this.plan.produce || []).map(p => p.phrase_id));
    this.usedIds = new Set();
    const pcs = Array.isArray(this.plan.time_checks) ? this.plan.time_checks
      .map(c => ({ at: Number(c.at_s), kind: c.kind, text: String(c.text || "") })).filter(c => c.at > 0 && c.text) : [];
    this.timeChecks = pcs.length ? pcs : TIME_CHECKS;
    this.hardStopS = Number(this.plan.hard_stop_s) > 0 ? Number(this.plan.hard_stop_s) : HARD_STOP_S;
    const fin = this.timeChecks.find(c => this.isFinal(c));
    this.finalAt = fin ? fin.at : null;
    this.sentChecks = new Set((opts.sentChecks || []).map(Number));
    this.afterFinal = this.finalAt != null && this.sentChecks.has(this.finalAt);
    this.finalAtMs = this.afterFinal ? (opts.startElapsedMs || 0) : null;
    this.queuedChecks = new Set();
    this.noteQueue = [];
    this.noteEchoCuts = opts.noteEchoCuts || 0;
    this.touchedIds = new Set(opts.touchedIds || []);
    this.switchSuffix = opts.switchSuffix ?? null;
    this.nextIdx = opts.nextIdx || 0;
    this.handleId = opts.resumeHandle || null;
    this.cur = null;        // coach turn in progress {t_start_ms, partial, audio, cut, finalReply}
    this.userTurn = null;   // learner turn in progress {t_start_ms, t_end_ms, text, closing, entry}
    this.userTexts = [];    // his transcripts, oldest first [{text, at}] (v2.2 end_session guard)
    this.sources = new Set();
    this.playhead = 0;
    this.pendingSaves = new Set();
    this.seenCalls = new Set();
    this.wsGen = 0;
    this.ready = false;
    this.reconnects = 0;
    this.stats = { framesSent: 0, bytesSent: 0, interrupts: 0, cleared: 0 };
    this.state = "connecting";
    this.userSpeaking = false;
    this.lastActivity = 0;
    this.ending = false;
    this.closed = false;
  }

  isFinal(c) { return c.kind ? c.kind === "final" : /^\[Producer note: final/.test(c.text || ""); }
  elapsedMs() { return (this.o.startElapsedMs || 0) + (this.t0 == null ? 0 : this.clock.now() - this.t0); }
  log(m) { this.on.log && this.on.log(m); }
  setState(s) { if (this.state !== s) { this.state = s; this.on.state && this.on.state(s); } }
  playing() { return this.sources.size > 0; }
  send(obj) {
    const ws = this.ws;
    if (ws && ws.readyState === 1 && this.ready) { ws.send(JSON.stringify(obj)); return true; }
    this.log("send skipped (socket not ready): " + Object.keys(obj)[0]); return false;
  }
  note(text, turnComplete) { return this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: !!turnComplete } }); }

  // ---- connection -----------------------------------------------------------------------------
  setupMsg(handle) {
    const m = this.mintCur, model = String(m.model || "gemini-3.8-live");
    // CONTRACT v2.0: only the model (everything else is locked in the token); a reconnect adds the resumption handle.
    return { setup: { ...(m.setup || {}), model: model.startsWith("models/") ? model : "models/" + model, ...(handle ? { sessionResumption: { handle } } : {}) } };
  }

  connectOnce(handle) {
    const token = tokenOf(this.mintCur);
    if (!token) return Promise.reject(new Error("mint-session returned no Gemini token"));
    const base = this.mintCur.ws_url || GEMINI_WS_URL;
    const url = base + (base.includes("?") ? "&" : "?") + "access_token=" + token; // appended as returned (PROVEN, CONTRACT 2.0.3)
    const WS = this.o.WebSocketImpl || WebSocket;
    let ws;
    try { ws = new WS(url); } catch (e) { return Promise.reject(new NetworkError("Could not open the voice line")); }
    ws.binaryType = "arraybuffer"; // Gemini sends JSON in binary frames: decode synchronously so message order holds
    const gen = ++this.wsGen;
    this.ws = ws; this.ready = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => { if (settled) return; settled = true; clearTimeout(to); this.wsGen++; try { ws.close(); } catch (_) {} reject(err); };
      const to = setTimeout(() => fail(new NetworkError("Timed out opening the call")), 15000);
      ws.onopen = () => { try { ws.send(JSON.stringify(this.setupMsg(handle))); } catch (e) { fail(new NetworkError("Could not send setup")); } };
      ws.onmessage = (e) => {
        if (gen !== this.wsGen) return;
        let m; try { m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data)); } catch (err) { this.log("bad message: " + err.message); return; }
        if (!settled) {
          if (m.setupComplete !== undefined) { settled = true; clearTimeout(to); this.ready = true; resolve(); return; }
          if (m.error) { fail(this.classify(0, m.error.message || JSON.stringify(m.error))); return; }
        }
        try { this.handle(m); } catch (err) { this.log("handler error: " + err.message); }
      };
      ws.onerror = () => {}; // a close event always follows
      ws.onclose = (e) => {
        if (gen !== this.wsGen) return;
        if (!settled) return fail(this.classify(e.code, e.reason));
        this.ready = false; this.onSocketClosed(e);
      };
    });
  }

  classify(code, reason) {
    const r = String(reason || "");
    if (QUOTA_RE.test(r)) return new QuotaError("Gemini: " + r.slice(0, 120));
    if (code === 1008 || AUTH_RE.test(r)) return new TokenExpiredError("Gemini refused the token (" + code + " " + r.slice(0, 120) + ")");
    return new NetworkError("The voice line closed (" + (code || "?") + (r ? " " + r.slice(0, 80) : "") + ")");
  }

  async startMic() {
    const { micStream } = this.o, ctx = this.ctx;
    if (!micStream || !ctx || !ctx.audioWorklet) { if (micStream) this.log("no AudioWorklet: mic not sent"); return; }
    if (!workletReady.has(ctx)) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
      workletReady.set(ctx, ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url)));
    }
    await workletReady.get(ctx);
    this.micSrc = ctx.createMediaStreamSource(micStream);
    this.micNode = new AudioWorkletNode(ctx, "evc-pcm16", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit", processorOptions: { inRate: ctx.sampleRate, frame: FRAME_SAMPLES } });
    this.micSink = ctx.createGain(); this.micSink.gain.value = 0; // keeps the node pulled by the graph, silently
    this.micSrc.connect(this.micNode); this.micNode.connect(this.micSink); this.micSink.connect(ctx.destination);
    this.micNode.port.onmessage = (e) => this.sendAudio(e.data);
    this.log("mic: context " + ctx.sampleRate + " Hz -> 16000 Hz PCM16");
    for (const t of micStream.getAudioTracks()) t.onended = () => { if (!this.ending && !this.closed) this.drop("microphone stopped (phone call or another app?)"); };
  }

  sendAudio(buf) {
    if (this.closed || !this.ready || this.reconnecting) return; // frames during a reconnect are dropped
    // 31 Oct: half-duplex. On the iPhone speaker the coach's own voice came back through the mic and was transcribed as
    // Vivek's words, so no mic audio goes up while coach audio is playing (+ a short tail for the room echo).
    if (this.ctx && (this.sources.size > 0 || this.ctx.currentTime < this.playhead + ECHO_TAIL_S)) { this.stats.framesGated = (this.stats.framesGated || 0) + 1; return; }
    if (this.send({ realtimeInput: { audio: { data: bytesToB64(buf), mimeType: "audio/pcm;rate=16000" } } })) {
      this.stats.framesSent++; this.stats.bytesSent += buf.byteLength;
    }
  }

  async start() {
    const m = this.mintCur;
    if (expired(m)) throw new TokenExpiredError("token expired before connect");
    this.ctx = this.o.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    this.ownCtx = !this.o.audioCtx;
    try { await this.ctx.resume(); } catch (_) {}
    this.outGain = this.ctx.createGain(); this.outGain.connect(this.ctx.destination);
    await this.startMic();
    let usedHandle = !!this.handleId;
    try { await this.connectOnce(this.handleId); }
    catch (e) {
      if (!usedHandle || e instanceof QuotaError || !this.o.remint) throw e;
      // The stored resumption handle was refused (too old?): fresh token, fresh setup, brief the coach instead.
      this.log("resume handle refused (" + e.message + "): fresh setup");
      this.mintCur = { ...this.mintCur, ...(await this.o.remint()) }; this.handleId = null; usedHandle = false;
      await this.connectOnce(null);
    }
    this.t0 = this.clock.now();
    this.lastActivity = this.clock.now();
    this.tick = setInterval(() => this.onTick(), 250);
    this.on.tally && this.on.tally(this.usedIds.size, this.produceIds.size);
    this.setState("thinking");
    const resumed = this.o.resumeTurns && this.o.resumeTurns.length;
    if (resumed && usedHandle) {
      this.note(`[Producer note: the line dropped and has reconnected at ${fmt(this.elapsedMs())}. Do not greet again and do not restart. Say one short line like "Sorry, lost you there" and carry on.]`, true);
    } else if (resumed) {
      const recap = this.o.resumeTurns.slice(-6).map(t => `${t.role === "user" ? "Learner" : "Coach"}: ${t.text}`).join("\n");
      this.note(`[Producer note: the call dropped and has reconnected at ${fmt(this.elapsedMs())}. Do not greet again and do not restart. ` +
        `Say one short line like "Sorry, lost you there" and carry on from here. Last turns:\n${recap}]`, true);
    } else {
      this.note(OPEN_NOTE, true); // v2.1: once, so the coach speaks first (Gemini never opens on its own)
    }
  }

  // ---- time checks / producer notes ---------------------------------------------------------------
  onTick() {
    if (this.closed) return;
    const ms = this.elapsedMs();
    this.on.elapsed && this.on.elapsed(ms);
    if (this.userSpeaking && this.clock.now() - (this.lastUserAt || 0) > USER_QUIET_MS) {
      this.userSpeaking = false;
      if (!this.cur && !this.playing() && !this.ending) this.setState("thinking");
    }
    for (const c of this.timeChecks) {
      if (!this.sentChecks.has(c.at) && !this.queuedChecks.has(c.at) && ms >= c.at * 1000) {
        this.queuedChecks.add(c.at); this.noteQueue.push({ c, at: this.clock.now() });
      }
    }
    // A note never goes while the coach is mid-turn (no response.create on Gemini: a turnComplete:true note is itself the
    // "answer now", so sending it mid-turn or mid-sentence from the learner would cut someone off).
    while (this.noteQueue.length && !this.reconnecting && this.ready && !this.cur && (this.isIdle(NOTE_IDLE_MS) ||
      this.clock.now() - this.noteQueue[0].at >= (this.isSwitchNote(this.noteQueue[0].c) ? NOTE_MAX_WAIT_MS : NOTE_MAX_WAIT_SPEAK_MS))) this.timeCheck(this.noteQueue.shift().c);
    if (this.pendingReconnect && !this.reconnecting && (!this.cur || this.clock.now() >= this.reconnectBy)) this.reconnect("goAway");
    if (this.afterFinal && !this.ending && ms - this.finalAtMs >= FINAL_WAIT_MS) { this.log("no reply after the final note"); this.hangUp("final_timeout"); return; }
    if (ms >= this.hardStopS * 1000) { this.log("hard stop"); this.hangUp("hard_stop"); }
  }

  isSwitchNote(c) { return c.kind ? c.kind === "switch" : /^\[Producer note: move/.test(c.text); }
  isIdle(ms) { return !this.userSpeaking && !this.cur && !this.playing() && this.clock.now() - this.lastActivity >= ms; }

  timeCheck(c) {
    this.log("time check " + c.at + "s");
    let text = c.text;
    const isSwitch = this.isSwitchNote(c);
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
    if (this.isFinal(c)) { this.afterFinal = true; this.finalAtMs = this.elapsedMs(); }
    // switch: folds into the context silently (turnComplete false); close + final: the coach answers it now.
    this.note(text, !isSwitch);
    this.sentChecks.add(c.at);
    this.o.store && this.o.store.patch({ sent_checks: [...this.sentChecks], ...(this.switchSuffix != null ? { switch_suffix: this.switchSuffix } : {}) });
  }

  // ---- server messages ----------------------------------------------------------------------------
  handle(m) {
    this.lastActivity = this.clock.now();
    if (m.sessionResumptionUpdate) {
      const u = m.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) { this.handleId = u.newHandle; this.o.store && this.o.store.patch({ gemini_handle: u.newHandle }); }
    }
    if (m.goAway) this.onGoAway(m.goAway);
    if (m.toolCall) for (const fc of m.toolCall.functionCalls || []) this.toolCall(fc);
    if (m.toolCallCancellation) this.log("tool calls cancelled: " + (m.toolCallCancellation.ids || []).join(","));
    if (m.error) {
      const msg = m.error.message || JSON.stringify(m.error);
      this.log("error: " + msg);
      if (QUOTA_RE.test(msg)) return this.drop("free voice limit reached");
    }
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription && sc.inputTranscription.text) this.onUserText(sc.inputTranscription.text);
    if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) for (const p of sc.modelTurn.parts) if (p.inlineData && p.inlineData.data) this.onAudio(p.inlineData);
    if (sc.outputTranscription && sc.outputTranscription.text) this.onCoachText(sc.outputTranscription.text);
    if (sc.interrupted) this.onInterrupted();
    if (sc.turnComplete) this.finishCoachTurn("complete");
  }

  coachTurn() {
    if (!this.cur) {
      this.cur = { t_start_ms: this.elapsedMs(), partial: "", audio: false, cut: false, finalReply: this.afterFinal };
      if (this.userTurn) this.userTurn.closing = true; // his turn is over once the coach answers (late transcript still joins it)
      this.userSpeaking = false;
    }
    return this.cur;
  }

  onAudio(d) {
    const t = this.coachTurn();
    if (t.cut || this.ending && this.endReason === "user") return;
    t.audio = true;
    this.play(d.data, d.mimeType);
    this.setState("speaking");
  }

  onCoachText(txt) {
    const t = this.coachTurn();
    if (t.cut) return; // v1.6: rest of a cut turn is ignored
    t.partial += txt;
    if (!t.echoChecked) {
      const head = t.partial.replace(/^[\s"'“”‘’\[\]()]+/, "").toLowerCase();
      if (head.startsWith("producer note")) { t.echoChecked = true; return this.cutNoteEcho(t); }
      if (head.length >= 13 || !"producer note".startsWith(head)) t.echoChecked = true;
    }
    if (thinkingAloud(t.partial)) return this.cutNoteEcho(t, "thinking aloud");
    this.on.caption && this.on.caption("assistant", stripNotes(t.partial), false);
  }

  // v1.6/v2.1 on Gemini: there is no response.cancel. Stop the play queue and ignore the rest of the turn; send nothing
  // (the learner's next audio moves the call on). The turn is never captioned or graded.
  cutNoteEcho(t, why = "producer note") {
    this.log(why === "producer note" ? "coach started reading a producer note: cutting it" : "cut a coach turn (" + why + ")");
    t.cut = true; t.partial = "";
    this.stopPlayback("note echo");
    this.noteEchoCuts++;
    this.o.store && this.o.store.patch({ note_echo_cuts: this.noteEchoCuts });
    this.on.caption && this.on.caption("assistant", "", false);
  }

  onInterrupted() {
    this.stats.interrupts++;
    const n = this.stopPlayback("interrupted");
    this.log(`interrupted: cleared ${n} queued audio chunks, queue now ${this.sources.size}`);
    this.userSpeaking = true; this.lastUserAt = this.clock.now();
    this.finishCoachTurn("interrupted");
    if (!this.ending) this.setState("you");
  }

  finishCoachTurn(why) {
    const t = this.cur;
    if (!t) return;
    this.cur = null;
    if (this.userTurn && this.userTurn.closing) this.saveUser();
    if (t.cut) {
      if (!this.playing() && !this.ending) this.setState("listening");
      return;
    }
    const raw = t.partial.replace(/\s+/g, " ").trim();
    const text = stripNotes(raw);
    if (text !== raw) this.log("dropped bracketed text from a coach turn");
    if (text) {
      this.saveTurn({ role: "assistant", text, ...(raw !== text ? { raw_text: raw } : {}), t_start_ms: t.t_start_ms, t_end_ms: this.elapsedMs() });
      this.on.caption && this.on.caption("assistant", text, true);
    }
    if (this.afterFinal && t.finalReply && !this.ending && why === "complete" && t.audio) { // v2.0: a turn that carried audio
      this.log("final reply complete"); this.ending = true; this.endReason = "final_reply"; this.setState("closing");
      clearTimeout(this.endTimer); this.endTimer = setTimeout(() => this.hangUp(this.endReason), 12000);
    }
    if (this.ending) { if (!this.playing()) this.finishSoon(600); return; }
    if (!this.playing()) this.setState(this.userSpeaking ? "you" : "listening");
  }

  onUserText(txt) {
    let u = this.userTurn;
    if (u && u.closing && this.cur && this.elapsedMs() - this.cur.t_start_ms > LATE_TX_MS) { this.saveUser(); u = null; } // barge-in
    if (u && u.closing && !this.cur) { this.saveUser(); u = null; }
    if (!u) { u = this.userTurn = { role: "user", t_start_ms: this.elapsedMs(), text: "", closing: false, entry: { text: "", at: 0 } }; this.userTexts.push(u.entry); }
    u.text += txt; u.t_end_ms = this.elapsedMs(); u.entry.text = u.text; u.entry.at = u.t_end_ms; // v2.2 guard reads userTexts
    this.userSpeaking = !u.closing; this.lastUserAt = this.clock.now();
    if (!this.cur && !this.playing() && !this.ending) this.setState("you");
    this.on.caption && this.on.caption("user", u.text.replace(/\s+/g, " ").trim(), false);
  }

  saveUser() {
    const u = this.userTurn; this.userTurn = null;
    if (!u) return;
    const text = u.text.replace(/\s+/g, " ").trim();
    if (!text) return;
    this.saveTurn({ role: "user", text, t_start_ms: u.t_start_ms, t_end_ms: u.t_end_ms || this.elapsedMs() });
    this.on.caption && this.on.caption("user", text, true);
  }

  saveTurn(turn) {
    const idx = this.nextIdx++;
    if (!this.o.store) return;
    const p = (async () => {
      try { await this.o.store.saveTurn({ idx, ...turn, item_id: "g" + idx }); } catch (e) { this.log("save turn failed: " + e.message); }
      this.o.store.patch({ next_idx: this.nextIdx, elapsed_ms: this.elapsedMs() });
    })();
    this.pendingSaves.add(p); p.finally(() => this.pendingSaves.delete(p));
  }

  toolCall(fc) {
    const id = fc.id, name = fc.name;
    if (id && this.seenCalls.has(id)) return;
    if (id) this.seenCalls.add(id);
    let args = fc.args || {};
    if (typeof args === "string") { try { args = JSON.parse(args); } catch (_) { args = {}; } }
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
      this.log("end_session refused: " + (args.reason || ""));
      output = { ok: false, reason: "the producer ends the call" };
    } else if (name === "end_session" && !this.endTapped && !heSaidLeaving(this.userTexts, this.elapsedMs())) {
      this.log("end_session user_ended refused: no leaving phrase");
      output = REFUSE_NOT_LEAVING;
    } else if (name === "end_session") {
      this.log("end_session: " + args.reason);
      this.ending = true; this.endReason = "coach:" + args.reason; this.setState("closing");
      // Hang up once the goodbye turn has completed and played (finishCoachTurn / drained), 12 s safety.
      clearTimeout(this.endTimer); this.endTimer = setTimeout(() => this.hangUp(this.endReason), 12000);
    } else {
      output = { ok: false, error: "unknown tool " + name };
    }
    this.send({ toolResponse: { functionResponses: [{ id, name, response: output }] } });
  }

  // ---- playback ----------------------------------------------------------------------------------
  play(b64, mime) {
    const ctx = this.ctx; if (!ctx || this.closed) return;
    const rate = Number((/rate=(\d+)/.exec(mime || "") || [])[1]) || OUT_RATE;
    const f = b64ToFloat32(b64); if (!f.length) return;
    const ab = ctx.createBuffer(1, f.length, rate);
    ab.getChannelData(0).set(f);
    const s = ctx.createBufferSource(); s.buffer = ab; s.connect(this.outGain);
    const now = ctx.currentTime;
    if (this.playhead < now + 0.02) this.playhead = now + 0.06; // small lead so chunks join without clicks
    s.start(this.playhead); this.playhead += ab.duration;
    this.sources.add(s);
    s.onended = () => { this.sources.delete(s); if (!this.sources.size) this.drained(); };
  }
  stopPlayback(why) {
    const n = this.sources.size;
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch (_) {} try { s.disconnect(); } catch (_) {} }
    this.sources.clear(); this.playhead = 0; this.stats.cleared += n;
    if (n && why) this.log("playback stopped: " + why);
    return n;
  }
  drained() {
    if (this.closed) return;
    if (this.ending) { if (!this.cur) this.finishSoon(600); return; }
    if (!this.cur) this.setState(this.userSpeaking ? "you" : "listening");
  }

  // ---- reconnect -----------------------------------------------------------------------------------
  onGoAway(g) {
    this.log("goAway timeLeft " + (g.timeLeft || "?"));
    if (this.closed || this.reconnecting || this.pendingReconnect) return;
    this.pendingReconnect = true; // done on the next tick once the coach's turn is over, or just before time runs out
    this.reconnectBy = this.clock.now() + Math.max(0, Math.min(durMs(g.timeLeft) || 5000, 8000) - 1000);
  }

  onSocketClosed(e) {
    this.log(`socket closed ${e.code} ${String(e.reason || "").slice(0, 80)}`);
    if (this.closed || this.reconnecting) return;
    if (QUOTA_RE.test(e.reason || "")) return this.drop("free voice limit reached");
    if (this.ending) return this.finishSoon(600);
    if (this.handleId) return this.reconnect("socket closed");
    this.hangUp("dropped"); // CONTRACT 2.0.3 step 4: no handle -> end and grade what we have
  }

  async reconnect(why) {
    if (this.closed || this.reconnecting) return;
    this.pendingReconnect = false; this.reconnecting = true; this.reconnects++;
    if (this.cur) this.finishCoachTurn("reconnect"); // keep what was said so far; queued audio keeps playing
    const old = this.ws; this.wsGen++; this.ready = false;
    try { old && old.readyState <= 1 && old.close(1000, "reconnect"); } catch (_) {}
    if (!this.handleId) { this.reconnecting = false; this.log("no resume handle"); return this.hangUp("dropped"); }
    try {
      // CONTRACT v2.0 (PROVEN): tokens are single-use, so every reconnect first mints {resume_session_id} for a new one.
      if (this.o.remint) this.mintCur = { ...this.mintCur, ...(await this.o.remint()) };
      try { await this.connectOnce(this.handleId); }
      catch (e) { // one retry with another fresh token (1011 "used too many times" / deadline exceeded)
        if (e instanceof QuotaError || !this.o.remint) throw e;
        this.log("reconnect refused (" + e.message + "): one more fresh token");
        this.mintCur = { ...this.mintCur, ...(await this.o.remint()) };
        await this.connectOnce(this.handleId);
      }
      this.reconnecting = false;
      this.log(`reconnected after ${why} (#${this.reconnects})`);
      this.o.store && this.o.store.patch({ gemini_reconnects: this.reconnects });
      if (!this.cur && !this.playing() && !this.ending) this.setState("listening");
    } catch (e) {
      this.reconnecting = false;
      this.log("could not reconnect (" + e.message + ")");
      // CONTRACT 2.0.3 step 4: the mint or the socket failed -> end and grade what we have.
      if (e instanceof QuotaError || (e && e.status === 429)) this.drop("free voice limit reached");
      else this.hangUp("dropped");
    }
  }

  // ---- ending --------------------------------------------------------------------------------------
  finishSoon(ms) { clearTimeout(this.finTimer); this.finTimer = setTimeout(() => this.hangUp(this.endReason || "coach"), ms); }

  flushTurns() {
    // Save whatever is still open, in time order (a learner turn first if it started first).
    const c = this.cur && !this.cur.cut ? this.cur : null;
    if (this.userTurn && (!c || this.userTurn.t_start_ms <= c.t_start_ms)) this.saveUser();
    if (c) { this.cur = null; const text = stripNotes(c.partial.replace(/\s+/g, " ").trim()); if (text) this.saveTurn({ role: "assistant", text, t_start_ms: c.t_start_ms, t_end_ms: this.elapsedMs() }); }
    if (this.userTurn) this.saveUser();
    this.cur = null;
  }

  cleanup() {
    clearInterval(this.tick); clearTimeout(this.endTimer); clearTimeout(this.finTimer);
    this.wsGen++; this.ready = false;
    try { this.ws && this.ws.close(1000, "bye"); } catch (_) {}
    try { this.micNode && (this.micNode.port.onmessage = null, this.micNode.disconnect()); } catch (_) {}
    try { this.micSrc && this.micSrc.disconnect(); } catch (_) {}
    try { this.micSink && this.micSink.disconnect(); } catch (_) {}
    this.stopPlayback();
    if (this.ownCtx && this.ctx) this.ctx.close().catch(() => {});
  }

  hangUp(reason) {
    if (this.closed) return;
    this.flushTurns();
    this.closed = true; this.ending = true;
    this.cleanup();
    this.setState("ended");
    const ms = this.elapsedMs();
    Promise.allSettled([...this.pendingSaves]).then(() => this.on.ended && this.on.ended(reason || "user", ms));
  }

  drop(reason) {
    if (this.closed) return;
    this.flushTurns();
    this.closed = true;
    this.cleanup();
    this.setState("dropped");
    const ms = this.elapsedMs();
    Promise.allSettled([...this.pendingSaves]).then(() => this.on.dropped && this.on.dropped(reason, ms));
  }
}
