// Phase H1 program runner shared by the official-emulator capture and the
// Fireside replay. A target is a running suite (any engine) plus the synthetic
// project it serves; the runner drives the programs from `plan.ts`, reads the
// handler observations back, and normalizes every volatile value so two
// recordings of the same target behaviour compare equal.
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CODEBASES,
  PROJECT_ID,
  TOKEN_PAYLOADS,
  primarySource,
  primarySourceAfterReload,
  type Action,
  type Program,
  type Step,
  type StepBody,
} from "./plan.ts";

export interface TargetOrigins {
  readonly functions: string;
  readonly firestore: string;
  readonly auth: string;
  readonly storage: string;
  readonly pubsub: string;
  readonly hub: string;
  readonly eventarc?: string;
  readonly tasks?: string;
}

export interface Target {
  readonly engine: string;
  readonly projectId: string;
  readonly origins: TargetOrigins;
  readonly projectDir: string;
  readonly codebaseDirs: Readonly<Record<keyof typeof CODEBASES, string>>;
  readonly observationsPath: string;
  /** Emulator process log lines captured so far (ANSI stripped). */
  readonly logs: () => readonly string[];
  /** Extra path prefixes to replace with placeholders (sdk roots, temp dirs). */
  readonly pathPlaceholders?: Readonly<Record<string, string>>;
}

export interface RecordedResponse {
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly elapsedMs?: number;
  readonly clientError?: string;
}

export interface RecordedStep {
  readonly id: string;
  readonly note?: string;
  readonly action: unknown;
  readonly response?: unknown;
  readonly observations: readonly unknown[];
  readonly observationsTimedOut?: boolean;
  readonly logs?: readonly string[];
}

export interface RecordedProgram {
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly steps: readonly RecordedStep[];
}

