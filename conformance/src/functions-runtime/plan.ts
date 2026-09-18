// Phase H1 emulator oracle programs for the Functions runtime and Extensions.
//
// The harness writes a synthetic Firebase project (four user codebases, one
// local extension, dotenv chains, secrets) and drives the official emulator
// suite (firebase-tools 15.22.0 with the Java Firestore emulator, the Storage
// emulator, Auth, Pub/Sub, Eventarc and Tasks) through HTTP requests and
// backend writes. Every synthetic handler appends what it observed
// (invocation shape, event envelope, environment subset, auth context) to a
// JSONL file the harness reads back, so a step records both the HTTP-visible
// contract and the handler-visible contract. Nothing here asserts an
// expectation: the recording is the evidence and the invariants are written
// after review.

export const PROJECT_ID = "demo-fireside-functions-oracle";
export const DEFAULT_BUCKET = `${PROJECT_ID}.appspot.com`;
export const SECOND_BUCKET = "synthetic-second-bucket.example.test";
export const REGION = "us-central1";
export const ALT_REGION = "europe-west1";
export const EXTENSION_INSTANCE = "synthetic";
export const EXTENSION_EVENT_TYPE = "test-publisher.synthetic.v1.complete";
export const EVENTARC_CHANNEL = `projects/${PROJECT_ID}/locations/${REGION}/channels/firebase`;
export const CUSTOM_EVENT_TYPE_UNLISTENED = "test-publisher.synthetic.v1.ignored";

/** Codebase identifiers, in `firebase.json` order. */
export const CODEBASES = {
  primary: "primary",
  secondary: "secondary",
  esm: "esm",
  yaml: "static-manifest",
  broken: "broken-load",
  badenv: "invalid-dotenv",
} as const;

export type StepBody =
  | { readonly kind: "json"; readonly json: unknown }
  | { readonly kind: "text"; readonly text: string; readonly contentType: string }
  | { readonly kind: "bytes"; readonly base64: string; readonly contentType: string }
  | { readonly kind: "form"; readonly fields: Readonly<Record<string, string>> };

export type Action =
  | {
      readonly kind: "http";
      readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
      /** Path on the Functions emulator origin. `{{project}}` expands to the project id. */
      readonly path: string;
      /** `@name` sends `Authorization: Bearer <unsigned test JWT for name>`. */
      readonly auth?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: StepBody;
      /** Milliseconds before the client gives up (recorded as `clientTimeout`). */
      readonly clientTimeoutMs?: number;
    }
  | {
      readonly kind: "http-parallel";
      /** Requests started together; `delayMs` staggers a request after the first. */
      readonly requests: ReadonlyArray<{ readonly method: "GET" | "POST"; readonly path: string; readonly body?: StepBody; readonly delayMs?: number }>;
      readonly clientTimeoutMs?: number;
    }
  | {
      readonly kind: "firestore";
      readonly op: "set" | "update" | "delete";
      readonly path: string;
      readonly fields?: Readonly<Record<string, unknown>>;
      /** `@name` writes through the REST API with that user's unsigned token; default is the owner token. */
      readonly auth?: string;
    }
  | {
      readonly kind: "firestore-commit";
      readonly writes: ReadonlyArray<{ readonly op: "set" | "delete"; readonly path: string; readonly fields?: Readonly<Record<string, unknown>> }>;
    }
  | {
      readonly kind: "storage";
      readonly op: "upload" | "patch" | "delete";
      readonly bucket: string;
      readonly name: string;
      readonly content?: string;
      readonly contentType?: string;
      readonly metadata?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "pubsub";
      readonly topic: string;
      readonly messages: ReadonlyArray<{ readonly data?: string; readonly attributes?: Readonly<Record<string, string>>; readonly orderingKey?: string }>;
    }
  | { readonly kind: "pubsub-list"; readonly what: "topics" | "subscriptions" }
  | {
      readonly kind: "auth";
      readonly op: "signUp" | "signIn" | "lookup" | "delete" | "setClaims";
      readonly email?: string;
      readonly password?: string;
      readonly displayName?: string;
      readonly uid?: string;
      readonly claims?: Readonly<Record<string, unknown>>;
      /** Step id whose response carries the idToken/localId to use. */
      readonly from?: string;
    }
  | {
      readonly kind: "file";
      readonly op: "write" | "remove";
      readonly codebase: keyof typeof CODEBASES;
      readonly relativePath: string;
      readonly content?: string;
    }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "hub"; readonly method: "GET" | "PUT" | "POST"; readonly path: string }
  | { readonly kind: "logs"; readonly pattern: string };

export interface Step {
  readonly id: string;
  readonly action: Action;
  /**
   * Handler observations to wait for after the action: a count, or the
   * handler names expected (each once, order not significant). Omitted means
   * settle briefly and record whatever arrived.
   */
  readonly expect?: number | readonly string[];
  readonly timeoutMs?: number;
  readonly note?: string;
}

export interface Program {
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly steps: readonly Step[];
}

export const TOKEN_PAYLOADS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  alice: {
    sub: "alice",
    user_id: "alice",
    email: "alice@example.test",
    email_verified: true,
    name: "Alice Example",
    firebase: { sign_in_provider: "password", identities: { email: ["alice@example.test"] } },
  },
  admin: {
    sub: "admin-user",
    user_id: "admin-user",
    admin: true,
    firebase: { sign_in_provider: "custom", identities: {} },
  },
  subonly: {
    sub: "subonly",
    firebase: { sign_in_provider: "anonymous", identities: {} },
  },
  expired: {
    sub: "alice",
    user_id: "alice",
    firebase: { sign_in_provider: "password", identities: {} },
    expOverride: 1500000000,
  },
};

const OBSERVE_PRELUDE = `
const fs = require("node:fs");
const OBSERVATIONS = process.env.PHASE_H_OBSERVATIONS_PATH;
const ENV_KEYS = /^(FUNCTION_|K_|GCLOUD_|GOOGLE_|FIREBASE_|FUNCTIONS_|CLOUD_|PUBSUB_|FIRESTORE_|EVENTARC_|SYNTHETIC_|SECRET_|EXT_|PROJECT_|DATABASE_|STORAGE_|ALLOWED_|API_KEY$|COLLECTION$|LOCATION$|MODE$|TAGS$|BUCKET$|OPTIONAL_NOTE$|PORT$|TZ$|NODE_ENV$|METADATA_SERVER_DETECTION$)/;
function envSnapshot() {
  const out = {};
  for (const key of Object.keys(process.env).sort()) {
    if (ENV_KEYS.test(key)) out[key] = process.env[key];
  }
  return out;
}
function safe(value, depth = 0) {
  if (value === null || value === undefined) return value === undefined ? { $undefined: true } : null;
  if (typeof value === "function") return { $function: value.name || "anonymous" };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value !== "object") return value;
  if (depth > 6) return { $depth: true };
  if (Buffer.isBuffer(value)) return { $buffer: value.toString("base64") };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map((item) => safe(item, depth + 1));
  if (typeof value.toDate === "function" && typeof value.seconds === "number") return { $timestamp: value.toDate().toISOString() };
  const out = {};
  for (const key of Object.keys(value)) {
    if (key.startsWith("_")) continue;
    let child;
    try { child = value[key]; } catch (error) { out[key] = { $error: String(error && error.message ? error.message : error) }; continue; }
    out[key] = safe(child, depth + 1);
  }
  return out;
}
function attempt(read) {
  try { return read(); } catch (error) { return { $error: String(error && error.message ? error.message : error) }; }
}
function snapshot(snap) {
  if (!snap || typeof snap.data !== "function") return safe(snap);
  const ref = attempt(() => snap.ref);
  const time = (value) => (value && typeof value.toDate === "function" ? value.toDate().toISOString() : value === undefined ? null : safe(value));
  return {
    $snapshot: true,
    id: attempt(() => snap.id),
    path: ref && ref.path ? ref.path : ref,
    exists: attempt(() => snap.exists),
    data: attempt(() => (snap.exists ? safe(snap.data()) : null)),
    createTime: attempt(() => time(snap.createTime)),
    updateTime: attempt(() => time(snap.updateTime)),
    readTime: attempt(() => time(snap.readTime)),
  };
}
function projectEvent(event) {
  if (!event || typeof event !== "object") return safe(event);
  const out = {};
  for (const key of Object.keys(event)) {
    const value = event[key];
    if (key === "data") {
      if (value && typeof value.data === "function") out.data = snapshot(value);
      else if (value && value.before !== undefined && value.after !== undefined) {
        out.data = { $change: true, before: snapshot(value.before), after: snapshot(value.after) };
      } else if (value && value.message && typeof value.message === "object") {
        const message = value.message;
        let json = null;
        try { json = message.json; } catch (error) { json = { $error: String(error.message || error) }; }
        out.data = {
          message: { messageId: message.messageId, publishTime: message.publishTime, data: message.data, attributes: message.attributes, orderingKey: message.orderingKey, json },
          subscription: value.subscription,
        };
      } else out.data = safe(value);
    } else out[key] = safe(value);
  }
  return out;
}
function requestShape(request) {
  const headers = {};
  for (const key of Object.keys(request.headers).sort()) headers[key] = request.headers[key];
  return {
    method: request.method,
    url: request.url,
    originalUrl: request.originalUrl,
    baseUrl: request.baseUrl,
    path: request.path,
    query: request.query,
    protocol: request.protocol,
    hostname: request.hostname,
    ip: request.ip,
    hostHeader: request.get("host"),
    headers,
    body: safe(request.body),
    bodyType: Array.isArray(request.body) ? "array" : typeof request.body,
    rawBody: request.rawBody ? { $buffer: request.rawBody.toString("base64"), length: request.rawBody.length } : null,
    isJson: request.is("json"),
  };
}
function record(handler, extra) {
  fs.appendFileSync(OBSERVATIONS, JSON.stringify({ handler, pid: process.pid, cwd: process.cwd(), env: envSnapshot(), gacPresent: Object.prototype.hasOwnProperty.call(process.env, "GOOGLE_APPLICATION_CREDENTIALS"), ...extra }) + "\\n");
}
function callableShape(request) {
  return {
    data: safe(request.data),
    auth: request.auth ? { uid: request.auth.uid, token: safe(request.auth.token) } : null,
    app: request.app === undefined ? { $undefined: true } : safe(request.app),
    instanceIdToken: request.instanceIdToken === undefined ? { $undefined: true } : request.instanceIdToken,
    acceptsStreaming: request.acceptsStreaming,
    rawRequest: request.rawRequest ? { method: request.rawRequest.method, path: request.rawRequest.path, headers: safe(request.rawRequest.headers) } : null,
  };
}
`;

