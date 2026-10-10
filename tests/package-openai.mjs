import assert from "node:assert/strict";
import { packageEntries, validatePackage, zipEntries } from "../scripts/package-openai.mjs";

const { manifest, entries } = packageEntries();
const mcp = JSON.parse(entries.get("mcp.json"));
const names = [...entries.keys()];
validatePackage(manifest, mcp, names);
const first = zipEntries(entries);
assert.deepEqual(first, zipEntries(new Map([...entries].reverse())), "ZIP is independent of insertion order");
assert.equal(first.readUInt32LE(0), 0x04034b50);
assert.equal(first.readUInt32LE(first.length - 22), 0x06054b50);

// Parse local records and verify the exact shipped bytes and paths.
let cursor = 0;
const shipped = new Map();
while (first.readUInt32LE(cursor) === 0x04034b50) {
  const size = first.readUInt32LE(cursor + 18);
  const nameSize = first.readUInt16LE(cursor + 26);
  const extraSize = first.readUInt16LE(cursor + 28);
  const name = first.subarray(cursor + 30, cursor + 30 + nameSize).toString();
  const start = cursor + 30 + nameSize + extraSize;
  shipped.set(name, first.subarray(start, start + size));
  cursor = start + size;
}
assert.deepEqual([...shipped.keys()], names.sort());
for (const [name, bytes] of entries) assert.deepEqual(shipped.get(name), bytes);

for (const key of ["hooks", "apps", "clientSecret", "test_credentials", "reviewer_instructions"]) {
  const bad = structuredClone(manifest);
  bad.extensions["com.openai"][key] = {};
  assert.throws(() => validatePackage(bad, mcp, names), /Forbidden package field/);
}
assert.throws(() => validatePackage(manifest, mcp, [...names, "hooks/hooks.json"]), /allowlist/);
const header = structuredClone(mcp);
header.mcpServers.coralswarm.headers = { Authorization: "Bearer placeholder" };
assert.throws(() => validatePackage(manifest, header, names), /headers/);
const extra = structuredClone(mcp);
extra.mcpServers.another = extra.mcpServers.coralswarm;
assert.throws(() => validatePackage(manifest, extra, names), /Exactly one/);
const apiKey = structuredClone(mcp);
apiKey.mcpServers.coralswarm.extensions["com.openai"].auth.type = "api_key";
assert.throws(() => validatePackage(manifest, apiKey, names), /OAuth/);
console.log("✓ OpenAI directory package: exact payload, reproducibility and rejection checks passed");
