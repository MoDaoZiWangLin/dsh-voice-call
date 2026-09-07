// e2e-test.mjs — real end-to-end check of the voice turn pipeline:
//   engine STT (SenseVoice) -> volcengine LLM stream -> engine TTS -> SSE audio frames.
// Run from the installed copy (needs @deepseek-ai/dsh-credentials resolution):
//   node node_modules/dsh-voice-call/scripts/e2e-test.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const plugin = await import(pathToFileURL(join(here, "..", "index.js")).href);
const { VoiceService, DEFAULTS } = plugin;

// pull the real volcengine key out of the credentials document (test only)
function readKey() {
  const text = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
  const m = text.match(/^\s*VOLCENGINE_API_KEY\s*:\s*["']?([A-Za-z0-9_\-\.]+)/m);
  if (!m) throw new Error("no VOLCENGINE_API_KEY in credentials");
  return m[1];
}

const fakeCtx = {
  credentials: { async resolve() { return { value: readKey(), source: "test" }; } },
  logger: { warn() {}, error() {} },
};

const service = new VoiceService(fakeCtx, { ...DEFAULTS, enginePort: 18765 });

// use a real speech sample from the SenseVoice model
const wav = readFileSync(join(homedir(), ".dsh", "plugins", "dsh-voice-call", "models",
  "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17", "test_wavs", "zh.wav"));

const frames = [];
const events = [];
const sse = (f) => { events.push(f); if (f.type === "audio") frames.push(f); };

const t0 = Date.now();
await service.talk(wav, sse);
const ms = Date.now() - t0;

const audioBytes = frames.reduce((n, f) => n + Math.ceil((f.b64?.length || 0) * 3 / 4), 0);
const userEv = events.find((e) => e.type === "user");
const llmEv = events.find((e) => e.type === "llm");
const doneEv = events.find((e) => e.type === "done");
const errEv = events.find((e) => e.type === "error");

console.log(`ms=${ms}  user=${userEv ? JSON.stringify(userEv.text) : "NONE"}  llm=${llmEv ? JSON.stringify(llmEv.text) : "NONE"}`);
console.log(`audioFrames=${frames.length}  audioBytes=${audioBytes}  done=${!!doneEv}  error=${errEv ? errEv.message : "none"}`);

if (!userEv || !llmEv) { console.error("E2E FAIL: no transcript"); process.exit(1); }
if (frames.length === 0 || audioBytes < 1000) { console.error("E2E FAIL: no audio frames reached the client path"); process.exit(1); }
if (errEv) { console.error("E2E FAIL: " + errEv.message); process.exit(1); }
console.log("E2E PASS");
process.exit(0);