export function primarySource(): string {
  return `${OBSERVE_PRELUDE}
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted, onDocumentWritten, onDocumentWrittenWithAuthContext, onDocumentCreatedWithAuthContext } = require("firebase-functions/v2/firestore");
const { onObjectFinalized, onObjectDeleted, onObjectMetadataUpdated } = require("firebase-functions/v2/storage");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { beforeUserCreated, beforeUserSignedIn } = require("firebase-functions/v2/identity");
const { onCustomEventPublished } = require("firebase-functions/v2/eventarc");
const { onValueWritten } = require("firebase-functions/v2/database");
const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const { defineSecret } = require("firebase-functions/params");
const functionsV1 = require("firebase-functions/v1");
const admin = require("firebase-admin");
admin.initializeApp();

const declaredSecret = defineSecret("SECRET_DECLARED");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- HTTP ---------------------------------------------------------------
exports.httpEcho = onRequest((request, response) => {
  const shape = requestShape(request);
  record("httpEcho", { request: shape });
  const mode = request.get("x-synthetic-mode") || request.query.mode;
  if (mode === "status") {
    response.status(Number(request.query.code || 201)).set("x-synthetic-header", "present").json({ code: Number(request.query.code || 201) });
    return;
  }
  if (mode === "redirect") { response.redirect(302, "/redirected"); return; }
  if (mode === "empty") { response.status(204).end(); return; }
  if (mode === "text") { response.type("text/plain").send("plain text 火🔥"); return; }
  if (mode === "stream") {
    response.setHeader("content-type", "text/plain");
    response.write("chunk-1\\n");
    setTimeout(() => { response.write("chunk-2\\n"); setTimeout(() => response.end("chunk-3\\n"), 50); }, 50);
    return;
  }
  if (mode === "throw") throw new Error("synthetic synchronous failure");
  if (mode === "reject") return Promise.reject(new Error("synthetic asynchronous failure"));
  if (mode === "throw-after-headers") { response.status(200).write("partial"); throw new Error("after headers"); }
  if (mode === "never") return;
  if (mode === "crash") { setTimeout(() => process.exit(7), 10); response.json({ crashing: true }); return; }
  if (mode === "slow") return sleep(Number(request.query.ms || 1500)).then(() => response.json({ slow: true }));
  response.json({ echo: shape, unicode: "火🔥" });
});
exports.httpTimeout = onRequest({ timeoutSeconds: 2 }, (request, response) => {
  record("httpTimeout", { request: requestShape(request) });
  return sleep(5000).then(() => { try { response.json({ late: true }); } catch (error) { /* ignore */ } });
});
exports.httpCorsAll = onRequest({ cors: true }, (request, response) => {
  record("httpCorsAll", { request: requestShape(request) });
  response.json({ cors: "all" });
});
exports.httpCorsOrigin = onRequest({ cors: ["https://allowed.example"] }, (request, response) => {
  record("httpCorsOrigin", { request: requestShape(request) });
  response.json({ cors: "origin" });
});
exports.httpRegion = onRequest({ region: "${ALT_REGION}" }, (request, response) => {
  record("httpRegion", { request: requestShape(request) });
  response.json({ region: "${ALT_REGION}" });
});
exports.httpMultiRegion = onRequest({ region: ["${REGION}", "${ALT_REGION}"] }, (request, response) => {
  record("httpMultiRegion", { request: requestShape(request) });
  response.json({ multi: true });
});
exports.httpSecrets = onRequest({ secrets: [declaredSecret] }, (request, response) => {
  record("httpSecrets", { request: requestShape(request), declaredValue: declaredSecret.value() });
  response.json({ declared: declaredSecret.value(), undeclared: process.env.SECRET_UNDECLARED === undefined ? null : process.env.SECRET_UNDECLARED });
});
exports.adminRoundTrip = onRequest(async (request, response) => {
  const reference = admin.firestore().doc("probe/" + (request.query.id || "default"));
  await reference.set({ via: "admin", at: "fixed" });
  const read = await reference.get();
  record("adminRoundTrip", { request: requestShape(request), read: snapshot(read) });
  response.json({ wrote: reference.path, data: read.data() });
});

// --- Callable -------------------------------------------------------------
exports.callableEcho = onCall((request) => {
  const shape = callableShape(request);
  record("callableEcho", { callable: shape });
  const data = request.data;
  if (data && typeof data === "object" && data.throwCode) {
    throw new HttpsError(data.throwCode, data.message || "synthetic " + data.throwCode, data.details);
  }
  if (data && typeof data === "object" && data.throwPlain) throw new Error("plain synthetic failure");
  if (data && typeof data === "object" && data.rejectPlain) return Promise.reject(new TypeError("rejected synthetic failure"));
  if (data && typeof data === "object" && data.returnUndefined) return undefined;
  return { echo: shape, unicode: "火🔥" };
});
exports.callableAuthRequired = onCall({ enforceAppCheck: false }, (request) => {
  record("callableAuthRequired", { callable: callableShape(request) });
  if (!request.auth) throw new HttpsError("unauthenticated", "sign in first");
  return { uid: request.auth.uid };
});
exports.callableAppCheck = onCall({ enforceAppCheck: true }, (request) => {
  record("callableAppCheck", { callable: callableShape(request) });
  return { app: request.app ? safe(request.app) : null };
});
exports.callableStream = onCall(async (request, response) => {
  record("callableStream", { callable: callableShape(request) });
  const count = (request.data && request.data.count) || 3;
  for (let index = 1; index <= count; index += 1) {
    if (request.acceptsStreaming) await response.sendChunk({ chunk: index, unicode: "火🔥" });
    if (request.data && request.data.failAt === index) throw new HttpsError("aborted", "failed at " + index, { at: index });
  }
  return { done: true, count };
});
exports.callableRegion = onCall({ region: "${ALT_REGION}" }, (request) => {
  record("callableRegion", { callable: callableShape(request) });
  return { region: "${ALT_REGION}" };
});

// --- Firestore v2 --------------------------------------------------------
exports.docCreated = onDocumentCreated("items/{itemId}", (event) => { record("docCreated", { event: projectEvent(event) }); });
exports.docUpdated = onDocumentUpdated("items/{itemId}", (event) => { record("docUpdated", { event: projectEvent(event) }); });
exports.docDeleted = onDocumentDeleted("items/{itemId}", (event) => { record("docDeleted", { event: projectEvent(event) }); });
exports.docWritten = onDocumentWritten("items/{itemId}", (event) => { record("docWritten", { event: projectEvent(event) }); });
exports.docWrittenAuth = onDocumentWrittenWithAuthContext("audited/{docId}", (event) => { record("docWrittenAuth", { event: projectEvent(event) }); });
exports.docCreatedAuth = onDocumentCreatedWithAuthContext("audited/{docId}", (event) => { record("docCreatedAuth", { event: projectEvent(event) }); });
exports.docNested = onDocumentWritten("tenants/{tenantId}/rooms/{roomId}/messages/{messageId}", (event) => { record("docNested", { event: projectEvent(event) }); });
exports.docDeep = onDocumentWritten("deep/{path=**}", (event) => { record("docDeep", { event: projectEvent(event) }); });
exports.docExact = onDocumentWritten("config/settings", (event) => { record("docExact", { event: projectEvent(event) }); });
exports.docThrows = onDocumentCreated("throwing/{id}", (event) => { record("docThrows", { event: projectEvent(event) }); throw new Error("handler failure"); });
exports.docSlow = onDocumentCreated("slow/{id}", async (event) => { await sleep(1200); record("docSlow", { event: projectEvent(event) }); });
exports.docRegion = onDocumentCreated({ document: "regional/{id}", region: "${ALT_REGION}" }, (event) => { record("docRegion", { event: projectEvent(event) }); });

// --- Firestore v1 --------------------------------------------------------
exports.v1DocCreate = functionsV1.firestore.document("legacy/{id}").onCreate((snap, context) => { record("v1DocCreate", { snapshot: snapshot(snap), context: safe(context) }); });
exports.v1DocUpdate = functionsV1.firestore.document("legacy/{id}").onUpdate((change, context) => { record("v1DocUpdate", { change: { before: snapshot(change.before), after: snapshot(change.after) }, context: safe(context) }); });
exports.v1DocDelete = functionsV1.firestore.document("legacy/{id}").onDelete((snap, context) => { record("v1DocDelete", { snapshot: snapshot(snap), context: safe(context) }); });
exports.v1DocWrite = functionsV1.firestore.document("legacy/{id}").onWrite((change, context) => { record("v1DocWrite", { change: { before: snapshot(change.before), after: snapshot(change.after) }, context: safe(context) }); });

// --- Storage -------------------------------------------------------------
exports.objFinalized = onObjectFinalized((event) => { record("objFinalized", { event: projectEvent(event) }); });
exports.objDeleted = onObjectDeleted((event) => { record("objDeleted", { event: projectEvent(event) }); });
exports.objMetadata = onObjectMetadataUpdated((event) => { record("objMetadata", { event: projectEvent(event) }); });
exports.objSecondBucket = onObjectFinalized({ bucket: "${SECOND_BUCKET}" }, (event) => { record("objSecondBucket", { event: projectEvent(event) }); });
exports.v1ObjFinalize = functionsV1.storage.object().onFinalize((object, context) => { record("v1ObjFinalize", { object: safe(object), context: safe(context) }); });
exports.v1ObjDelete = functionsV1.storage.object().onDelete((object, context) => { record("v1ObjDelete", { object: safe(object), context: safe(context) }); });
exports.v1ObjMetadata = functionsV1.storage.object().onMetadataUpdate((object, context) => { record("v1ObjMetadata", { object: safe(object), context: safe(context) }); });

// --- Pub/Sub and schedules ----------------------------------------------
exports.topicEcho = onMessagePublished("synthetic-topic", (event) => { record("topicEcho", { event: projectEvent(event) }); });
exports.topicSecond = onMessagePublished({ topic: "synthetic-topic", retry: true }, (event) => { record("topicSecond", { event: projectEvent(event) }); });
exports.v1TopicPublish = functionsV1.pubsub.topic("legacy-topic").onPublish((message, context) => {
  let json = null;
  try { json = message.json; } catch (error) { json = { $error: String(error.message || error) }; }
  record("v1TopicPublish", { message: { data: message.data, attributes: message.attributes, messageId: message.messageId, publishTime: message.publishTime, orderingKey: message.orderingKey, json, toJSON: safe(message.toJSON()) }, context: safe(context) });
});
exports.scheduledTick = onSchedule("every 5 minutes", (event) => { record("scheduledTick", { event: projectEvent(event) }); });
exports.scheduledCron = onSchedule({ schedule: "0 3 * * *", timeZone: "Europe/Berlin", retryCount: 2 }, (event) => { record("scheduledCron", { event: projectEvent(event) }); });
exports.v1Scheduled = functionsV1.pubsub.schedule("every 10 minutes").timeZone("Asia/Kuala_Lumpur").onRun((context) => { record("v1Scheduled", { context: safe(context) }); });

// --- Auth ----------------------------------------------------------------
exports.v1AuthCreate = functionsV1.auth.user().onCreate((user, context) => { record("v1AuthCreate", { user: safe(user), context: safe(context) }); });
exports.v1AuthCreateSecond = functionsV1.auth.user().onCreate((user, context) => { record("v1AuthCreateSecond", { user: safe(user), context: safe(context) }); });
exports.v1AuthDelete = functionsV1.auth.user().onDelete((user, context) => { record("v1AuthDelete", { user: safe(user), context: safe(context) }); });
exports.blockCreate = beforeUserCreated(async (event) => {
  record("blockCreate", { event: projectEvent(event) });
  const email = (event.data && event.data.email) || "";
  if (email.startsWith("reject")) throw new HttpsError("permission-denied", "synthetic rejection at create");
  if (email.startsWith("slow")) { await sleep(8500); return {}; }
  if (email.startsWith("claims")) return { displayName: "set-by-blocking", customClaims: { role: "blocked-in", tier: 3 }, emailVerified: true };
  return undefined;
});
exports.blockSignIn = beforeUserSignedIn((event) => {
  record("blockSignIn", { event: projectEvent(event) });
  const email = (event.data && event.data.email) || "";
  if (email.startsWith("nosignin")) throw new HttpsError("permission-denied", "synthetic rejection at sign-in", { reason: "blocked" });
  if (email.startsWith("claims")) return { sessionClaims: { session: "granted" } };
  return undefined;
});

// --- Eventarc, ignored exports, tasks --------------------------------------
exports.customEvent = onCustomEventPublished("${EXTENSION_EVENT_TYPE}", (event) => { record("customEvent", { event: projectEvent(event) }); });
exports.dbIgnored = onValueWritten("/synthetic/{id}", (event) => { record("dbIgnored", { event: projectEvent(event) }); });
exports.taskQueue = onTaskDispatched({ retryConfig: { maxAttempts: 2 }, rateLimits: { maxConcurrentDispatches: 3 } }, (request) => { record("taskQueue", { data: safe(request.data) }); });
exports.removable = onRequest((request, response) => { record("removable", {}); response.json({ removable: true }); });
exports.changeMe = onDocumentCreated("before-change/{id}", (event) => { record("changeMe", { event: projectEvent(event) }); });
`;
}

