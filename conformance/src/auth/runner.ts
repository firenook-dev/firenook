// Phase I: the step executor and the recording functions stub shared by the
// official-emulator capture and the Fireside replay, so both sides record
// and normalize a step identically.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";

import { encodeUnsignedJwt, type Json, type Step, type StubResponse } from "./emulator-plan.ts";
import { Registry, canonicalize, finish, normalizeLogLine, normalizeValue, sortUnordered } from "./normalize.ts";

export const HOST = "127.0.0.1";
export const RECORDED_HEADERS = [
  "content-type",
  "location",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-allow-private-network",
  "access-control-expose-headers",
];

export interface LogLine {
  readonly type: string;
  readonly text: string;
}

export interface FunctionsCall {
  readonly path: string;
  readonly body: Json;
}

export interface RecordedStep {
  readonly id: string;
  readonly note?: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: Json | string;
    readonly sleepMs?: number;
  };
  readonly functions?: Step["functions"];
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Json;
  };
  readonly logs: readonly LogLine[];
  readonly functionsCalls: readonly FunctionsCall[];
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function reserveAvailablePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to reserve a TCP port");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
  return port;
}

export async function waitForReady(origin: string, timeoutMs: number, exited?: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (exited?.()) throw new Error("the emulator exited before becoming ready");
    try {
      const response = await fetch(`${origin}/`);
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Auth emulator did not become ready: ${String(lastError)}`);
}

/** Every string literal in the plan is a program constant that must never be templated. */
export function collectConstants(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    into.add(value);
    // Literal JWTs in the plan carry constants in their payload.
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value)) {
      try {
        collectConstants(JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8")), into);
      } catch {
        // not a JWT after all
      }
    }
    // Query strings and post bodies carry constants in encoded form too.
    for (const part of value.split(/[&=?]/)) {
      if (part.length >= 4) {
        into.add(part);
        try {
          const decoded = decodeURIComponent(part);
          into.add(decoded);
          // Fake IdP claims travel JSON-encoded inside the post body.
          if (decoded.startsWith("{")) collectConstants(JSON.parse(decoded), into);
        } catch {
          // not encoded, or not JSON
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectConstants(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectConstants(item, into);
  }
}

/** `{ $customToken: payload }` becomes an unsigned JWT once its templates are resolved. */
export function encodeDeferredTokens(value: Json): Json {
  if (Array.isArray(value)) return value.map(encodeDeferredTokens);
  if (value && typeof value === "object") {
    if ("$customToken" in value && Object.keys(value).length === 1) return encodeUnsignedJwt(value.$customToken);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeDeferredTokens(item)]));
  }
  return value;
}

export function extractAccounts(html: string): Json[] {
  const accounts: Json[] = [];
  for (const match of html.matchAll(/data-id-token="([^"]*)"/g)) {
    const encoded = match[1] ?? "";
    try {
      accounts.push(JSON.parse(decodeURIComponent(encoded)) as Json);
    } catch {
      accounts.push(encoded);
    }
  }
  return accounts;
}

/** The recording HTTP server registered as the Functions emulator. */
export class FunctionsStub {
  readonly calls: FunctionsCall[] = [];
  current: Step["functions"] = undefined;
  private readonly server: Server;
  port = 0;

  constructor() {
    this.server = createServer((request, response) => this.handle(request, response));
  }

  get origin(): string {
    return `http://${HOST}:${String(this.port)}`;
  }

  async start(): Promise<void> {
    this.port = await reserveAvailablePort();
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, HOST, () => resolvePromise());
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
  }

  /** Waits until no new call has landed for two consecutive 40 ms windows. */
  async settle(): Promise<void> {
    let quiet = 0;
    let seen = this.calls.length;
    while (quiet < 2) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      if (this.calls.length === seen) {
        quiet += 1;
      } else {
        seen = this.calls.length;
        quiet = 0;
      }
    }
  }

  drain(): FunctionsCall[] {
    return this.calls.splice(0, this.calls.length);
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Json;
      try {
        body = JSON.parse(text) as Json;
      } catch {
        body = text;
      }
      const path = request.url ?? "";
      this.calls.push({ path, body });
      let stub: StubResponse | undefined;
      if (path.startsWith("/blocking/")) {
        const event = path.slice("/blocking/".length) as "beforeCreate" | "beforeSignIn";
        stub = this.current?.[event];
      }
      const status = stub?.status ?? 200;
      const payload = stub?.body ?? {};
      if (typeof payload === "string") {
        response.writeHead(status, { "Content-Type": "text/plain" });
        response.end(payload);
      } else {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      }
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  }
}

