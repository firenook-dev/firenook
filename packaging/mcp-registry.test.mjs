import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { manifest } from '../packages/cli/src/binary.mjs';

const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));

test('the MCP Registry entry names the published package at its version', () => {
  // The registry refuses an entry unless the npm version carries this name.
  assert.equal(server.name, manifest.mcpName);
  assert.equal(server.version, manifest.version);
  assert.equal(server.packages.length, 1);
  const [entry] = server.packages;
  assert.equal(entry.registryType, 'npm');
  assert.equal(entry.identifier, manifest.name);
  assert.equal(entry.version, manifest.version);
  // `npx firenook` alone is the CLI; the MCP server is `firenook mcp`.
  assert.deepEqual(entry.packageArguments, [{type: 'positional', value: 'mcp'}]);
  assert.ok(server.description.length <= 100, 'the registry limits the description to 100 characters');
});