export function primarySourceAfterReload(): string {
  return primarySource()
    .replace(
      'exports.removable = onRequest((request, response) => { record("removable", {}); response.json({ removable: true }); });\n',
      "",
    )
    .replace('onDocumentCreated("before-change/{id}"', 'onDocumentCreated("after-change/{id}"')
    .concat(
      'exports.addedLater = onRequest((request, response) => { record("addedLater", { request: requestShape(request) }); response.json({ added: true }); });\n',
    );
}

export function secondarySource(): string {
  return `${OBSERVE_PRELUDE}
const { onRequest, onCall } = require("firebase-functions/v2/https");
const functionsV1 = require("firebase-functions/v1");
exports.secondaryHttp = onRequest((request, response) => {
  record("secondaryHttp", { request: requestShape(request) });
  response.json({ codebase: "secondary" });
});
exports.secondaryCallable = onCall((request) => {
  record("secondaryCallable", { callable: callableShape(request) });
  return { codebase: "secondary" };
});
exports.v1Http = functionsV1.https.onRequest((request, response) => {
  record("v1Http", { request: requestShape(request) });
  response.json({ v1: true, echo: requestShape(request) });
});
exports.v1Callable = functionsV1.https.onCall((data, context) => {
  record("v1Callable", { data: safe(data), context: { auth: context.auth ? { uid: context.auth.uid, token: safe(context.auth.token) } : null, app: context.app === undefined ? { $undefined: true } : safe(context.app), instanceIdToken: context.instanceIdToken === undefined ? { $undefined: true } : context.instanceIdToken, rawRequest: context.rawRequest ? { method: context.rawRequest.method, path: context.rawRequest.path } : null } });
  if (data && data.throwCode) throw new functionsV1.https.HttpsError(data.throwCode, data.message || "v1 " + data.throwCode, data.details);
  return { echo: safe(data), v1: true };
});
exports.v1Region = functionsV1.region("${ALT_REGION}").https.onRequest((request, response) => {
  record("v1Region", { request: requestShape(request) });
  response.json({ v1Region: "${ALT_REGION}" });
});
exports.v1Options = functionsV1.runWith({ timeoutSeconds: 120, memory: "512MB" }).https.onRequest((request, response) => {
  record("v1Options", { request: requestShape(request) });
  response.json({ options: true });
});
`;
}

export function esmSource(): string {
  return `import fs from "node:fs";
import { onRequest, onCall } from "firebase-functions/v2/https";
const OBSERVATIONS = process.env.PHASE_H_OBSERVATIONS_PATH;
function record(handler, extra) {
  fs.appendFileSync(OBSERVATIONS, JSON.stringify({ handler, pid: process.pid, cwd: process.cwd(), env: { FUNCTION_TARGET: process.env.FUNCTION_TARGET, FUNCTION_SIGNATURE_TYPE: process.env.FUNCTION_SIGNATURE_TYPE, K_SERVICE: process.env.K_SERVICE }, ...extra }) + "\\n");
}
export const esmHttp = onRequest((request, response) => {
  record("esmHttp", { path: request.path });
  response.json({ esm: true, path: request.path });
});
export const esmCallable = onCall((request) => {
  record("esmCallable", { data: request.data });
  return { esm: true, data: request.data };
});
`;
}

export function yamlSource(): string {
  return `${OBSERVE_PRELUDE}
// Plain handlers; the static functions.yaml in this directory describes them.
exports.yamlHttp = (request, response) => {
  record("yamlHttp", { request: requestShape(request) });
  response.json({ manifest: "static", path: request.path });
};
exports.yamlEvent = (event) => {
  record("yamlEvent", { event: projectEvent(event) });
};
`;
}

export const STATIC_MANIFEST = `specVersion: v1alpha1
endpoints:
  yamlHttp:
    platform: gcfv2
    region:
      - ${REGION}
    entryPoint: yamlHttp
    httpsTrigger: {}
  yamlEvent:
    platform: gcfv2
    region:
      - ${REGION}
    entryPoint: yamlEvent
    eventTrigger:
      eventType: google.cloud.firestore.document.v1.created
      eventFilters:
        database: "(default)"
        namespace: "(default)"
      eventFilterPathPatterns:
        document: manifested/{id}
      retry: false
`;

export function brokenSource(): string {
  return `const { onRequest } = require("firebase-functions/v2/https");
exports.neverLoads = onRequest((request, response) => response.json({ never: true }));
throw new Error("synthetic load failure: this codebase refuses to load");
`;
}

export function badEnvSource(): string {
  return `const { onRequest } = require("firebase-functions/v2/https");
exports.badEnvHttp = onRequest((request, response) => response.json({ badEnv: true }));
`;
}

export const PRIMARY_ENV_FILES: Readonly<Record<string, string>> = {
  ".env": [
    "# base file",
    "SYNTHETIC_A=from-dotenv",
    "SYNTHETIC_B=from-dotenv",
    "SYNTHETIC_C=from-dotenv",
    "SYNTHETIC_QUOTED=\"double quoted\\nwith newline and \\\"escapes\\\"\"",
    "SYNTHETIC_SINGLE='single \\n keeps backslash'",
    "export SYNTHETIC_EXPORTED=exported",
    "SYNTHETIC_TRAILING=value # trailing comment",
    "SYNTHETIC_EMPTY=",
    "SYNTHETIC_MULTILINE=\"line one",
    "line two\"",
    "",
  ].join("\n"),
  [`.env.${PROJECT_ID}`]: "SYNTHETIC_B=from-project-file\nSYNTHETIC_PROJECT_ONLY=yes\n",
  ".env.local": "SYNTHETIC_C=from-local\nSYNTHETIC_LOCAL_ONLY=yes\n",
  ".secret.local": "SECRET_DECLARED=declared-secret-value\nSECRET_UNDECLARED=undeclared-secret-value\n",
  ".runtimeconfig.json": JSON.stringify({ synthetic: { legacy: "runtimeconfig" } }),
};

export const SECONDARY_ENV_FILES: Readonly<Record<string, string>> = {
  ".env": "SYNTHETIC_SECONDARY=only-in-secondary\n",
};

export const BAD_ENV_FILES: Readonly<Record<string, string>> = {
  ".env": "lowercase_key=not-allowed\nFIREBASE_RESERVED=not-allowed\n",
};

export const EXTENSION_SPEC = `name: synthetic
version: 0.1.0
specVersion: v1beta
displayName: Synthetic oracle extension
description: Exercises every emulated extension trigger kind and parameter type.
license: Apache-2.0
billingRequired: false
apis: []
roles: []
externalServices: []
resources:
  - name: httpFn
    type: firebaseextensions.v1beta.function
    description: HTTPS resource
    properties:
      location: \${param:LOCATION}
      runtime: nodejs22
      httpsTrigger: {}
  - name: firestoreFn
    type: firebaseextensions.v1beta.function
    description: Firestore v1 resource on the parameterised collection
    properties:
      location: \${param:LOCATION}
      runtime: nodejs22
      timeout: 120s
      availableMemoryMb: 512
      eventTrigger:
        eventType: providers/cloud.firestore/eventTypes/document.write
        resource: projects/\${param:PROJECT_ID}/databases/(default)/documents/\${param:COLLECTION}/{docId}
  - name: storageFn
    type: firebaseextensions.v1beta.function
    description: Storage finalize resource on the parameterised bucket
    properties:
      location: \${LOCATION}
      runtime: nodejs22
      eventTrigger:
        eventType: google.storage.object.finalize
        resource: projects/_/buckets/\${param:BUCKET}
  - name: authFn
    type: firebaseextensions.v1beta.function
    description: Auth user create resource
    properties:
      location: \${param:LOCATION}
      runtime: nodejs22
      eventTrigger:
        eventType: providers/firebase.auth/eventTypes/user.create
        resource: projects/\${param:PROJECT_ID}
  - name: scheduledFn
    type: firebaseextensions.v1beta.function
    description: Scheduled resource
    properties:
      location: \${param:LOCATION}
      runtime: nodejs22
      scheduleTrigger:
        schedule: every 24 hours
  - name: queueFn
    type: firebaseextensions.v1beta.function
    description: Task queue resource (firebase-tools 15.22.0 drops it)
    properties:
      location: \${param:LOCATION}
      runtime: nodejs22
      taskQueueTrigger: {}
  - name: v2Fn
    type: firebaseextensions.v1beta.v2function
    description: Second-generation Firestore resource
    properties:
      location: \${param:LOCATION}
      buildConfig:
        runtime: nodejs22
      serviceConfig:
        timeoutSeconds: 90
        availableMemory: 256M
      eventTrigger:
        eventType: google.cloud.firestore.document.v1.written
        triggerRegion: \${param:LOCATION}
        eventFilters:
          - attribute: document
            value: \${param:COLLECTION}-v2/{docId}
            operator: match-path-pattern
params:
  - param: LOCATION
    label: Location
    type: select
    options:
      - label: Iowa
        value: ${REGION}
      - label: Belgium
        value: ${ALT_REGION}
    default: ${REGION}
    required: true
  - param: COLLECTION
    label: Collection
    type: string
    default: synthetic-items
    required: true
  - param: BUCKET
    label: Bucket
    type: string
    default: \${STORAGE_BUCKET}
    required: true
  - param: MODE
    label: Mode
    type: select
    options:
      - label: Fast
        value: fast
      - label: Slow
        value: slow
    default: fast
    required: true
  - param: TAGS
    label: Tags
    type: multiSelect
    options:
      - label: Alpha
        value: alpha
      - label: Beta
        value: beta
    default: alpha,beta
    required: false
  - param: API_KEY
    label: API key
    type: secret
    required: true
  - param: OPTIONAL_NOTE
    label: Optional note
    type: string
    required: false
  - param: DERIVED
    label: Derived from another param
    type: string
    default: \${param:COLLECTION}-derived
    required: true
events:
  - type: ${EXTENSION_EVENT_TYPE}
    description: Emitted by httpFn when asked to publish.
  - type: ${CUSTOM_EVENT_TYPE_UNLISTENED}
    description: Declared but never subscribed by user code.
lifecycleEvents:
  onInstall:
    function: scheduledFn
    processingMessage: Synthetic install task
`;

