// English Coach client config. Fill these in before deploying.
// The anon/publishable key is safe in a browser: every table is guarded by row-level security.
export const SUPABASE_URL = "https://uankrnrpsubmpwbdzcgh.supabase.co";      // e.g. https://uankrnrpsubmpwbdzcgh.supabase.co
export const SUPABASE_ANON_KEY = "sb_publishable_-QnydcOdcCZyKfptb6WNsg_DcZd1mrm";
export const FUNCTIONS_URL = SUPABASE_URL + "/functions/v1";           // mint-session, grade-session live here

// Where the browser sends its SDP offer (OpenAI Realtime WebRTC, verified in the docs 21 Oct 2026).
export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

// v0.3: Gemini Live over WebSocket with an ephemeral token (docs: live-api/get-started-websocket, read 26 Oct 2026).
// Fallback only: mint-session returns ws_url and the client appends ?access_token=<token>.
export const GEMINI_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
// Voice engines for Settings (profiles.voice_engine). Gemini is the default (free tier); OpenAI is the paid switch.
export const VOICE_ENGINES = [
  { id: "gemini", label: "Gemini (free)", tag: "free" },
  { id: "openai", label: "OpenAI (paid)", tag: "paid" },
];
export const DEFAULT_ENGINE = "gemini";
export const FREE_LIMIT_MSG = "Free voice limit reached for today. Try Quick 3 later, or switch to the paid voice in Settings.";

// Session timing (seconds). Fallback only: the plan's time_checks [{at_s, kind, text}] and hard_stop_s win.
// CONTRACT v3.0 kinds: replay (text null: the client builds it from replay-plan, replay.js) | close | final.
// (The v1.x "switch" kind is gone; an old plan that still has one is handled as before.) With the final note the client
// ends the call itself once the coach's reply completes (or 40 s with no reply).
export const TIME_CHECKS = [
  { at: 300, kind: "replay", text: "", max_items: 5 },
  { at: 540, kind: "close", text: "[Producer note: start closing now. Say you will need to head off soon, name one specific thing he did well today, and ask one last small question. Do not end yet.]" },
  { at: 585, kind: "final", text: "[Producer note: final turn. One thing to try tomorrow and a question about his real life for tomorrow. This is the last thing you say; the producer ends the call.]" },
];
export const HARD_STOP_S = 660;
export const RESUME_WINDOW_MS = 10 * 60 * 1000;   // a dropped call can be resumed within 10 minutes
export const DAILY_TARGET_DAYS = 5;                // practice days per week target (loop card metric)
export const SPEECH_LANG = "en-AU";                // phrase preview voice (speechSynthesis fallback)

// Optional UX-only allow-list. The REAL allow-list is enforced server-side (RLS + mint-session).
export const ALLOWED_EMAILS = [];                  // e.g. ["vivs21084@gmail.com"]; empty = do not check in the client

// v0.2 settings choices. Voices: the list on developers.openai.com realtime-conversations guide, read 26 Oct 2026
// ("alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar"; marin and cedar recommended).
export const MODELS = [
  { id: "gpt-realtime-2.1", label: "Full (best)" },
  { id: "gpt-realtime-2.1-mini", label: "Mini (cheaper)" },
];
export const DEFAULT_MODEL = "gpt-realtime-2.1";
export const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"];

// Mic level check before every connect (Class Bridge lesson: measure the level, never ask him to test by ear).
// The mic is sampled for MIC_CHECK_MS; if no 50 ms window has an RMS above MIC_SILENT_RMS the line is treated as dead.
// 0.0008 is well above digital silence (a muted or switched-off mic reads 0) and below a quiet room. UNVERIFIED on iPhone:
// the measured peak is kept in localStorage "evc.micRms" so the first real sessions can calibrate it.
export const MIC_CHECK_MS = 2500;
export const MIC_SILENT_RMS = 0.0003; // 29 Oct: 0.0008 false-alarmed on Vivek's iPhone in a quiet room
