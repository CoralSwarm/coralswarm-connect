#!/usr/bin/env node
// Explicit allowlist: never package the repository's capture hooks or skills.
import { readFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const json = (path) => JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
const fail = (message) => { throw new Error(message); };

export function validatePackage(manifest, mcp, names) {
  const allowed = ["LICENSE", "assets/marketplace-logo.svg", "mcp.json", "plugin.json", "skills/coralswarm/SKILL.md"];
  if (JSON.stringify([...names].sort()) !== JSON.stringify(allowed)) fail("Package entries must match the directory allowlist");
  function inspect(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (["hooks", "apps", "clientSecret", "test_credentials", "reviewer_instructions"].includes(key)) fail(`Forbidden package field: ${key}`);
      inspect(item);
    }
  }
  inspect(manifest); inspect(mcp);
  if (manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") fail("Portable plugin schema required");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name) || manifest.name.length > 64) fail("Invalid plugin name");
  const ext = manifest.extensions?.["com.openai"];
  const ui = ext?.interface;
  for (const [key, limit] of Object.entries({ displayName: 30, shortDescription: 30, longDescription: 4000, developerName: 80, category: 120 })) {
    if (typeof ui?.[key] !== "string" || !ui[key].trim() || ui[key].length > limit) fail(`Invalid listing ${key}`);
  }
  for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    const url = new URL(ui[key]);
    if (url.protocol !== "https:" || url.username || url.password) fail(`Invalid public URL: ${key}`);
  }
  for (const key of ["composerIcon", "logo"]) {
    if (ui[key] !== "./assets/marketplace-logo.svg") fail(`Unpackaged asset: ${key}`);
  }
  if (ext.onboardingSkill !== "./skills/coralswarm/SKILL.md") fail("Unpackaged onboarding skill");
  if (!Array.isArray(ui.defaultPrompt) || ui.defaultPrompt.length > 3 || ui.defaultPrompt.some(p => typeof p !== "string" || p.length > 128)) fail("Invalid starter prompts");
  const cases = ext.review?.test_cases;
  for (const [kind, count] of [["positive", 5], ["negative", 3]]) {
    if (!Array.isArray(cases?.[kind]) || cases[kind].length !== count) fail(`Need ${count} ${kind} cases`);
    for (const item of cases[kind]) {
      for (const key of ["description", "prompt", "tools_triggered", "expected_behavior"]) {
        if (typeof item[key] !== "string" || !item[key].trim()) fail(`Incomplete ${kind} case: ${key}`);
      }
    }
  }
  if (mcp.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json") fail("Portable MCP schema required");
  const servers = Object.entries(mcp.mcpServers ?? {});
  if (servers.length !== 1 || servers[0][0] !== "coralswarm") fail("Exactly one CoralSwarm server required");
  const server = servers[0][1];
  if (server.url !== "https://api.coralswarm.com/mcp" || server.type !== "streamable-http") fail("Wrong public MCP endpoint or transport");
  if (server.command || (server.headers && Object.keys(server.headers).length)) fail("No local MCP or nonempty headers allowed");
  const auth = server.extensions?.["com.openai"]?.auth;
  if (auth?.type !== "oauth" || auth.client?.mode !== "dcr") fail("OAuth DCR required");
}

export function packageEntries() {
  const manifest = json("marketplace/openai/plugin.json");
  // Reuse the release version; no fifth manually synchronized version field.
  manifest.version = json(".claude-plugin/plugin.json").version;
  const mcp = json("marketplace/openai/mcp.json");
  const entries = new Map([
    ["plugin.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n")],
    ["mcp.json", Buffer.from(JSON.stringify(mcp, null, 2) + "\n")],
  ]);
  for (const [name, source] of [["LICENSE", "LICENSE"], ["assets/marketplace-logo.svg", "assets/marketplace-logo.svg"], ["skills/coralswarm/SKILL.md", "marketplace/openai/skills/coralswarm/SKILL.md"]]) {
    const path = resolve(ROOT, source);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail(`Regular source file required: ${source}`);
    entries.set(name, readFileSync(path));
  }
  validatePackage(manifest, mcp, [...entries.keys()]);
  return { manifest, entries };
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipEntries(entries) {
  // ZIP STORE with fixed 1980-01-01 timestamps, no host metadata, sorted entries.
  const local = [], central = [];
  let offset = 0;
  for (const [name, bytes] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const path = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(path.length, 26);
    local.push(header, path, bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    header.copy(directory, 8, 6, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, path);
    offset += header.length + path.length + bytes.length;
  }
  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { manifest, entries } = packageEntries();
    if (process.argv.length !== 3) fail("Usage: node scripts/package-openai.mjs /absolute/output.zip");
    const output = resolve(process.argv[2]);
    const withinRepo = relative(ROOT, output);
    if (!withinRepo.startsWith("..") && !withinRepo.startsWith("/")) fail("Write generated ZIP outside the git checkout");
    if (!output.endsWith(".zip")) fail("Output must end with .zip");
    const bytes = zipEntries(entries);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, bytes, { flag: "wx" });
    console.log(JSON.stringify({ path: output, version: manifest.version, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, entries: [...entries.keys()].sort() }, null, 2));
    console.log("Local package checks passed. Reviewer login, live cases, video, domain verification and portal scans remain required.");
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