export function extensionSource(): string {
  return `${OBSERVE_PRELUDE}
const functionsV1 = require("firebase-functions/v1");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { getEventarc } = require("firebase-admin/eventarc");
admin.initializeApp();
exports.httpFn = functionsV1.https.onRequest(async (request, response) => {
  record("ext-httpFn", { request: requestShape(request) });
  if (request.query.publish) {
    const channel = getEventarc().channel(process.env.EVENTARC_CHANNEL, { allowedEventTypes: process.env.ALLOWED_EVENT_TYPES });
    await channel.publish({ type: request.query.publish, subject: "synthetic/subject", data: { published: true, unicode: "火🔥" } });
    response.json({ published: request.query.publish });
    return;
  }
  response.json({ extension: process.env.EXT_INSTANCE_ID, mode: process.env.MODE, note: process.env.OPTIONAL_NOTE === undefined ? null : process.env.OPTIONAL_NOTE });
});
exports.firestoreFn = functionsV1.firestore.document("synthetic-items/{docId}").onWrite((change, context) => {
  record("ext-firestoreFn", { change: { before: snapshot(change.before), after: snapshot(change.after) }, context: safe(context) });
});
exports.storageFn = functionsV1.storage.object().onFinalize((object, context) => {
  record("ext-storageFn", { object: safe(object), context: safe(context) });
});
exports.authFn = functionsV1.auth.user().onCreate((user, context) => {
  record("ext-authFn", { user: safe(user), context: safe(context) });
});
exports.scheduledFn = functionsV1.pubsub.schedule("every 24 hours").onRun((context) => {
  record("ext-scheduledFn", { context: safe(context) });
});
exports.queueFn = functionsV1.https.onRequest((request, response) => {
  record("ext-queueFn", { request: requestShape(request) });
  response.json({ queue: true });
});
exports.v2Fn = onDocumentWritten("unused-in-code/{docId}", (event) => {
  record("ext-v2Fn", { event: projectEvent(event) });
});
`;
}

export const EXTENSION_ENV_FILES: Readonly<Record<string, string>> = {
  [`${EXTENSION_INSTANCE}.env`]: [
    `LOCATION=${REGION}`,
    "COLLECTION=synthetic-items",
    `BUCKET=${DEFAULT_BUCKET}`,
    "MODE=slow",
    "TAGS=beta",
    `EVENTARC_CHANNEL=${EVENTARC_CHANNEL}`,
    `ALLOWED_EVENT_TYPES=${EXTENSION_EVENT_TYPE}`,
    "",
  ].join("\n"),
  [`${EXTENSION_INSTANCE}.env.local`]: "OPTIONAL_NOTE=from-env-local\n",
  [`${EXTENSION_INSTANCE}.secret.local`]: "API_KEY=synthetic-api-key-value\n",
};

const json = (value: unknown): StepBody => ({ kind: "json", json: value });
const httpPath = (region: string, name: string, suffix = ""): string => `/{{project}}/${region}/${name}${suffix}`;
const trigger = (key: string): string => `/functions/projects/{{project}}/triggers/${key}`;

function step(id: string, action: Action, extra: Partial<Omit<Step, "id" | "action">> = {}): Step {
  return { id, action, ...extra };
}

