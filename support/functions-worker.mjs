#!/usr/bin/env node
// Firenook Functions worker: one Node process per codebase. The Rust runtime
// starts it with the codebase's environment, forwards every invocation over
// loopback HTTP with `x-firenook-target`, `x-firenook-signature` and
// `x-firenook-service` control headers, and reads this process's stdout for
// the readiness line and for log lines.
//
// The request handling mirrors firebase-tools 15.22.0
// `functionsEmulatorRuntime.js` (Express with `trust proxy`, JSON / text /
// urlencoded / raw body parsing with a 32 MB limit and `rawBody`, `http`,
// `event` and `cloudevent` signatures) so the firebase-functions SDK observes
// the same request objects. Express and body-parser are resolved from the
// codebase's own firebase-functions dependency tree; nothing is bundled.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const sourceDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const codebase = process.argv[3] ?? "default";
const require = createRequire(path.join(sourceDir, "package.json"));
const CONTROL_HEADERS = ["x-firenook-target", "x-firenook-signature", "x-firenook-service"];
const BODY_LIMIT = "32mb";

let functionModule;
let ready = false;

function log(level, message) {
  process.stdout.write(`FIRENOOK_WORKER_LOG ${JSON.stringify({ level, message: String(message) })}\n`);
}

function fatal(message) {
  process.stdout.write(`FIRENOOK_WORKER_FATAL ${JSON.stringify({ message: String(message) })}\n`);
  process.exit(1);
}

function findModuleRoot(moduleName, filePath) {
  // `findModuleRoot`: walk up from a resolved file to the package directory.
  let current = path.dirname(filePath);
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
      if (pkg.name === moduleName) return current;
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolveFromSdk(name) {
  // firebase-functions depends on express (which bundles body-parser); resolve
  // from its real location so a codebase without a direct express dependency
  // still gets the versions the SDK was built against. The package's
  // `exports` map hides package.json, so resolve the entry and walk up.
  let sdkRoot;
  try {
    sdkRoot = findModuleRoot("firebase-functions", fs.realpathSync(require.resolve("firebase-functions")));
  } catch {
    sdkRoot = undefined;
  }
  if (sdkRoot) {
    const sdkRequire = createRequire(path.join(sdkRoot, "package.json"));
    try {
      return sdkRequire(name);
    } catch {
      // fall through to the codebase's own resolution
    }
  }
  return require(name);
}

async function loadModule() {
  try {
    return require(sourceDir);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code !== "ERR_REQUIRE_ESM" && code !== "ERR_REQUIRE_ASYNC_MODULE") throw error;
  }
  const entry = require.resolve(sourceDir);
  return import(pathToFileURL(entry).href);
}

function resolveTarget(target) {
  return target.split(".").reduce((module, part) => (module ? module[part] : undefined), functionModule);
}

// --- CloudEvent helpers (emulator/events/types.js) ---------------------------
function isBinaryCloudEvent(request) {
  return Boolean(request.header("ce-type") && request.header("ce-specversion") && request.header("ce-source") && request.header("ce-id"));
}

function extractBinaryCloudEventContext(request) {
  const context = {};
  for (const name of Object.keys(request.headers)) {
    if (name.startsWith("ce-")) context[name.slice(3)] = request.headers[name];
  }
  return context;
}

// --- Invocation ---------------------------------------------------------------
async function runBackground(trigger, body, signature) {
  if (signature === "cloudevent") {
    await trigger(body);
    return;
  }
  const data = body.data;
  delete body.data;
  const context = body.context ? body.context : body;
  if (!body.eventType || !String(body.eventType).startsWith("google.storage")) {
    if (context.resource && context.resource.name) context.resource = context.resource.name;
  }
  await trigger(data, context);
}

function errorMessage(error) {
  if (error && typeof error === "object") return error.stack || error.message || String(error);
  return String(error);
}