export interface StepEnvironment {
  readonly origin: string;
  readonly registry: Registry;
  readonly stub: FunctionsStub;
  /** Log lines the emulator produced since the last drain. */
  readonly drainLogs: () => LogLine[];
  /** Scrubs machine-specific text from a log line. */
  readonly scrubLog?: (text: string) => string;
  readonly debug?: boolean;
  /** Recent raw responses, for failure diagnostics. */
  readonly trail?: () => string[];
  readonly remember?: (line: string) => void;
}

/** Executes one plan step and returns it in the fixture's recorded form. */
export async function executeStep(step: Step, environment: StepEnvironment): Promise<RecordedStep> {
  try {
    return await executeStepInner(step, environment);
  } catch (error) {
    throw new Error(`step ${step.id}: ${error instanceof Error ? error.message : String(error)}\nlast responses:\n${environment.trail?.().join("\n") ?? ""}`);
  }
}

async function executeStepInner(step: Step, environment: StepEnvironment): Promise<RecordedStep> {
  const { origin, registry, stub } = environment;
  const path = registry.resolve(step.path);
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(step.query ?? {})) url.searchParams.set(key, registry.resolve(value));
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (step.body !== undefined) {
    if (typeof step.body === "string") {
      body = registry.resolve(step.body);
    } else {
      body = JSON.stringify(encodeDeferredTokens(registry.resolveJson(step.body)));
      headers["Content-Type"] = "application/json";
    }
  }
  for (const [key, value] of Object.entries(step.headers ?? {})) {
    if (value === "") delete headers[key];
    else headers[key] = registry.resolve(value);
  }
  if (headers["Content-Type"] === undefined && body !== undefined && typeof step.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  stub.current = step.functions;
  stub.drain();
  environment.drainLogs();
  if (step.sleepMs) await new Promise((resolvePromise) => setTimeout(resolvePromise, step.sleepMs));
  const response = await fetch(url, { method: step.method, headers, ...(body === undefined ? {} : { body }), redirect: "manual" });
  const text = await response.text();
  // Lifecycle multicasts are fire-and-forget and may land after the HTTP
  // response; wait until the stub has been quiet.
  await stub.settle();
  stub.current = undefined;
  const logs = environment.drainLogs();
  const calls = stub.drain();

  const recordedHeaders: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) recordedHeaders[name] = registry.replaceAll(value);
  }
  const contentType = response.headers.get("content-type") ?? "";
  let parsed: Json;
  if (contentType.includes("application/json")) {
    try {
      parsed = text.length ? (JSON.parse(text) as Json) : null;
    } catch {
      parsed = text;
    }
  } else {
    parsed = text;
  }

  // Logs first: they carry the codes that later steps reference.
  const scrub = environment.scrubLog ?? ((line: string) => line);
  const normalizedLogs = logs.map((line) => ({ type: line.type, text: normalizeLogLine(scrub(line.text), step.id, registry) }));
  let normalizedBody: Json;
  if (step.html) {
    normalizedBody = {
      $html: {
        sha256: sha256(text),
        bytes: text.length,
        accounts: normalizeValue(extractAccounts(text), step.id, registry),
      },
    };
  } else if (step.digest) {
    const canonical = JSON.stringify(canonicalize(finish(normalizeValue(parsed, step.id, registry), registry)));
    normalizedBody = { $digest: { sha256: sha256(canonical), bytes: canonical.length } };
  } else {
    normalizedBody = normalizeValue(parsed, step.id, registry);
  }
  const normalizedCalls = calls.map((call) => ({
    path: registry.replaceAll(call.path),
    body: normalizeValue(call.body, step.id, registry),
  }));
  if (environment.debug) console.log(`${step.id}: ${String(response.status)} ${text.slice(0, 400)}`);
  environment.remember?.(`${step.id}: ${String(response.status)} ${text.slice(0, 300)}`);
  return {
    id: step.id,
    ...(step.note === undefined ? {} : { note: step.note }),
    request: {
      method: step.method,
      path: step.path,
      ...(step.query === undefined ? {} : { query: step.query }),
      ...(step.headers === undefined ? {} : { headers: step.headers }),
      ...(step.body === undefined ? {} : { body: step.body }),
      ...(step.sleepMs === undefined ? {} : { sleepMs: step.sleepMs }),
    },
    ...(step.functions === undefined ? {} : { functions: step.functions }),
    response: {
      status: response.status,
      headers: recordedHeaders,
      body: sortUnordered(finish(normalizedBody, registry)),
    },
    logs: normalizedLogs.map((line) => ({ type: line.type, text: registry.replaceAll(line.text) })),
    functionsCalls: normalizedCalls.map((call) => ({ path: call.path, body: finish(call.body, registry) })),
  };
}
