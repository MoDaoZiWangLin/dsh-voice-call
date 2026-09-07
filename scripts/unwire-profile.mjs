// unwire-profile.mjs — idempotently remove a plugin dependency + bundle entry
// from a DSH profile package.json. Usage:
//   node scripts/unwire-profile.mjs <path/to/profile/package.json> <packageName>
import { readFileSync, writeFileSync } from "node:fs";

const [profilePath, pkgName] = process.argv.slice(2);
if (!profilePath || !pkgName) {
  console.error("usage: node unwire-profile.mjs <profile/package.json> <pkgName>");
  process.exit(2);
}

const json = JSON.parse(readFileSync(profilePath, "utf8"));

if (json.dependencies && pkgName in json.dependencies) {
  delete json.dependencies[pkgName];
  if (Object.keys(json.dependencies).length === 0) delete json.dependencies;
}

if (json.dsh?.profile?.bundles) {
  json.dsh.profile.bundles = json.dsh.profile.bundles.filter((b) => b !== pkgName);
  if (json.dsh.profile.bundles.length === 0) delete json.dsh.profile.bundles;
  if (Object.keys(json.dsh.profile).length === 0) delete json.dsh.profile;
  if (Object.keys(json.dsh).length === 0) delete json.dsh;
}

writeFileSync(profilePath, JSON.stringify(json, null, 2) + "\n");
console.log(`unwired "${pkgName}" from ${profilePath}`);