const VOLATILE_HEADERS = new Set(["date", "etag", "connection", "keep-alive", "x-cloud-trace-context", "traceparent", "server-timing"]);
const TIME_KEYS = new Set([
  "time", "timestamp", "createTime", "updateTime", "readTime", "timeCreated", "updated", "publishTime", "publishtime",
  "lastLoginAt", "createdAt", "lastRefreshAt", "validSince", "creationTime", "lastSignInTime", "lastRefreshTime",
  "iat", "exp", "auth_time", "scheduleTime", "scheduledTime", "startedAt", "finishedAt", "date",
]);
// Cloud Tasks: auto-generated task ids are random integers and the ETA header is a clock value.
const TASK_ID_SUFFIX = /\/tasks\/\d{10,}$/u;
const ID_KEYS = new Set(["eventId", "id", "messageId", "localId", "uid", "kind", "user_id", "sub", "traceId", "jobName"]);
const TOKEN_KEYS = new Set(["idToken", "refreshToken", "passwordHash", "salt", "accessToken", "rawUserInfo", "oauthAccessToken"]);
const VOLATILE_NUMBER_KEYS = new Set(["generation", "metageneration", "expiresIn", "size", "elapsedMs"]);
const HASH_KEYS = new Set(["md5Hash", "crc32c", "etag"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const AUTH_LOCAL_ID = /^[A-Za-z0-9]{28}$/;
const JWT_LIKE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const SOCKET_PATH = /\/[^\s"']*fire_emu_[0-9a-f]+\.sock|\\\\\?\\pipe\\fire_emu_[0-9a-f]+/g;
const ANSI = /\u001b\[[0-9;]*m/g;

export function unsignedJwt(payload: Readonly<Record<string, unknown>>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

export function tokenFor(name: string, projectId = PROJECT_ID): string {
  const payload = TOKEN_PAYLOADS[name];
  if (!payload) throw new Error(`unknown token ${name}`);
  const { expOverride, ...claims } = payload as Record<string, unknown> & { expOverride?: number };
  return unsignedJwt({
    ...claims,
    iat: 1700000000,
    exp: expOverride ?? 4102444800,
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
  });
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ObservationCursor {
  offset: number;
}

interface RunContext {
  readonly target: Target;
  readonly cursor: ObservationCursor;
  readonly logStart: number;
  readonly stepResponses: Map<string, unknown>;
  readonly dynamicIds: Map<string, string>;
}

export async function runProgram(target: Target, program: Program): Promise<RecordedProgram> {
  const context: RunContext = {
    target,
    cursor: { offset: await currentObservationOffset(target) },
    logStart: target.logs().length,
    stepResponses: new Map(),
    dynamicIds: new Map(),
  };
  const steps: RecordedStep[] = [];
  for (const step of program.steps) {
    steps.push(await runStep(context, step));
  }
  return { id: program.id, category: program.category, description: program.description, steps };
}

async function runStep(context: RunContext, step: Step): Promise<RecordedStep> {
  const { target } = context;
  const before = context.cursor.offset;
  let response: unknown;
  let logs: string[] | undefined;
  const action = step.action;
  switch (action.kind) {
    case "http":
      response = await httpAction(context, action);
      break;
    case "http-parallel": {
      const started = performance.now();
      const parallelOrigin = action.origin === "tasks" ? target.origins.tasks : target.origins.functions;
      if (!parallelOrigin) throw new Error(`no ${action.origin ?? "functions"} origin for this target`);
      const results = await Promise.all(
        action.requests.map(async (request) => {
          if (request.delayMs) await delay(request.delayMs);
          const startedAt = performance.now() - started;
          const result = await fetchRecorded(
            parallelOrigin + expandPath(context, request.path),
            { method: request.method, headers: {}, body: request.body === undefined ? undefined : templateBody(context, request.body) },
            action.clientTimeoutMs,
          );
          return { startedAtMs: Math.round(startedAt), ...result };
        }),
      );
      response = { parallel: results };
      break;
    }
    case "firestore":
      response = await firestoreAction(context, action);
      break;
    case "firestore-commit":
      response = await firestoreCommit(context, action.writes);
      break;
    case "storage":
      response = await storageAction(context, action);
      break;
    case "pubsub":
      response = await fetchRecorded(`${target.origins.pubsub}/v1/projects/${target.projectId}/topics/${action.topic}:publish`, {
        method: "POST",
        headers: { authorization: "Bearer owner" },
        body: {
          kind: "json",
          json: {
            messages: action.messages.map((message) => ({
              ...(message.data === undefined ? {} : { data: Buffer.from(message.data, "utf8").toString("base64") }),
              ...(message.attributes ? { attributes: message.attributes } : {}),
              ...(message.orderingKey ? { orderingKey: message.orderingKey } : {}),
            })),
          },
        },
      });
      break;
    case "pubsub-list":
      response = await fetchRecorded(`${target.origins.pubsub}/v1/projects/${target.projectId}/${action.what}`, { method: "GET", headers: { authorization: "Bearer owner" } });
      break;
    case "auth":
      response = await authAction(context, action);
      break;
    case "file": {
      const directory = target.codebaseDirs[action.codebase];
      const filePath = join(directory, action.relativePath);
      if (action.op === "remove") {
        await rm(filePath, { force: true });
      } else {
        await writeFile(filePath, expandSource(action.content ?? ""), "utf8");
      }
      response = { file: action.relativePath, op: action.op };
      break;
    }
    case "wait":
      await delay(action.ms);
      response = { waitedMs: action.ms };
      break;
    case "hub":
      response = await fetchRecorded(target.origins.hub + action.path, { method: action.method, headers: {} });
      break;
    case "logs": {
      const pattern = action.pattern.toLowerCase();
      logs = target
        .logs()
        .slice(context.logStart)
        .filter((line) => pattern === "" || line.toLowerCase().includes(pattern))
        .map((line) => normalizeLogLine(context, line));
      response = { matched: logs.length };
      break;
    }
    default:
      throw new Error(`unsupported action ${JSON.stringify(action)}`);
  }
  context.stepResponses.set(step.id, response);
  rememberDynamicIds(context, step.id, response);
  const { observations, timedOut } = await collectObservations(context, step, before);
  const recorded: RecordedStep = {
    id: step.id,
    ...(step.note ? { note: step.note } : {}),
    action: normalize(context, redactAction(action)),
    ...(response === undefined ? {} : { response: normalize(context, response) }),
    observations: observations.map((observation) => normalize(context, observation)),
    ...(timedOut ? { observationsTimedOut: true } : {}),
    ...(logs ? { logs } : {}),
  };
  return recorded;
}

function redactAction(action: Action): unknown {
  if (action.kind === "file") return { kind: "file", op: action.op, codebase: action.codebase, relativePath: action.relativePath, contentSha256: action.content ? sha256(expandSource(action.content)) : null };
  if (action.kind === "http" && action.body?.kind === "text" && action.body.text.length > 2000) {
    return { ...action, body: { kind: "text", contentType: action.body.contentType, length: action.body.text.length, sha256: sha256(action.body.text) } };
  }
  return action;
}

function expandSource(content: string): string {
  if (content === "{{primarySource}}") return primarySource();
  if (content === "{{primarySourceAfterReload}}") return primarySourceAfterReload();
  return content;
}

function expandPath(context: RunContext, path: string): string {
  return path.replaceAll("{{project}}", context.target.projectId);
}

function expandTemplates(context: RunContext, value: string): string {
  return value
    .replace(/\{\{jwt:([a-z]+)\}\}/g, (_, name: string) => tokenFor(name, context.target.projectId))
    .replace(/\{\{origin:([a-z]+)\}\}/g, (_, name: string) => {
      const origin = context.target.origins[name as keyof TargetOrigins];
      if (!origin) throw new Error(`no ${name} origin for this target`);
      return origin;
    })
    .replaceAll("{{project}}", context.target.projectId);
}

async function httpAction(context: RunContext, action: Extract<Action, { kind: "http" }>): Promise<RecordedResponse> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(action.headers ?? {})) headers[key] = expandTemplates(context, value);
  if (action.auth?.startsWith("@")) headers.authorization = `Bearer ${tokenFor(action.auth.slice(1), context.target.projectId)}`;
  const origin = action.origin === "tasks" ? context.target.origins.tasks : context.target.origins.functions;
  if (!origin) throw new Error(`no ${action.origin ?? "functions"} origin for this target`);
  return fetchRecorded(
    origin + expandPath(context, action.path),
    { method: action.method, headers, body: action.body === undefined ? undefined : templateBody(context, action.body) },
    action.clientTimeoutMs,
  );
}

function templateBody(context: RunContext, body: StepBody): StepBody {
  if (body.kind === "json") return { kind: "json", json: JSON.parse(expandTemplates(context, JSON.stringify(body.json))) };
  return body;
}

interface FetchOptions {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: StepBody | undefined;
}

export async function fetchRecorded(url: string, options: FetchOptions, clientTimeoutMs = 20_000): Promise<RecordedResponse> {
  const headers: Record<string, string> = { ...options.headers };
  let body: BodyInit | undefined;
  if (options.body) {
    switch (options.body.kind) {
      case "json":
        headers["content-type"] ??= "application/json";
        body = JSON.stringify(options.body.json);
        break;
      case "text":
        headers["content-type"] = options.body.contentType;
        body = options.body.text;
        break;
      case "bytes":
        headers["content-type"] = options.body.contentType;
        body = Buffer.from(options.body.base64, "base64");
        break;
      case "form":
        headers["content-type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(options.body.fields).toString();
        break;
      default:
        throw new Error("unsupported body");
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clientTimeoutMs);
  const started = performance.now();
  try {
    const init: RequestInit = { method: options.method, headers, redirect: "manual", signal: controller.signal };
    if (body !== undefined) init.body = body;
    const response = await fetch(url, init);
    const bytes = Buffer.from(await response.arrayBuffer());
    const recordedHeaders: Record<string, string> = {};
    for (const [key, value] of [...response.headers.entries()].sort()) {
      if (!VOLATILE_HEADERS.has(key)) recordedHeaders[key] = value;
    }
    return { status: response.status, headers: recordedHeaders, body: decodeBody(bytes, response.headers.get("content-type")), elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const message = controller.signal.aborted ? `client timeout after ${clientTimeoutMs}ms` : (cause?.code ?? cause?.message ?? (error as Error).message);
    return { status: null, headers: {}, body: null, elapsedMs: Math.round(performance.now() - started), clientError: message };
  } finally {
    clearTimeout(timer);
  }
}

function decodeBody(bytes: Buffer, contentType: string | null): unknown {
  if (bytes.length === 0) return "";
  const type = contentType ?? "";
  if (type.includes("json")) {
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      return { $invalidJson: bytes.toString("utf8") };
    }
  }
  if (type.startsWith("text/") || type.includes("charset") || type === "") {
    const text = bytes.toString("utf8");
    if (Buffer.from(text, "utf8").equals(bytes)) return text;
  }
  return { $base64: bytes.toString("base64"), length: bytes.length };
}

function firestoreValue(value: unknown): unknown {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$timestamp === "string") return { timestampValue: record.$timestamp };
    if (Array.isArray(record.$geo)) return { geoPointValue: { latitude: record.$geo[0], longitude: record.$geo[1] } };
    if (typeof record.$ref === "string") return { referenceValue: `projects/${PROJECT_ID}/databases/(default)/documents/${record.$ref}` };
    if (typeof record.$bytes === "string") return { bytesValue: record.$bytes };
    return { mapValue: { fields: Object.fromEntries(Object.entries(record).map(([key, item]) => [key, firestoreValue(item)])) } };
  }
  throw new Error(`unsupported Firestore value ${String(value)}`);
}

function documentName(context: RunContext, path: string): string {
  return `projects/${context.target.projectId}/databases/(default)/documents/${path}`;
}

async function firestoreAction(context: RunContext, action: Extract<Action, { kind: "firestore" }>): Promise<RecordedResponse> {
  const { target } = context;
  const authorization = action.auth?.startsWith("@") ? `Bearer ${tokenFor(action.auth.slice(1), target.projectId)}` : "Bearer owner";
  const base = `${target.origins.firestore}/v1/${documentName(context, action.path)}`;
  if (action.op === "delete") return fetchRecorded(base, { method: "DELETE", headers: { authorization } });
  const fields = Object.fromEntries(Object.entries(action.fields ?? {}).map(([key, value]) => [key, firestoreValue(value)]));
  if (action.op === "set") return fetchRecorded(base, { method: "PATCH", headers: { authorization }, body: { kind: "json", json: { fields } } });
  const mask = Object.keys(action.fields ?? {}).map((key) => `updateMask.fieldPaths=${encodeURIComponent(key)}`).join("&");
  return fetchRecorded(`${base}?${mask}&currentDocument.exists=true`, { method: "PATCH", headers: { authorization }, body: { kind: "json", json: { fields } } });
}

async function firestoreCommit(context: RunContext, writes: Extract<Action, { kind: "firestore-commit" }>["writes"]): Promise<RecordedResponse> {
  const body = {
    writes: writes.map((write) =>
      write.op === "delete"
        ? { delete: documentName(context, write.path) }
        : { update: { name: documentName(context, write.path), fields: Object.fromEntries(Object.entries(write.fields ?? {}).map(([key, value]) => [key, firestoreValue(value)])) } },
    ),
  };
  return fetchRecorded(`${context.target.origins.firestore}/v1/projects/${context.target.projectId}/databases/(default)/documents:commit`, {
    method: "POST",
    headers: { authorization: "Bearer owner" },
    body: { kind: "json", json: body },
  });
}

async function storageAction(context: RunContext, action: Extract<Action, { kind: "storage" }>): Promise<RecordedResponse> {
  const { target } = context;
  const encodedName = encodeURIComponent(action.name);
  const objectUrl = `${target.origins.storage}/v0/b/${action.bucket}/o/${encodedName}`;
  const authorization = "Bearer owner";
  if (action.op === "delete") return fetchRecorded(objectUrl, { method: "DELETE", headers: { authorization } });
  if (action.op === "patch") {
    return fetchRecorded(objectUrl, { method: "PATCH", headers: { authorization }, body: { kind: "json", json: { metadata: action.metadata ?? {} } } });
  }
  const boundary = "fireside-phase-h-boundary";
  const metadata = { name: action.name, contentType: action.contentType ?? "application/octet-stream", ...(action.metadata ? { metadata: action.metadata } : {}) };
  const multipart = [
    `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${metadata.contentType}\r\n\r\n${action.content ?? ""}\r\n--${boundary}--\r\n`,
  ].join("");
  return fetchRecorded(`${target.origins.storage}/v0/b/${action.bucket}/o?name=${encodedName}`, {
    method: "POST",
    headers: { authorization, "x-goog-upload-protocol": "multipart" },
    body: { kind: "text", text: multipart, contentType: `multipart/related; boundary=${boundary}` },
  });
}

async function authAction(context: RunContext, action: Extract<Action, { kind: "auth" }>): Promise<RecordedResponse> {
  const { target } = context;
  const base = `${target.origins.auth}/identitytoolkit.googleapis.com/v1`;
  const key = "?key=fake-api-key";
  const previous = action.from ? (context.stepResponses.get(action.from) as { body?: Record<string, unknown> } | undefined)?.body : undefined;
  switch (action.op) {
    case "signUp":
      return fetchRecorded(`${base}/accounts:signUp${key}`, {
        method: "POST",
        headers: {},
        body: { kind: "json", json: { email: action.email, password: action.password, returnSecureToken: true, ...(action.displayName ? { displayName: action.displayName } : {}) } },
      });
    case "signIn":
      return fetchRecorded(`${base}/accounts:signInWithPassword${key}`, { method: "POST", headers: {}, body: { kind: "json", json: { email: action.email, password: action.password, returnSecureToken: true } } });
    case "lookup":
      return fetchRecorded(`${base}/accounts:lookup${key}`, { method: "POST", headers: { authorization: "Bearer owner" }, body: { kind: "json", json: { localId: [previous?.localId ?? action.uid] } } });
    case "delete":
      return fetchRecorded(`${base}/accounts:delete${key}`, { method: "POST", headers: { authorization: "Bearer owner" }, body: { kind: "json", json: { localId: previous?.localId ?? action.uid } } });
    case "setClaims":
      return fetchRecorded(`${base}/accounts:update${key}`, { method: "POST", headers: { authorization: "Bearer owner" }, body: { kind: "json", json: { localId: previous?.localId ?? action.uid, customAttributes: JSON.stringify(action.claims ?? {}) } } });
    default:
      throw new Error("unsupported auth op");
  }
}

function rememberDynamicIds(context: RunContext, stepId: string, response: unknown): void {
  const body = (response as { body?: unknown } | undefined)?.body;
  if (!body || typeof body !== "object") return;
  const record = body as Record<string, unknown>;
  if (typeof record.localId === "string" && AUTH_LOCAL_ID.test(record.localId)) context.dynamicIds.set(record.localId, `{{localId:${stepId}}}`);
}

async function currentObservationOffset(target: Target): Promise<number> {
  try {
    return (await readFile(target.observationsPath)).length;
  } catch {
    return 0;
  }
}

async function readNewObservations(context: RunContext, from: number): Promise<{ readonly items: unknown[]; readonly end: number }> {
  let content: Buffer;
  try {
    content = await readFile(context.target.observationsPath);
  } catch {
    return { items: [], end: from };
  }
  const slice = content.subarray(from).toString("utf8");
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline < 0) return { items: [], end: from };
  const complete = slice.slice(0, lastNewline);
  const items = complete
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return { $unparseable: line };
      }
    });
  return { items, end: from + Buffer.byteLength(complete, "utf8") + 1 };
}