export const PROGRAMS: readonly Program[] = [
  // ---------------------------------------------------------------- discovery
  {
    id: "discovery-backends-inventory",
    category: "discovery-and-inventory",
    description: "GET /backends after readiness: every codebase, the static manifest, the broken codebases and the local extension backend.",
    steps: [
      step("backends", { kind: "http", method: "GET", path: "/backends" }),
      step("backends-cors", { kind: "http", method: "OPTIONS", path: "/backends", headers: { origin: "http://localhost:4000", "access-control-request-method": "GET" } }),
      step("hub-emulators", { kind: "hub", method: "GET", path: "/emulators" }),
      step("startup-logs", { kind: "logs", pattern: "functions" }),
    ],
  },
  {
    id: "discovery-unknown-routes",
    category: "discovery-and-inventory",
    description: "404 bodies for an unknown function id (lists every registered trigger key), an unknown region, an unknown project and an unknown path.",
    steps: [
      step("unknown-function", { kind: "http", method: "GET", path: httpPath(REGION, "nope") }),
      step("unknown-region", { kind: "http", method: "GET", path: httpPath("mars-north1", "httpEcho") }),
      step("unknown-project", { kind: "http", method: "GET", path: `/other-project/${REGION}/httpEcho` }),
      step("unknown-path", { kind: "http", method: "GET", path: "/nope" }),
      step("root", { kind: "http", method: "GET", path: "/" }),
      step("trigger-route-get", { kind: "http", method: "GET", path: trigger("us-central1-docWritten-0") }),
      step("trigger-unknown", { kind: "http", method: "POST", path: trigger("us-central1-missing-0"), body: json({}) }),
    ],
  },
  {
    id: "discovery-regions",
    category: "discovery-and-inventory",
    description: "Explicit and multi-region deployments answer on their region path only.",
    steps: [
      step("alt-region", { kind: "http", method: "GET", path: httpPath(ALT_REGION, "httpRegion") }, { expect: ["httpRegion"] }),
      step("alt-region-on-default", { kind: "http", method: "GET", path: httpPath(REGION, "httpRegion") }),
      step("multi-default", { kind: "http", method: "GET", path: httpPath(REGION, "httpMultiRegion") }, { expect: ["httpMultiRegion"] }),
      step("multi-alt", { kind: "http", method: "GET", path: httpPath(ALT_REGION, "httpMultiRegion") }, { expect: ["httpMultiRegion"] }),
      step("v1-region", { kind: "http", method: "GET", path: httpPath(ALT_REGION, "v1Region") }, { expect: ["v1Region"] }),
      step("callable-region", { kind: "http", method: "POST", path: httpPath(ALT_REGION, "callableRegion"), body: json({ data: 1 }) }, { expect: ["callableRegion"] }),
    ],
  },
  {
    id: "discovery-codebases",
    category: "discovery-and-inventory",
    description: "Secondary, ESM and static-manifest codebases serve; the broken and invalid-dotenv codebases export nothing.",
    steps: [
      step("secondary-http", { kind: "http", method: "GET", path: httpPath(REGION, "secondaryHttp") }, { expect: ["secondaryHttp"] }),
      step("secondary-callable", { kind: "http", method: "POST", path: httpPath(REGION, "secondaryCallable"), body: json({ data: { hello: "secondary" } }) }, { expect: ["secondaryCallable"] }),
      step("esm-http", { kind: "http", method: "GET", path: httpPath(REGION, "esmHttp", "/sub") }, { expect: ["esmHttp"] }),
      step("esm-callable", { kind: "http", method: "POST", path: httpPath(REGION, "esmCallable"), body: json({ data: [1, 2] }) }, { expect: ["esmCallable"] }),
      step("yaml-http", { kind: "http", method: "GET", path: httpPath(REGION, "yamlHttp", "/static?x=1") }, { expect: ["yamlHttp"] }),
      step("yaml-event", { kind: "firestore", op: "set", path: "manifested/one", fields: { via: "static-manifest" } }, { expect: ["yamlEvent"] }),
      step("broken-never-loads", { kind: "http", method: "GET", path: httpPath(REGION, "neverLoads") }),
      step("bad-env-http", { kind: "http", method: "GET", path: httpPath(REGION, "badEnvHttp") }),
      step("load-failure-logs", { kind: "logs", pattern: "Failed to load" }),
    ],
  },
  {
    id: "discovery-ignored-exports",
    category: "discovery-and-inventory",
    description: "A Realtime Database export is discovered but ignored; its trigger route still exists. The task-queue export registers with the Tasks emulator.",
    steps: [
      step("ignored-logs", { kind: "logs", pattern: "ignored because" }),
      step("db-trigger-post", { kind: "http", method: "POST", path: trigger("us-central1-dbIgnored-0"), headers: { "content-type": "application/json" }, body: json({ specversion: "1.0", id: "manual-1", source: "//firebasedatabase.googleapis.com/projects/_/locations/us-central1/instances/x", type: "google.firebase.database.ref.v1.written", time: "2026-01-01T00:00:00Z", data: { data: null, delta: { a: 1 } }, ref: "synthetic/1", firebasedatabasehost: "x", instance: "x", location: "us-central1" }) }, { expect: 1, timeoutMs: 5000 }),
      step("task-queue-http", { kind: "http", method: "POST", path: httpPath(REGION, "taskQueue"), body: json({ data: { job: 1 } }) }, { expect: 1, timeoutMs: 5000 }),
    ],
  },
  // ------------------------------------------------------------------- http
  {
    id: "http-methods-and-shape",
    category: "http",
    description: "Every HTTP method reaches the v2 onRequest handler; the handler records url, path, query, headers, ip and body parsing.",
    steps: [
      step("get", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho") }, { expect: ["httpEcho"] }),
      step("post-json", { kind: "http", method: "POST", path: httpPath(REGION, "httpEcho"), body: json({ a: 1, nested: { b: [true, null, "火🔥"] } }) }, { expect: ["httpEcho"] }),
      step("put-text", { kind: "http", method: "PUT", path: httpPath(REGION, "httpEcho"), body: { kind: "text", text: "plain body 火🔥", contentType: "text/plain; charset=utf-8" } }, { expect: ["httpEcho"] }),
      step("patch-form", { kind: "http", method: "PATCH", path: httpPath(REGION, "httpEcho"), body: { kind: "form", fields: { field: "value", other: "火🔥" } } }, { expect: ["httpEcho"] }),
      step("delete", { kind: "http", method: "DELETE", path: httpPath(REGION, "httpEcho", "?soft=true") }, { expect: ["httpEcho"] }),
      step("head", { kind: "http", method: "HEAD", path: httpPath(REGION, "httpEcho") }, { expect: ["httpEcho"] }),
      step("options-no-cors", { kind: "http", method: "OPTIONS", path: httpPath(REGION, "httpEcho") }, { expect: 0, timeoutMs: 3000 }),
      step("post-bytes", { kind: "http", method: "POST", path: httpPath(REGION, "httpEcho"), body: { kind: "bytes", base64: "AAECA/8=", contentType: "application/octet-stream" } }, { expect: ["httpEcho"] }),
      step("post-invalid-json", { kind: "http", method: "POST", path: httpPath(REGION, "httpEcho"), body: { kind: "text", text: "{not json", contentType: "application/json" } }, { expect: 0, timeoutMs: 3000 }),
      step("post-empty-json", { kind: "http", method: "POST", path: httpPath(REGION, "httpEcho"), body: { kind: "text", text: "", contentType: "application/json" } }, { expect: ["httpEcho"] }),
      step("post-xml", { kind: "http", method: "POST", path: httpPath(REGION, "httpEcho"), body: { kind: "text", text: "<a>1</a>", contentType: "application/xml" } }, { expect: ["httpEcho"] }),
      step("post-large", { kind: "http", method: "POST", path: httpPath(REGION, "httpEcho"), body: { kind: "text", text: "x".repeat(300_000), contentType: "text/plain" } }, { expect: ["httpEcho"] }),
      step("custom-headers", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho"), headers: { "x-custom-one": "1", "x-forwarded-for": "203.0.113.9", "user-agent": "phase-h/1.0", accept: "application/json" } }, { expect: ["httpEcho"] }),
    ],
  },
  {
    id: "http-paths",
    category: "http",
    description: "Sub-paths, query strings, trailing slashes, encoded characters and dot segments under the function route.",
    steps: [
      step("subpath", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "/a/b/c") }, { expect: ["httpEcho"] }),
      step("subpath-query", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "/a?x=1&y=2&y=3&empty=&flag") }, { expect: ["httpEcho"] }),
      step("trailing-slash", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "/") }, { expect: ["httpEcho"] }),
      step("double-slash", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "//double") }, { expect: 1, timeoutMs: 3000 }),
      step("encoded", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "/sp%20ace/%E7%81%AB?q=%F0%9F%94%A5") }, { expect: ["httpEcho"] }),
      step("dot-segments", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "/a/../b") }, { expect: 1, timeoutMs: 3000 }),
      step("query-only", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?only=query") }, { expect: ["httpEcho"] }),
      step("name-prefix", { kind: "http", method: "GET", path: httpPath(REGION, "httpEchoNot") }),
    ],
  },
  {
    id: "http-responses",
    category: "http",
    description: "Status codes, custom headers, redirects, empty bodies, text bodies and chunked streaming responses pass through the proxy.",
    steps: [
      step("status-201", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=status&code=201") }, { expect: ["httpEcho"] }),
      step("status-404", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=status&code=404") }, { expect: ["httpEcho"] }),
      step("status-500", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=status&code=500") }, { expect: ["httpEcho"] }),
      step("redirect", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=redirect") }, { expect: ["httpEcho"] }),
      step("empty-204", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=empty") }, { expect: ["httpEcho"] }),
      step("text", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=text") }, { expect: ["httpEcho"] }),
      step("stream", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=stream") }, { expect: ["httpEcho"] }),
      step("header-mode", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho"), headers: { "x-synthetic-mode": "status" } }, { expect: ["httpEcho"] }),
    ],
  },
  {
    id: "http-errors-and-timeouts",
    category: "http",
    description: "Synchronous throw, asynchronous rejection, throw after headers, a handler that never responds, and a per-function timeout.",
    steps: [
      step("throw", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=throw") }, { expect: ["httpEcho"] }),
      step("reject", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=reject") }, { expect: ["httpEcho"] }),
      step("throw-after-headers", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=throw-after-headers"), clientTimeoutMs: 4000 }, { expect: ["httpEcho"] }),
      step("timeout", { kind: "http", method: "GET", path: httpPath(REGION, "httpTimeout"), clientTimeoutMs: 8000 }, { expect: ["httpTimeout"] }),
      step("after-timeout", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho") }, { expect: ["httpEcho"] }),
      step("timeout-logs", { kind: "logs", pattern: "timed out" }),
    ],
  },
  {
    id: "http-cors",
    category: "cors",
    description: "SDK-level CORS on onRequest({cors}) for preflights and simple requests with allowed, disallowed and absent origins.",
    steps: [
      step("all-preflight", { kind: "http", method: "OPTIONS", path: httpPath(REGION, "httpCorsAll"), headers: { origin: "https://any.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-custom" } }),
      step("all-get", { kind: "http", method: "GET", path: httpPath(REGION, "httpCorsAll"), headers: { origin: "https://any.example" } }, { expect: ["httpCorsAll"] }),
      step("origin-preflight-allowed", { kind: "http", method: "OPTIONS", path: httpPath(REGION, "httpCorsOrigin"), headers: { origin: "https://allowed.example", "access-control-request-method": "GET" } }),
      step("origin-preflight-denied", { kind: "http", method: "OPTIONS", path: httpPath(REGION, "httpCorsOrigin"), headers: { origin: "https://denied.example", "access-control-request-method": "GET" } }),
      step("origin-get-allowed", { kind: "http", method: "GET", path: httpPath(REGION, "httpCorsOrigin"), headers: { origin: "https://allowed.example" } }, { expect: ["httpCorsOrigin"] }),
      step("origin-get-denied", { kind: "http", method: "GET", path: httpPath(REGION, "httpCorsOrigin"), headers: { origin: "https://denied.example" } }, { expect: ["httpCorsOrigin"] }),
      step("no-origin", { kind: "http", method: "GET", path: httpPath(REGION, "httpCorsOrigin") }, { expect: ["httpCorsOrigin"] }),
      step("plain-preflight", { kind: "http", method: "OPTIONS", path: httpPath(REGION, "httpEcho"), headers: { origin: "https://any.example", "access-control-request-method": "POST" } }, { expect: 0, timeoutMs: 3000 }),
    ],
  },
  {
    id: "http-v1",
    category: "http",
    description: "First-generation https.onRequest, region and runWith options on the secondary codebase.",
    steps: [
      step("v1-get", { kind: "http", method: "GET", path: httpPath(REGION, "v1Http", "/legacy?x=1") }, { expect: ["v1Http"] }),
      step("v1-post", { kind: "http", method: "POST", path: httpPath(REGION, "v1Http"), body: json({ legacy: true }) }, { expect: ["v1Http"] }),
      step("v1-options", { kind: "http", method: "GET", path: httpPath(REGION, "v1Options") }, { expect: ["v1Options"] }),
      step("v1-preflight", { kind: "http", method: "OPTIONS", path: httpPath(REGION, "v1Http"), headers: { origin: "https://any.example", "access-control-request-method": "POST" } }, { expect: 1, timeoutMs: 3000 }),
    ],
  },
  {
    id: "http-admin-sdk-wiring",
    category: "http",
    description: "The handler's Admin SDK reaches the emulated Firestore through the injected environment.",
    steps: [
      step("round-trip", { kind: "http", method: "GET", path: httpPath(REGION, "adminRoundTrip", "?id=wired") }, { expect: ["adminRoundTrip"] }),
      step("read-back", { kind: "firestore", op: "update", path: "probe/wired", fields: { at: "fixed", via: "admin", seen: true } }),
    ],
  },
  // --------------------------------------------------------------- callable
  {
    id: "callable-envelopes",
    category: "callable",
    description: "Data shapes, missing data, invalid bodies and wrong methods on a v2 onCall.",
    steps: [
      step("object", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: { n: 1, s: "火🔥", b: false, list: [1, "two", null], nested: { deep: { deeper: true } } } }) }, { expect: ["callableEcho"] }),
      step("null", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: null }) }, { expect: ["callableEcho"] }),
      step("string", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: "just a string" }) }, { expect: ["callableEcho"] }),
      step("number", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: 42.5 }) }, { expect: ["callableEcho"] }),
      step("array", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: [1, [2, [3]]] }) }, { expect: ["callableEcho"] }),
      step("long-encoded", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: { "@type": "type.googleapis.com/google.protobuf.Int64Value", value: "9007199254740993" } }) }, { expect: ["callableEcho"] }),
      step("missing-data", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ notData: 1 }) }, { expect: 0, timeoutMs: 3000 }),
      step("empty-object", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({}) }, { expect: 0, timeoutMs: 3000 }),
      step("invalid-json", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: { kind: "text", text: "{bad", contentType: "application/json" } }, { expect: 0, timeoutMs: 3000 }),
      step("text-body", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: { kind: "text", text: "data=1", contentType: "text/plain" } }, { expect: 0, timeoutMs: 3000 }),
      step("get-method", { kind: "http", method: "GET", path: httpPath(REGION, "callableEcho") }, { expect: 0, timeoutMs: 3000 }),
      step("put-method", { kind: "http", method: "PUT", path: httpPath(REGION, "callableEcho"), body: json({ data: 1 }) }, { expect: 0, timeoutMs: 3000 }),
      step("return-undefined", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: { returnUndefined: true } }) }, { expect: ["callableEcho"] }),
      step("extra-keys", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: 1, extra: "ignored?" }) }, { expect: 0, timeoutMs: 3000 }),
    ],
  },
  {
    id: "callable-errors",
    category: "callable",
    description: "HttpsError status mapping for every canonical code, details passthrough, and unhandled failures.",
    steps: [
      ...["ok", "cancelled", "unknown", "invalid-argument", "deadline-exceeded", "not-found", "already-exists", "permission-denied", "resource-exhausted", "failed-precondition", "aborted", "out-of-range", "unimplemented", "internal", "unavailable", "data-loss", "unauthenticated"].map((code) =>
        step(`code-${code}`, { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: { throwCode: code, details: { code, unicode: "火🔥" } } }) }, { expect: ["callableEcho"] }),
      ),
      step("bad-code", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: { throwCode: "not-a-code" } }) }, { expect: ["callableEcho"] }),
      step("plain-throw", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: { throwPlain: true } }) }, { expect: ["callableEcho"] }),
      step("plain-reject", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: { rejectPlain: true } }) }, { expect: ["callableEcho"] }),
      step("no-details", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: { throwCode: "not-found", message: "custom message" } }) }, { expect: ["callableEcho"] }),
    ],
  },
  {
    id: "callable-auth",
    category: "callable",
    description: "Authorization headers as seen by onCall: valid, sub-only, expired, malformed, wrong scheme, plus instance id and App Check headers.",
    steps: [
      step("bearer-alice", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), auth: "@alice", body: json({ data: 1 }) }, { expect: ["callableEcho"] }),
      step("bearer-admin-claim", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), auth: "@admin", body: json({ data: 1 }) }, { expect: ["callableEcho"] }),
      step("bearer-subonly", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), auth: "@subonly", body: json({ data: 1 }) }, { expect: ["callableEcho"] }),
      step("bearer-expired", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), auth: "@expired", body: json({ data: 1 }) }, { expect: 1, timeoutMs: 3000 }),
      step("bearer-garbage", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), headers: { authorization: "Bearer not.a.jwt" }, body: json({ data: 1 }) }, { expect: 1, timeoutMs: 3000 }),
      step("bearer-empty", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), headers: { authorization: "Bearer " }, body: json({ data: 1 }) }, { expect: 0, timeoutMs: 3000 }),
      step("basic-scheme", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), headers: { authorization: "Basic abc" }, body: json({ data: 1 }) }, { expect: 0, timeoutMs: 3000 }),
      step("lowercase-bearer", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), headers: { authorization: "bearer {{jwt:alice}}" }, body: json({ data: 1 }) }, { expect: 1, timeoutMs: 3000 }),
      step("auth-required-without", { kind: "http", method: "POST", path: httpPath(REGION, "callableAuthRequired"), body: json({ data: 1 }) }, { expect: ["callableAuthRequired"] }),
      step("auth-required-with", { kind: "http", method: "POST", path: httpPath(REGION, "callableAuthRequired"), auth: "@alice", body: json({ data: 1 }) }, { expect: ["callableAuthRequired"] }),
      step("instance-id-token", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), headers: { "firebase-instance-id-token": "synthetic-fcm-token" }, body: json({ data: 1 }) }, { expect: ["callableEcho"] }),
      step("app-check-header", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), headers: { "x-firebase-appcheck": "{{jwt:alice}}" }, body: json({ data: 1 }) }, { expect: 1, timeoutMs: 3000 }),
      step("app-check-enforced-without", { kind: "http", method: "POST", path: httpPath(REGION, "callableAppCheck"), body: json({ data: 1 }) }, { expect: 0, timeoutMs: 3000 }),
      step("app-check-enforced-with", { kind: "http", method: "POST", path: httpPath(REGION, "callableAppCheck"), headers: { "x-firebase-appcheck": "{{jwt:alice}}" }, body: json({ data: 1 }) }, { expect: 1, timeoutMs: 3000 }),
    ],
  },
  {
    id: "callable-v1",
    category: "callable",
    description: "First-generation https.onCall envelope, context and errors.",
    steps: [
      step("v1-data", { kind: "http", method: "POST", path: httpPath(REGION, "v1Callable"), body: json({ data: { legacy: true, unicode: "火🔥" } }) }, { expect: ["v1Callable"] }),
      step("v1-auth", { kind: "http", method: "POST", path: httpPath(REGION, "v1Callable"), auth: "@alice", body: json({ data: 1 }) }, { expect: ["v1Callable"] }),
      step("v1-error", { kind: "http", method: "POST", path: httpPath(REGION, "v1Callable"), body: json({ data: { throwCode: "failed-precondition", details: [1, 2] } }) }, { expect: ["v1Callable"] }),
      step("v1-missing-data", { kind: "http", method: "POST", path: httpPath(REGION, "v1Callable"), body: json({}) }, { expect: 0, timeoutMs: 3000 }),
      step("v1-get", { kind: "http", method: "GET", path: httpPath(REGION, "v1Callable") }, { expect: 0, timeoutMs: 3000 }),
    ],
  },
  {
    id: "callable-streaming",
    category: "callable-streaming",
    description: "Server-sent chunks with Accept: text/event-stream, non-streaming clients on a streaming function, and an error after a chunk.",
    steps: [
      step("stream-three", { kind: "http", method: "POST", path: httpPath(REGION, "callableStream"), headers: { accept: "text/event-stream" }, body: json({ data: { count: 3 } }) }, { expect: ["callableStream"] }),
      step("stream-zero", { kind: "http", method: "POST", path: httpPath(REGION, "callableStream"), headers: { accept: "text/event-stream" }, body: json({ data: { count: 0 } }) }, { expect: ["callableStream"] }),
      step("stream-error-after-chunk", { kind: "http", method: "POST", path: httpPath(REGION, "callableStream"), headers: { accept: "text/event-stream" }, body: json({ data: { count: 3, failAt: 2 } }) }, { expect: ["callableStream"] }),
      step("stream-error-before-chunk", { kind: "http", method: "POST", path: httpPath(REGION, "callableStream"), headers: { accept: "text/event-stream" }, body: json({ data: { count: 3, failAt: 1 } }) }, { expect: ["callableStream"] }),
      step("no-accept", { kind: "http", method: "POST", path: httpPath(REGION, "callableStream"), body: json({ data: { count: 2 } }) }, { expect: ["callableStream"] }),
      step("accept-json", { kind: "http", method: "POST", path: httpPath(REGION, "callableStream"), headers: { accept: "application/json" }, body: json({ data: { count: 2 } }) }, { expect: ["callableStream"] }),
      step("stream-auth", { kind: "http", method: "POST", path: httpPath(REGION, "callableStream"), auth: "@alice", headers: { accept: "text/event-stream" }, body: json({ data: { count: 1 } }) }, { expect: ["callableStream"] }),
      step("stream-non-streaming-function", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), headers: { accept: "text/event-stream" }, body: json({ data: 1 }) }, { expect: ["callableEcho"] }),
      step("stream-preflight", { kind: "http", method: "OPTIONS", path: httpPath(REGION, "callableStream"), headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization,accept" } }),
    ],
  },
  {
    id: "callable-cors",
    category: "cors",
    description: "Preflight and simple requests on v1 and v2 callables from any origin (the SDK enables CORS for callables).",
    steps: [
      step("v2-preflight", { kind: "http", method: "OPTIONS", path: httpPath(REGION, "callableEcho"), headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization,x-firebase-appcheck" } }),
      step("v2-post-origin", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), headers: { origin: "https://app.example" }, body: json({ data: 1 }) }, { expect: ["callableEcho"] }),
      step("v1-preflight", { kind: "http", method: "OPTIONS", path: httpPath(REGION, "v1Callable"), headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" } }),
      step("v1-post-origin", { kind: "http", method: "POST", path: httpPath(REGION, "v1Callable"), headers: { origin: "https://app.example" }, body: json({ data: 1 }) }, { expect: ["v1Callable"] }),
      step("preflight-no-method", { kind: "http", method: "OPTIONS", path: httpPath(REGION, "callableEcho"), headers: { origin: "https://app.example" } }),
    ],
  },
  // -------------------------------------------------------------- firestore
  {
    id: "firestore-v2-lifecycle",
    category: "firestore-events",
    description: "Create, update and delete one document; created/updated/deleted/written handlers observe CloudEvents with snapshots, params and attributes.",
    steps: [
      step("create", { kind: "firestore", op: "set", path: "items/alpha", fields: { name: "alpha", count: 1, tags: ["x"], nested: { ok: true }, unicode: "火🔥" } }, { expect: ["docCreated", "docWritten"] }),
      step("update", { kind: "firestore", op: "update", path: "items/alpha", fields: { count: 2, extra: null } }, { expect: ["docUpdated", "docWritten"] }),
      step("delete", { kind: "firestore", op: "delete", path: "items/alpha" }, { expect: ["docDeleted", "docWritten"] }),
      step("recreate", { kind: "firestore", op: "set", path: "items/alpha", fields: { name: "again" } }, { expect: ["docCreated", "docWritten"] }),
      step("noop-update", { kind: "firestore", op: "update", path: "items/alpha", fields: { name: "again" } }, { expect: 2, timeoutMs: 4000 }),
    ],
  },
  {
    id: "firestore-v2-auth-context",
    category: "firestore-events",
    description: "WithAuthContext handlers observe authType and authId for an owner write, a user-token REST write and an admin write.",
    steps: [
      step("owner-write", { kind: "firestore", op: "set", path: "audited/one", fields: { by: "owner" } }, { expect: ["docWrittenAuth", "docCreatedAuth"] }),
      step("user-write", { kind: "firestore", op: "set", path: "audited/two", fields: { by: "alice" }, auth: "@alice" }, { expect: ["docWrittenAuth", "docCreatedAuth"] }),
      step("user-update", { kind: "firestore", op: "update", path: "audited/two", fields: { by: "alice-again" }, auth: "@alice" }, { expect: ["docWrittenAuth"] }),
      step("admin-delete", { kind: "firestore", op: "delete", path: "audited/two", auth: "@admin" }, { expect: ["docWrittenAuth"] }),
    ],
  },
  {
    id: "firestore-v1-lifecycle",
    category: "firestore-events",
    description: "First-generation onCreate/onUpdate/onDelete/onWrite envelopes: change snapshots and context.",
    steps: [
      step("create", { kind: "firestore", op: "set", path: "legacy/one", fields: { n: 1, t: "火🔥", when: { $timestamp: "2026-01-02T03:04:05.678Z" }, geo: { $geo: [1.5, -2.5] }, ref: { $ref: "items/alpha" }, bytes: { $bytes: "AQID" } } }, { expect: ["v1DocCreate", "v1DocWrite"] }),
      step("update", { kind: "firestore", op: "update", path: "legacy/one", fields: { n: 2 } }, { expect: ["v1DocUpdate", "v1DocWrite"] }),
      step("delete", { kind: "firestore", op: "delete", path: "legacy/one" }, { expect: ["v1DocDelete", "v1DocWrite"] }),
    ],
  },
  {
    id: "firestore-path-patterns",
    category: "firestore-events",
    description: "Nested wildcards, multi-segment wildcards, exact documents, non-matching paths and a regional trigger.",
    steps: [
      step("nested", { kind: "firestore", op: "set", path: "tenants/t1/rooms/r1/messages/m1", fields: { text: "hi" } }, { expect: ["docNested"] }),
      step("nested-shallow-miss", { kind: "firestore", op: "set", path: "tenants/t1/rooms/r1", fields: { name: "room" } }, { expect: 0, timeoutMs: 2500 }),
      step("deep-one", { kind: "firestore", op: "set", path: "deep/a", fields: { level: 1 } }, { expect: ["docDeep"] }),
      step("deep-three", { kind: "firestore", op: "set", path: "deep/a/b/c", fields: { level: 3 } }, { expect: ["docDeep"] }),
      step("deep-five", { kind: "firestore", op: "set", path: "deep/a/b/c/d/e", fields: { level: 5 } }, { expect: ["docDeep"] }),
      step("exact", { kind: "firestore", op: "set", path: "config/settings", fields: { theme: "dark" } }, { expect: ["docExact"] }),
      step("exact-miss", { kind: "firestore", op: "set", path: "config/other", fields: { theme: "light" } }, { expect: 0, timeoutMs: 2500 }),
      step("regional", { kind: "firestore", op: "set", path: "regional/r", fields: { region: ALT_REGION } }, { expect: ["docRegion"] }),
      step("unrelated", { kind: "firestore", op: "set", path: "unrelated/u", fields: { x: 1 } }, { expect: 0, timeoutMs: 2500 }),
    ],
  },
  {
    id: "firestore-batches",
    category: "firestore-events",
    description: "One commit with three writes yields three events; handler failures and slow handlers do not block delivery.",
    steps: [
      step("commit", { kind: "firestore-commit", writes: [{ op: "set", path: "items/b1", fields: { batch: 1 } }, { op: "set", path: "items/b2", fields: { batch: 2 } }, { op: "delete", path: "items/alpha" }] }, { expect: ["docCreated", "docCreated", "docDeleted", "docWritten", "docWritten", "docWritten"] }),
      step("throwing", { kind: "firestore", op: "set", path: "throwing/t1", fields: { boom: true } }, { expect: ["docThrows"] }),
      step("throwing-again", { kind: "firestore", op: "set", path: "throwing/t2", fields: { boom: true } }, { expect: ["docThrows"], timeoutMs: 6000 }),
      step("slow", { kind: "firestore", op: "set", path: "slow/s1", fields: { slow: true } }, { expect: ["docSlow"], timeoutMs: 8000 }),
      step("handler-error-logs", { kind: "logs", pattern: "handler failure" }),
    ],
  },
  // ---------------------------------------------------------------- storage
  {
    id: "storage-v2-lifecycle",
    category: "storage-events",
    description: "Upload, metadata patch and delete on the default bucket; finalized/metadataUpdated/deleted CloudEvents with StorageObjectData.",
    steps: [
      step("upload", { kind: "storage", op: "upload", bucket: DEFAULT_BUCKET, name: "folder/object one.txt", content: "hello storage 火🔥", contentType: "text/plain", metadata: { owner: "alice" } }, { expect: ["objFinalized", "v1ObjFinalize", "ext-storageFn"] }),
      step("patch", { kind: "storage", op: "patch", bucket: DEFAULT_BUCKET, name: "folder/object one.txt", metadata: { owner: "bob", extra: "yes" } }, { expect: ["objMetadata", "v1ObjMetadata"] }),
      step("overwrite", { kind: "storage", op: "upload", bucket: DEFAULT_BUCKET, name: "folder/object one.txt", content: "second generation", contentType: "text/plain" }, { expect: ["objFinalized", "v1ObjFinalize", "ext-storageFn"] }),
      step("delete", { kind: "storage", op: "delete", bucket: DEFAULT_BUCKET, name: "folder/object one.txt" }, { expect: ["objDeleted", "v1ObjDelete"] }),
    ],
  },
  {
    id: "storage-bucket-filter",
    category: "storage-events",
    description: "A trigger bound to a second bucket fires only for that bucket; default-bucket triggers ignore it.",
    steps: [
      step("second-upload", { kind: "storage", op: "upload", bucket: SECOND_BUCKET, name: "second.bin", content: "AAEC", contentType: "application/octet-stream" }, { expect: ["objSecondBucket"] }),
      step("second-delete", { kind: "storage", op: "delete", bucket: SECOND_BUCKET, name: "second.bin" }, { expect: 0, timeoutMs: 2500 }),
      step("default-upload", { kind: "storage", op: "upload", bucket: DEFAULT_BUCKET, name: "default.bin", content: "AAEC", contentType: "application/octet-stream" }, { expect: ["objFinalized", "v1ObjFinalize", "ext-storageFn"] }),
    ],
  },
  // ----------------------------------------------------------------- pubsub
  {
    id: "pubsub-v2-messages",
    category: "pubsub-and-schedules",
    description: "Published messages with JSON data, plain data, attributes and ordering keys reach two v2 handlers on the same topic.",
    steps: [
      step("json-message", { kind: "pubsub", topic: "synthetic-topic", messages: [{ data: JSON.stringify({ hello: "topic", unicode: "火🔥" }), attributes: { kind: "json", n: "1" } }] }, { expect: ["topicEcho", "topicSecond"] }),
      step("plain-message", { kind: "pubsub", topic: "synthetic-topic", messages: [{ data: "not json", orderingKey: "k1" }] }, { expect: ["topicEcho", "topicSecond"] }),
      step("attributes-only", { kind: "pubsub", topic: "synthetic-topic", messages: [{ attributes: { only: "attributes" } }] }, { expect: ["topicEcho", "topicSecond"] }),
      step("two-messages", { kind: "pubsub", topic: "synthetic-topic", messages: [{ data: "one" }, { data: "two" }] }, { expect: ["topicEcho", "topicEcho", "topicSecond", "topicSecond"] }),
      step("unknown-topic", { kind: "pubsub", topic: "no-such-topic", messages: [{ data: "lost" }] }, { expect: 0, timeoutMs: 2500 }),
    ],
  },
  {
    id: "pubsub-v1-messages",
    category: "pubsub-and-schedules",
    description: "First-generation onPublish message accessors and context.",
    steps: [
      step("json", { kind: "pubsub", topic: "legacy-topic", messages: [{ data: JSON.stringify({ legacy: true }), attributes: { a: "b" } }] }, { expect: ["v1TopicPublish"] }),
      step("plain", { kind: "pubsub", topic: "legacy-topic", messages: [{ data: "plain 火🔥" }] }, { expect: ["v1TopicPublish"] }),
      step("topics", { kind: "pubsub-list", what: "topics" }),
      step("subscriptions", { kind: "pubsub-list", what: "subscriptions" }),
    ],
  },
  {
    id: "pubsub-schedules",
    category: "pubsub-and-schedules",
    description: "Manual firing of v2 and v1 schedules through the trigger route, and the schedule metadata in the inventory.",
    steps: [
      step("v2-tick", { kind: "http", method: "POST", path: trigger("us-central1-scheduledTick-0"), headers: { "content-type": "application/json" }, body: json({}) }, { expect: ["scheduledTick"] }),
      step("v2-cron", { kind: "http", method: "POST", path: trigger("us-central1-scheduledCron-0"), headers: { "content-type": "application/json" }, body: json({ scheduleTime: "2026-01-01T03:00:00Z" }) }, { expect: ["scheduledCron"] }),
      step("v1-run", { kind: "http", method: "POST", path: trigger("us-central1-v1Scheduled-0"), headers: { "content-type": "application/json" }, body: json({ context: { eventId: "manual", timestamp: "2026-01-01T00:00:00Z", eventType: "google.pubsub.topic.publish", resource: { service: "pubsub.googleapis.com", name: "projects/{{project}}/topics/firebase-schedule-v1Scheduled" } }, data: { data: "e30=" } }) }, { expect: ["v1Scheduled"] }),
      step("v2-tick-empty-body", { kind: "http", method: "POST", path: trigger("us-central1-scheduledTick-0") }, { expect: 1, timeoutMs: 4000 }),
      step("v2-tick-https-route", { kind: "http", method: "POST", path: httpPath(REGION, "scheduledTick"), body: json({}) }, { expect: 0, timeoutMs: 4000 }),
    ],
  },
  // ------------------------------------------------------------------- auth
  {
    id: "auth-v1-user-events",
    category: "auth-events",
    description: "Sign-up and deletion fan out to two onCreate handlers, one onDelete handler and the extension's auth resource.",
    steps: [
      step("sign-up", { kind: "auth", op: "signUp", email: "events@example.test", password: "secret-pass-1", displayName: "Events User" }, { expect: ["v1AuthCreate", "v1AuthCreateSecond", "ext-authFn", "blockCreate"] }),
      step("lookup", { kind: "auth", op: "lookup", from: "sign-up" }),
      step("delete", { kind: "auth", op: "delete", from: "sign-up" }, { expect: ["v1AuthDelete"] }),
    ],
  },
  {
    id: "auth-blocking-create",
    category: "blocking-functions",
    description: "beforeUserCreated: pass-through, claims and display name applied by the handler, rejection with HttpsError, and the seven-second deadline.",
    steps: [
      step("claims-sign-up", { kind: "auth", op: "signUp", email: "claims-user@example.test", password: "secret-pass-2" }, { expect: ["blockCreate", "v1AuthCreate", "v1AuthCreateSecond", "ext-authFn"] }),
      step("claims-lookup", { kind: "auth", op: "lookup", from: "claims-sign-up" }),
      step("claims-sign-in", { kind: "auth", op: "signIn", email: "claims-user@example.test", password: "secret-pass-2" }, { expect: ["blockSignIn"] }),
      step("reject-sign-up", { kind: "auth", op: "signUp", email: "reject-user@example.test", password: "secret-pass-3" }, { expect: ["blockCreate"] }),
      step("reject-lookup-absent", { kind: "auth", op: "signIn", email: "reject-user@example.test", password: "secret-pass-3" }),
      step("slow-sign-up", { kind: "auth", op: "signUp", email: "slow-user@example.test", password: "secret-pass-4" }, { expect: ["blockCreate"], timeoutMs: 15000 }),
      step("blocking-logs", { kind: "logs", pattern: "blocking" }),
    ],
  },
  {
    id: "auth-blocking-sign-in",
    category: "blocking-functions",
    description: "beforeUserSignedIn: session claims returned by the handler and a rejection with details.",
    steps: [
      step("plain-sign-up", { kind: "auth", op: "signUp", email: "nosignin-user@example.test", password: "secret-pass-5" }, { expect: ["blockCreate", "v1AuthCreate", "v1AuthCreateSecond", "ext-authFn"] }),
      step("rejected-sign-in", { kind: "auth", op: "signIn", email: "nosignin-user@example.test", password: "secret-pass-5" }, { expect: ["blockSignIn"] }),
      step("wrong-password", { kind: "auth", op: "signIn", email: "nosignin-user@example.test", password: "wrong" }, { expect: 0, timeoutMs: 2500 }),
      step("claims-sign-in-again", { kind: "auth", op: "signIn", email: "claims-user@example.test", password: "secret-pass-2" }, { expect: ["blockSignIn"] }),
    ],
  },
  // ------------------------------------------------------------ environment
  {
    id: "environment-dotenv-and-system",
    category: "environment",
    description: "The dotenv chain, .secret.local, declared secrets, reserved system variables and emulator host variables as observed by handlers.",
    steps: [
      step("primary-env", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=empty") }, { expect: ["httpEcho"] }),
      step("secrets", { kind: "http", method: "GET", path: httpPath(REGION, "httpSecrets") }, { expect: ["httpSecrets"] }),
      step("secondary-env", { kind: "http", method: "GET", path: httpPath(REGION, "secondaryHttp") }, { expect: ["secondaryHttp"] }),
      step("v1-env", { kind: "http", method: "GET", path: httpPath(REGION, "v1Http") }, { expect: ["v1Http"] }),
      step("event-env", { kind: "firestore", op: "set", path: "items/env", fields: { env: true } }, { expect: ["docCreated", "docWritten"] }),
      step("callable-env", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: "env" }) }, { expect: ["callableEcho"] }),
      step("extension-env", { kind: "http", method: "GET", path: httpPath(REGION, `ext-${EXTENSION_INSTANCE}-httpFn`) }, { expect: ["ext-httpFn"] }),
      step("env-logs", { kind: "logs", pattern: "environment variables" }),
    ],
  },
  // -------------------------------------------------------------- lifecycle
  {
    id: "lifecycle-worker-crash",
    category: "lifecycle",
    description: "A handler that exits its process: the in-flight response, the next invocation of the same and of another function in the codebase.",
    steps: [
      step("crash", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=crash"), clientTimeoutMs: 5000 }, { expect: ["httpEcho"] }),
      step("same-function-after", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=empty") }, { expect: ["httpEcho"], timeoutMs: 15000 }),
      step("other-function-after", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: "after crash" }) }, { expect: ["callableEcho"], timeoutMs: 15000 }),
      step("event-after", { kind: "firestore", op: "set", path: "items/after-crash", fields: { ok: true } }, { expect: ["docCreated", "docWritten"], timeoutMs: 15000 }),
      step("crash-logs", { kind: "logs", pattern: "exited" }),
    ],
  },
  {
    id: "lifecycle-concurrency",
    category: "lifecycle",
    description: "Two slow requests to the same function overlap; a third to another function is not queued behind them.",
    steps: [
      step("overlap", { kind: "http-parallel", requests: [{ method: "GET", path: httpPath(REGION, "httpEcho", "?mode=slow&ms=1500") }, { method: "GET", path: httpPath(REGION, "httpEcho", "?mode=slow&ms=1500") }, { method: "GET", path: httpPath(REGION, "httpEcho", "?mode=slow&ms=1500") }], clientTimeoutMs: 10000 }, { expect: 3, timeoutMs: 10000 }),
      step("slow-plus-other", { kind: "http-parallel", requests: [{ method: "GET", path: httpPath(REGION, "httpEcho", "?mode=slow&ms=1500") }, { method: "GET", path: httpPath(REGION, "secondaryHttp"), delayMs: 200 }, { method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: "parallel" }), delayMs: 200 }], clientTimeoutMs: 10000 }, { expect: 3, timeoutMs: 10000 }),
    ],
  },
  {
    id: "lifecycle-reload",
    category: "lifecycle",
    description: "Editing the primary codebase adds a function, removes one and changes a trigger path; the inventory, routes and trigger keys after the reload.",
    steps: [
      step("before-removable", { kind: "http", method: "GET", path: httpPath(REGION, "removable") }, { expect: ["removable"] }),
      step("before-change", { kind: "firestore", op: "set", path: "before-change/one", fields: { phase: "before" } }, { expect: ["changeMe"] }),
      step("edit", { kind: "file", op: "write", codebase: "primary", relativePath: "index.js", content: "{{primarySourceAfterReload}}" }),
      step("wait-reload", { kind: "wait", ms: 9000 }),
      step("reload-logs", { kind: "logs", pattern: "Loaded functions definitions" }),
      step("backends-after", { kind: "http", method: "GET", path: "/backends" }),
      step("added", { kind: "http", method: "GET", path: httpPath(REGION, "addedLater") }, { expect: ["addedLater"], timeoutMs: 20000 }),
      step("removed", { kind: "http", method: "GET", path: httpPath(REGION, "removable") }),
      step("old-path-miss", { kind: "firestore", op: "set", path: "before-change/two", fields: { phase: "after" } }, { expect: 0, timeoutMs: 3000 }),
      step("new-path-hit", { kind: "firestore", op: "set", path: "after-change/one", fields: { phase: "after" } }, { expect: ["changeMe"], timeoutMs: 10000 }),
      step("existing-still-works", { kind: "firestore", op: "set", path: "items/after-reload", fields: { ok: true } }, { expect: ["docCreated", "docWritten"], timeoutMs: 10000 }),
      step("trigger-key-generation", { kind: "http", method: "POST", path: trigger("us-central1-scheduledTick-0"), headers: { "content-type": "application/json" }, body: json({}) }, { expect: 1, timeoutMs: 4000 }),
      step("trigger-key-generation-1", { kind: "http", method: "POST", path: trigger("us-central1-scheduledTick-1"), headers: { "content-type": "application/json" }, body: json({}) }, { expect: 0, timeoutMs: 4000 }),
      step("restore", { kind: "file", op: "write", codebase: "primary", relativePath: "index.js", content: "{{primarySource}}" }),
      step("wait-restore", { kind: "wait", ms: 9000 }),
      step("restored", { kind: "http", method: "GET", path: httpPath(REGION, "removable") }, { expect: ["removable"], timeoutMs: 20000 }),
    ],
  },
  // ------------------------------------------------------------- extensions
  {
    id: "extensions-local-inventory",
    category: "extensions",
    description: "The local extension's backend in /backends: resolved resources, substituted spec, injected params, secrets and the dropped task-queue resource.",
    steps: [
      step("backends", { kind: "http", method: "GET", path: "/backends" }),
      step("extension-logs", { kind: "logs", pattern: "extensions" }),
      step("missing-trigger-logs", { kind: "logs", pattern: "missing a trigger" }),
      step("queue-route", { kind: "http", method: "GET", path: httpPath(REGION, `ext-${EXTENSION_INSTANCE}-queueFn`) }, { expect: 0, timeoutMs: 3000 }),
    ],
  },
  {
    id: "extensions-triggers",
    category: "extensions",
    description: "HTTPS, Firestore v1, v2function Firestore, schedule and custom-event delivery for the local extension.",
    steps: [
      step("https", { kind: "http", method: "GET", path: httpPath(REGION, `ext-${EXTENSION_INSTANCE}-httpFn`, "/tail?x=1") }, { expect: ["ext-httpFn"] }),
      step("firestore-v1", { kind: "firestore", op: "set", path: "synthetic-items/one", fields: { via: "extension" } }, { expect: ["ext-firestoreFn"] }),
      step("firestore-v1-miss", { kind: "firestore", op: "set", path: "other-items/one", fields: { via: "none" } }, { expect: 0, timeoutMs: 2500 }),
      step("firestore-v2", { kind: "firestore", op: "set", path: "synthetic-items-v2/one", fields: { via: "v2function" } }, { expect: ["ext-v2Fn"] }),
      step("schedule", { kind: "http", method: "POST", path: trigger(`us-central1-ext-${EXTENSION_INSTANCE}-scheduledFn-0`), headers: { "content-type": "application/json" }, body: json({ context: { eventId: "manual", timestamp: "2026-01-01T00:00:00Z", eventType: "google.pubsub.topic.publish", resource: { service: "pubsub.googleapis.com", name: "projects/{{project}}/topics/firebase-schedule-ext-synthetic-scheduledFn" } }, data: { data: "e30=" } }) }, { expect: ["ext-scheduledFn"] }),
      step("publish-listened", { kind: "http", method: "GET", path: httpPath(REGION, `ext-${EXTENSION_INSTANCE}-httpFn`, `?publish=${EXTENSION_EVENT_TYPE}`) }, { expect: ["ext-httpFn", "customEvent"], timeoutMs: 10000 }),
      step("publish-unlistened", { kind: "http", method: "GET", path: httpPath(REGION, `ext-${EXTENSION_INSTANCE}-httpFn`, `?publish=${CUSTOM_EVENT_TYPE_UNLISTENED}`) }, { expect: ["ext-httpFn"], timeoutMs: 5000 }),
      step("publish-undeclared", { kind: "http", method: "GET", path: httpPath(REGION, `ext-${EXTENSION_INSTANCE}-httpFn`, "?publish=test-publisher.synthetic.v1.undeclared") }, { expect: ["ext-httpFn"], timeoutMs: 5000 }),
      step("eventarc-logs", { kind: "logs", pattern: "eventarc" }),
    ],
  },
  {
    id: "lifecycle-background-controls",
    category: "lifecycle",
    description: "The hub's disable/enable background trigger switches and their effect on event delivery and trigger keys.",
    steps: [
      step("disable", { kind: "hub", method: "PUT", path: "/functions/disableBackgroundTriggers" }),
      step("write-while-disabled", { kind: "firestore", op: "set", path: "items/disabled", fields: { x: 1 } }, { expect: 0, timeoutMs: 3000 }),
      step("http-while-disabled", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=empty") }, { expect: ["httpEcho"] }),
      step("trigger-while-disabled", { kind: "http", method: "POST", path: trigger("us-central1-scheduledTick-0"), headers: { "content-type": "application/json" }, body: json({}) }, { expect: 0, timeoutMs: 3000 }),
      step("enable", { kind: "hub", method: "PUT", path: "/functions/enableBackgroundTriggers" }),
      step("wait-enable", { kind: "wait", ms: 4000 }),
      step("write-after-enable", { kind: "firestore", op: "set", path: "items/enabled", fields: { x: 1 } }, { expect: ["docCreated", "docWritten"], timeoutMs: 15000 }),
      step("trigger-generation-after-enable", { kind: "http", method: "POST", path: trigger("us-central1-scheduledTick-1"), headers: { "content-type": "application/json" }, body: json({}) }, { expect: 1, timeoutMs: 4000 }),
      step("backends-after-enable", { kind: "http", method: "GET", path: "/backends" }),
    ],
  },
];