async function main() {
  const express = resolveFromSdk("express");
  functionModule = await loadModule();
  const app = express();
  app.enable("trust proxy");
  const rawBodySaver = (request, _response, buffer) => {
    request.rawBody = buffer;
  };
  app.use(express.json({ limit: BODY_LIMIT, verify: rawBodySaver }));
  app.use(express.text({ limit: BODY_LIMIT, verify: rawBodySaver }));
  app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT, verify: rawBodySaver }));
  app.use(express.raw({ type: "*/*", limit: BODY_LIMIT, verify: rawBodySaver }));
  app.get("/__/health", (_request, response) => {
    response.status(200).send();
  });
  app.post("/__/quit", (_request, response) => {
    response.status(200).send();
    setTimeout(() => process.exit(0), 20);
  });
  // Express 4 (firebase-functions ≤ 7.2) and Express 5 (firebase-functions
  // ≥ 7.3) resolve from the codebase; the official runtime's "/*" and
  // "/favicon.ico|/robots.txt" patterns are path-to-regexp 0.x syntax that
  // Express 5 rejects, so the same routes are declared in the syntax both
  // accept.
  for (const path of ["/favicon.ico", "/robots.txt"]) {
    app.all(path, (_request, response) => {
      response.status(404).send();
    });
  }
  app.all(/.*/, async (request, response) => {
    const target = request.header("x-firenook-target") || process.env.FUNCTION_TARGET || "";
    const signature = request.header("x-firenook-signature") || process.env.FUNCTION_SIGNATURE_TYPE || "http";
    const service = request.header("x-firenook-service") || process.env.K_SERVICE || target;
    for (const name of CONTROL_HEADERS) delete request.headers[name];
    // The environment a handler observes for this invocation, set before any
    // user code runs (one worker serves every function of the codebase). The
    // official debug-mode runtime (`--inspect-functions`) serves every
    // function from one process and leaves these unset.
    if (process.env.FUNCTION_DEBUG_MODE !== "true") {
      process.env.FUNCTION_TARGET = target;
      process.env.FUNCTION_SIGNATURE_TYPE = signature;
      process.env.K_SERVICE = service;
    }
    try {
      const trigger = resolveTarget(target);
      if (typeof trigger !== "function") throw new Error(`Failed to find function ${target} in the loaded module`);
      switch (signature) {
        case "event":
        case "cloudevent": {
          let body;
          if (isBinaryCloudEvent(request)) {
            body = extractBinaryCloudEventContext(request);
            body.data = request.body;
          } else {
            body = JSON.parse(request.rawBody ? request.rawBody.toString() : "{}");
          }
          await runBackground(trigger, body, signature);
          response.send({ status: "acknowledged" });
          break;
        }
        default:
          await trigger(request, response);
      }
    } catch (error) {
      log("ERROR", errorMessage(error));
      if (!response.headersSent) {
        // A background handler failure ends the official worker; the runtime
        // turns this marker into the same dropped-connection answer.
        if (signature === "event" || signature === "cloudevent") response.set("x-firenook-handler-error", "1");
        response.status(500).send(error && typeof error === "object" && error.message ? error.message : String(error));
      } else {
        response.end();
      }
    }
  });
  const server = app.listen(0, "127.0.0.1", () => {
    ready = true;
    process.stdout.write(`FIRENOOK_WORKER_READY ${JSON.stringify({ port: server.address().port, codebase, pid: process.pid, node: process.versions.node })}\n`);
  });
  server.keepAliveTimeout = 65000;
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

process.on("uncaughtException", (error) => {
  log("ERROR", `Uncaught exception: ${errorMessage(error)}`);
});
process.on("unhandledRejection", (reason) => {
  log("ERROR", `Unhandled rejection: ${errorMessage(reason)}`);
});

main().catch((error) => {
  if (!ready) {
    fatal(`Failed to initialize and load triggers: ${errorMessage(error)}`);
  } else {
    log("ERROR", errorMessage(error));
  }
});