function satisfied(expect: Step["expect"], items: readonly unknown[]): boolean {
  if (expect === undefined) return true;
  if (typeof expect === "number") return items.length >= expect;
  const remaining = [...expect];
  for (const item of items) {
    const handler = (item as { handler?: string }).handler;
    const index = remaining.indexOf(handler ?? "");
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

async function collectObservations(context: RunContext, step: Step, from: number): Promise<{ observations: unknown[]; timedOut: boolean }> {
  const timeoutMs = step.timeoutMs ?? (step.expect === undefined ? 400 : 15_000);
  const settleMs = 400;
  const deadline = Date.now() + timeoutMs;
  let items: unknown[] = [];
  let end = from;
  let timedOut = false;
  for (;;) {
    ({ items, end } = await readNewObservations(context, from));
    if (satisfied(step.expect, items)) break;
    if (Date.now() >= deadline) {
      timedOut = step.expect !== undefined && !(typeof step.expect === "number" && step.expect === 0 && items.length === 0);
      break;
    }
    await delay(100);
  }
  // Give straggling handlers a moment so extra deliveries are recorded too.
  await delay(settleMs);
  ({ items, end } = await readNewObservations(context, from));
  context.cursor.offset = end;
  items.sort((left, right) => stableKey(left).localeCompare(stableKey(right)));
  return { observations: items, timedOut };
}

function stableKey(item: unknown): string {
  const record = item as { handler?: string; event?: { type?: string }; callable?: unknown; request?: { url?: string } };
  return `${record.handler ?? ""}|${record.event?.type ?? ""}|${record.request?.url ?? ""}`;
}

export function normalizeLogLine(context: RunContext | { target: Target }, line: string): string {
  let text = line.replace(ANSI, "").replace(/^\s*[✔✓ⓘi!⚠]\s+/u, "").replace(/\s+\d+(\.\d+)?ms\b/g, " {{ms}}");
  text = text.replace(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\]]*\]\s*/g, "").replace(/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\s*(AM|PM)?\b/g, "{{clock}}");
  return normalizeString(context.target, text, new Map());
}