/** Programs for the `v1-blocking` profile, whose primary codebase is replaced by the v1 blocking source. */
export function v1BlockingSource(): string {
  return `${OBSERVE_PRELUDE}
const functionsV1 = require("firebase-functions/v1");
exports.v1BeforeCreate = functionsV1.auth.user().beforeCreate((user, context) => {
  record("v1BeforeCreate", { user: safe(user), context: safe(context) });
  if ((user.email || "").startsWith("reject")) throw new functionsV1.auth.HttpsError("invalid-argument", "v1 rejection");
  return { displayName: "v1-set", customClaims: { legacy: true } };
});
exports.v1BeforeSignIn = functionsV1.auth.user().beforeSignIn((user, context) => {
  record("v1BeforeSignIn", { user: safe(user), context: safe(context) });
  return { sessionClaims: { v1session: true } };
});
`;
}

export const V1_BLOCKING_PROGRAMS: readonly Program[] = [
  {
    id: "v1-blocking-functions",
    category: "blocking-functions",
    description: "First-generation beforeCreate/beforeSignIn handlers: user and context shapes, applied claims and rejection.",
    steps: [
      step("backends", { kind: "http", method: "GET", path: "/backends" }),
      step("sign-up", { kind: "auth", op: "signUp", email: "v1-user@example.test", password: "secret-pass-9" }, { expect: ["v1BeforeCreate"] }),
      step("lookup", { kind: "auth", op: "lookup", from: "sign-up" }),
      step("sign-in", { kind: "auth", op: "signIn", email: "v1-user@example.test", password: "secret-pass-9" }, { expect: ["v1BeforeSignIn"] }),
      step("reject", { kind: "auth", op: "signUp", email: "reject-v1@example.test", password: "secret-pass-9" }, { expect: ["v1BeforeCreate"] }),
    ],
  },
];

