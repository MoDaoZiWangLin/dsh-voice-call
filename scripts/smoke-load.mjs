// smoke-load.mjs — load the plugin exactly the way cordis will at boot and
// assert it can apply. Run inside the DSH environment (needs @deepseek-ai/dsh-credentials).
//   node scripts/smoke-load.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = await import(pathToFileURL(join(root, "index.js")).href);

// 1) cordis resolveConfig() emulation — the exact branch that crashed before:
//    a plugin WITHOUT `Config` is passed through; a plain-object Config would
//    crash on Config["~standard"].validate.
if (plugin.Config !== undefined) {
  const standard = plugin.Config["~standard"];
  if (standard === undefined || typeof standard.validate !== "function") {
    throw new Error("smoke: plugin exports a Config that is not a Standard Schema — cordis will crash on resolveConfig");
  }
  console.log("smoke: Config is a Standard Schema (ok)");
} else {
  console.log("smoke: no Config export — cordis resolveConfig passes through (ok)");
}

// 2) apply() with a minimal cordis-like ctx.
const registered = [];
const disposers = [];
const fakeCtx = {
  effect(fn) {
    const ret = fn();
    disposers.push(() => { if (typeof ret === "function") ret(); });
    return () => { if (typeof ret === "function") ret(); };
  },
  webServer: {
    register(route) { registered.push(route); return () => {}; },
  },
  credentials: {
    async resolve() { return undefined; },
  },
  logger: {
    warn() {}, error() {},
  },
};

await plugin.apply(fakeCtx, {});

const expect = ["/api/dsh-voice/status", "/api/dsh-voice/talk", "/api/dsh-voice/interrupt", "/api/dsh-voice/reset", "/api/dsh-voice/diag"];
const got = registered.map((r) => r.path);
for (const path of expect) {
  if (!got.includes(path)) throw new Error(`smoke: route ${path} not registered`);
}
console.log(`smoke: apply() ok — ${got.length} routes registered (${got.join(", ")})`);

// tear down like cordis would (kills the spawned engine so node can exit)
for (const dispose of disposers) {
  try { dispose(); } catch {}
}
console.log("smoke: PASS");
process.exit(0);