function normalizeString(target: Target, value: string, dynamicIds: ReadonlyMap<string, string>): string {
  let text = value;
  for (const [name, origin] of Object.entries(target.origins)) {
    if (!origin) continue;
    const host = origin.replace(/^https?:\/\//, "");
    text = text.replaceAll(origin, `{{origin:${name}}}`).replaceAll(host, `{{host:${name}}}`).replaceAll(host.replace("127.0.0.1", "localhost"), `{{host:${name}}}`);
  }
  for (const [placeholder, prefix] of Object.entries(target.pathPlaceholders ?? {})) text = text.replaceAll(prefix, placeholder);
  text = text.replaceAll(target.projectDir, "{{projectDir}}");
  // macOS reports the real path of a symlinked temporary directory with a
  // `/private` prefix; the placeholder stands for either spelling.
  text = text.replaceAll("/private{{projectDir}}", "{{projectDir}}").replaceAll("/private{{tmp}}", "{{tmp}}");
  // Express error pages embed a stack trace whose frames name installed
  // package versions and Node internals; the message line is the contract.
  text = text.replace(/(<br> &nbsp; &nbsp;at [^<]*)+/g, "<br> &nbsp; &nbsp;at {{stack}}");
  for (const [id, placeholder] of dynamicIds) text = text.replaceAll(id, placeholder);
  text = text.replace(SOCKET_PATH, "{{workerSocket}}");
  text = text.replace(/\[worker-([^\]]*?)-[0-9a-f-]{36}\]/g, "[worker-$1-{{uuid}}]");
  return text;
}