export const INSPECT_PROGRAMS: readonly Program[] = [
  {
    id: "inspect-debug-mode",
    category: "lifecycle",
    description: "--inspect-functions: the debug port log, sequential execution and the per-request debug target in a shared worker.",
    steps: [
      step("debug-logs", { kind: "logs", pattern: "debug port" }),
      step("http", { kind: "http", method: "GET", path: httpPath(REGION, "httpEcho", "?mode=empty") }, { expect: ["httpEcho"] }),
      step("callable", { kind: "http", method: "POST", path: httpPath(REGION, "callableEcho"), body: json({ data: "debug" }) }, { expect: ["callableEcho"] }),
      step("event", { kind: "firestore", op: "set", path: "items/debug", fields: { debug: true } }, { expect: ["docCreated", "docWritten"] }),
      step("secondary", { kind: "http", method: "GET", path: httpPath(REGION, "secondaryHttp") }, { expect: ["secondaryHttp"] }),
    ],
  },
];

export const MISSING_PARAM_PROGRAMS: readonly Program[] = [
  {
    id: "extension-missing-required-param",
    category: "extensions",
    description: "An extension instance whose env files omit a required parameter without default: the startup failure and its message.",
    steps: [step("startup-logs", { kind: "logs", pattern: "" })],
  },
];

