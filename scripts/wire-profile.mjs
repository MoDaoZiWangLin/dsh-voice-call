// wire-profile.mjs — idempotently add a plugin dependency + bundle entry to a
// DSH profile package.json. Usage:
//   node scripts/wire-profile.mjs <path/to/profile/package.json> <packageName>
import { readFileSync, writeFileSync } from "node:fs";

const [profilePath, pkgName] = process.argv.slice(2);
if (!profilePath || !pkgName) {
  console.error("usage: node wire-profile.mjs <profile/package.json> <pkgName>");
  process.exit(2);
}

const json = JSON.parse(readFileSync(profilePath, "utf8"));

const deps = json.dependencies ?? {};
if (!(pkgName in deps)) {
  deps[pkgName] = `file:../../plugins/${pkgName}`;
  json.dependencies = deps;
}

const profile = json.dsh?.profile ?? {};
const bundles = profile.bundles ?? [];
if (!bundles.includes(pkgName)) {
  profile.bundles = [...bundles, pkgName];
  json.dsh.profile = profile;
}

writeFileSync(profilePath, JSON.stringify(json, null, 2) + "\n");
console.log(`wired "${pkgName}" into ${profilePath}`);