export function normalize(context: RunContext, value: unknown): unknown {
  return normalizeValue(context.target, context.dynamicIds, value, undefined);
}

/** Normalizes a value recorded outside a program (readiness inventory, shutdown). */
export function normalizeForTarget(target: Target, value: unknown): unknown {
  return normalizeValue(target, new Map(), value, undefined);
}

function normalizeValue(target: Target, dynamicIds: ReadonlyMap<string, string>, value: unknown, key: string | undefined): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (key === "x-cloudtasks-tasketa") return "{{time}}";
    if (key === "x-cloudtasks-taskname" && /^\d+$/u.test(value)) return "{{id}}";
    if (TASK_ID_SUFFIX.test(value)) return normalizeString(target, value.replace(TASK_ID_SUFFIX, "/tasks/{{id}}"), dynamicIds);
    if (key !== undefined && TOKEN_KEYS.has(key)) return "{{token}}";
    if (key !== undefined && HASH_KEYS.has(key)) return "{{hash}}";
    if (key !== undefined && TIME_KEYS.has(key) && (RFC3339.test(value) || /^\d{9,13}$/.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value))) return "{{time}}";
    if (key !== undefined && VOLATILE_NUMBER_KEYS.has(key) && /^\d+$/.test(value)) return "{{number}}";
    if (UUID.test(value)) return "{{uuid}}";
    if (key !== undefined && ID_KEYS.has(key) && (AUTH_LOCAL_ID.test(value) || /^\d{12,}$/.test(value))) return "{{id}}";
    if (JWT_LIKE.test(value) && value.length > 40 && !value.startsWith("eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0")) return "{{jwt}}";
    if (RFC3339.test(value) && key !== undefined && /time|date|at$/i.test(key)) return "{{time}}";
    return normalizeString(target, value, dynamicIds);
  }
  if (typeof value === "number") {
    if (key !== undefined && (TIME_KEYS.has(key) || VOLATILE_NUMBER_KEYS.has(key))) return "{{number}}";
    if (key === "pid" || key === "port") return "{{number}}";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(target, dynamicIds, item, key));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = normalizeValue(target, dynamicIds, child, childKey);
    }
    return out;
  }
  return value;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