/** Synthetic parameters for the two public registry extensions of the `consumer-refs` profile. */
export const CONSUMER_REFS_ENV_FILES: Readonly<Record<string, string>> = {
  "stripe.env": [
    `LOCATION=${REGION}`,
    "PRODUCTS_COLLECTION=products",
    "CUSTOMERS_COLLECTION=customers",
    "STRIPE_CONFIG_COLLECTION=configuration",
    "SYNC_USERS_ON_CREATE=Sync",
    "DELETE_STRIPE_CUSTOMERS=Do not delete",
    "CREATE_CHECKOUT_SESSION_MIN_INSTANCES=0",
    "",
  ].join("\n"),
  "stripe.secret.local": "STRIPE_API_KEY=sk_test_synthetic_not_a_real_key\nSTRIPE_WEBHOOK_SECRET=whsec_synthetic_not_real\n",
  "algolia.env": [
    `LOCATION=${REGION}`,
    "DATABASE_ID=(default)",
    "COLLECTION_PATH=searchable",
    "FIELDS=title,body",
    "FORCE_DATA_SYNC=no",
    "ALGOLIA_INDEX_NAME=synthetic_index",
    "ALGOLIA_APP_ID=SYNTHETIC00",
    "DO_FULL_INDEXING=no",
    "",
  ].join("\n"),
  "algolia.secret.local": "ALGOLIA_API_KEY=synthetic-algolia-key\n",
};

export const CONSUMER_REFS_PROGRAMS: readonly Program[] = [
  {
    id: "registry-extensions-inventory",
    category: "extensions",
    description: "Two registry extensions resolved from the shared cache: backends, substituted specs, secrets as Secret Manager names, and the dropped task-queue resources.",
    steps: [
      step("backends", { kind: "http", method: "GET", path: "/backends" }),
      step("extension-logs", { kind: "logs", pattern: "extension" }),
      step("missing-trigger-logs", { kind: "logs", pattern: "missing a trigger" }),
    ],
  },
  {
    id: "registry-extensions-delivery",
    category: "extensions",
    description: "Deliveries reach the registry extensions' handlers: a Firestore create into Stripe's checkout session handler, a user sign-up into createCustomer, a Firestore write into Algolia's indexer; their outbound calls fail deliberately.",
    steps: [
      step("checkout-session", { kind: "firestore", op: "set", path: "customers/synthetic-user/checkout_sessions/one", fields: { price: "price_synthetic", success_url: "https://example.test/ok", cancel_url: "https://example.test/cancel" } }, { expect: 0, timeoutMs: 6000 }),
      step("checkout-session-read", { kind: "firestore", op: "update", path: "customers/synthetic-user/checkout_sessions/one", fields: { price: "price_synthetic" } }),
      step("sign-up", { kind: "auth", op: "signUp", email: "stripe-customer@example.test", password: "secret-pass-7" }, { expect: 0, timeoutMs: 6000 }),
      step("algolia-write", { kind: "firestore", op: "set", path: "searchable/one", fields: { title: "Synthetic", body: "indexed?" } }, { expect: 0, timeoutMs: 6000 }),
      step("delivery-logs", { kind: "logs", pattern: "ext-" }),
      step("portal-link", { kind: "http", method: "POST", path: httpPath(REGION, "ext-stripe-createPortalLink"), body: json({ data: { returnUrl: "https://example.test" } }) }, { expect: 0, timeoutMs: 6000 }),
      step("webhook", { kind: "http", method: "POST", path: httpPath(REGION, "ext-stripe-handleWebhookEvents"), headers: { "stripe-signature": "t=1,v1=invalid" }, body: json({ id: "evt_synthetic", type: "product.created" }) }, { expect: 0, timeoutMs: 6000 }),
    ],
  },
];
