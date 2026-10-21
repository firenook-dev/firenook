// Runs a test file written for Vitest (the console's exported
// rules-unit-testing files) under `node --test`: `import ... from 'vitest'`
// resolves to node:test's equivalents. Load with `--import`.
import { registerHooks } from 'node:module';

const shim = `data:text/javascript,${encodeURIComponent(
  "export { test, beforeEach, afterEach, describe, it } from 'node:test';\n" +
  "export { before as beforeAll, after as afterAll } from 'node:test';\n",
)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'vitest' ? { url: shim, shortCircuit: true } : nextResolve(specifier, context);
  },
});
