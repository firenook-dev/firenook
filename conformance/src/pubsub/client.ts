// Phase J1: the transports shared by the official-emulator capture and the
// Fireside replay — the `google.pubsub.v1` services over gRPC (grpc-js with
// the client library's own proto files), the HTTP/JSON surface on the same
// port, a recording push endpoint, and the official emulator's launcher.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import grpc from "@grpc/grpc-js";

export const HOST = "127.0.0.1";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const require = createRequire(import.meta.url);
const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The proto files as the client library ships them (pinned in package-lock.json). */
export const PROTO_ROOTS = [
  join(harnessRoot, "node_modules/@google-cloud/pubsub/build/protos"),
  join(harnessRoot, "node_modules/google-gax/build/protos"),
];

export const SERVICES = {
  Publisher: "google.pubsub.v1.Publisher",
  Subscriber: "google.pubsub.v1.Subscriber",
  SchemaService: "google.pubsub.v1.SchemaService",
  IAMPolicy: "google.iam.v1.IAMPolicy",
} as const;
export type ServiceName = keyof typeof SERVICES;

interface LoadedPackage {
  readonly google: {
    readonly pubsub: { readonly v1: Record<string, grpc.ServiceClientConstructor> };
    readonly iam: { readonly v1: Record<string, grpc.ServiceClientConstructor> };
  };
}

let loaded: LoadedPackage | undefined;

function packageDefinition(): LoadedPackage {
  if (loaded) return loaded;
  // proto-loader is a transitive dependency of the client library; resolve it
  // from the same tree so the capture and the replay decode identically.
  const loader = require("@grpc/proto-loader") as typeof import("@grpc/proto-loader");
  const definition = loader.loadSync(
    ["google/pubsub/v1/pubsub.proto", "google/pubsub/v1/schema.proto", "google/iam/v1/iam_policy.proto"],
    { includeDirs: PROTO_ROOTS, keepCase: false, longs: String, enums: String, defaults: false, oneofs: true, bytes: String },
  );
  loaded = grpc.loadPackageDefinition(definition) as unknown as LoadedPackage;
  return loaded;
}

export interface GrpcError {
  readonly code: number;
  readonly status: string;
  readonly message: string;
}

export type GrpcResult = { readonly response: Json } | { readonly error: GrpcError };

export interface StreamResult {
  /** Every response message, flattened in arrival order. */
  readonly received: Json[];
  /** The terminal status once the stream ended, else `null` while open. */
  readonly status: GrpcError | null;
}

function toGrpcError(error: grpc.ServiceError): GrpcError {
  return { code: error.code, status: grpc.status[error.code] ?? String(error.code), message: error.details };
}

/**
 * The decoded message as plain JSON: bytes fields are base64 strings
 * (`bytes: String` above), 64-bit integers decimal strings, enums names.
 */
export function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const output: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      output[key] = toJson(item);
    }
    return output;
  }
  if (typeof value === "bigint") return value.toString();
  return value as Json;
}

/** A gRPC connection to one emulator. */
export class PubsubGrpc {
  private readonly clients = new Map<ServiceName, grpc.Client>();

  constructor(readonly address: string) {}

  private client(service: ServiceName): grpc.Client {
    let client = this.clients.get(service);
    if (!client) {
      const pkg = packageDefinition();
      const constructor = service === "IAMPolicy" ? pkg.google.iam.v1.IAMPolicy : pkg.google.pubsub.v1[service];
      if (!constructor) throw new Error(`unknown service ${service}`);
      client = new constructor(this.address, grpc.credentials.createInsecure(), {
        "grpc.max_receive_message_length": 64 * 1024 * 1024,
      });
      this.clients.set(service, client);
    }
    return client;
  }

  /** One unary call; `deadlineMs` bounds long-polling calls. */
  call(service: ServiceName, method: string, request: Json, deadlineMs = 120_000): Promise<GrpcResult> {
    const client = this.client(service) as unknown as Record<string, (...args: unknown[]) => void>;
    const fn = client[method];
    if (typeof fn !== "function") throw new Error(`unknown method ${service}.${method}`);
    return new Promise((resolvePromise) => {
      fn.call(client, request, { deadline: Date.now() + deadlineMs }, (error: grpc.ServiceError | null, response: unknown) => {
        if (error) resolvePromise({ error: toGrpcError(error) });
        else resolvePromise({ response: toJson(response) });
      });
    });
  }

  /** Opens a bidirectional stream (StreamingPull). */
  stream(service: ServiceName, method: string): OpenStream {
    const client = this.client(service) as unknown as Record<string, () => grpc.ClientDuplexStream<unknown, unknown>>;
    const fn = client[method];
    if (typeof fn !== "function") throw new Error(`unknown method ${service}.${method}`);
    return new OpenStream(fn.call(client));
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}

export class OpenStream {
  readonly received: Json[] = [];
  status: GrpcError | null = null;

  constructor(private readonly stream: grpc.ClientDuplexStream<unknown, unknown>) {
    stream.on("data", (message: unknown) => this.received.push(toJson(message)));
    stream.on("error", (error: grpc.ServiceError) => {
      this.status = toGrpcError(error);
    });
    stream.on("end", () => {
      this.status ??= { code: 0, status: "OK", message: "" };
    });
  }

  write(request: Json): void {
    this.stream.write(request);
  }

  end(): void {
    this.stream.end();
  }

  cancel(): void {
    this.stream.cancel();
  }

  /** Waits until the stream has ended or `timeoutMs` elapsed. */
  async settle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.status === null && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }

  /** Takes every message received so far. */
  drain(): Json[] {
    return this.received.splice(0, this.received.length);
  }
}

export interface HttpResult {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Json;
  /** The raw text when it is not JSON. */
  readonly text?: string;
}

/** One HTTP/JSON request against the emulator port. */
export async function httpCall(origin: string, method: string, path: string, body?: Json | string): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (body !== undefined) {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${origin}${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }), signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    try {
      return { status: response.status, contentType, body: JSON.parse(text) as Json };
    } catch {
      return { status: response.status, contentType, body: null, text };
    }
  }
  return { status: response.status, contentType, body: null, text };
}

export interface PushRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Json;
  readonly text: string;
}

/** The recording HTTP server registered as a push endpoint. */
export class PushEndpoint {
  readonly requests: PushRequest[] = [];
  /** The status the endpoint answers with. */
  status = 200;
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
    this.server.closeAllConnections();
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
  }

  drain(): PushRequest[] {
    return this.requests.splice(0, this.requests.length);
  }

  /** Waits until at least `count` requests have landed or `timeoutMs` elapsed. */
  async waitFor(count: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.requests.length < count && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
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
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      this.requests.push({ method: request.method ?? "", path: request.url ?? "", headers, body, text });
      response.writeHead(this.status);
      response.end();
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  }
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

/** Waits for the HTTP surface on `origin` to answer. */
export async function waitForReady(origin: string, timeoutMs: number, exited?: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (exited?.()) throw new Error("the emulator exited before becoming ready");
    try {
      const response = await fetch(`${origin}/v1/projects/readiness-probe/topics`);
      if (response.status === 200) return;
      lastError = new Error(`status ${String(response.status)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Pub/Sub emulator did not become ready: ${String(lastError)}`);
}

export interface RunningEmulator {
  readonly port: number;
  readonly origin: string;
  readonly grpc: PubsubGrpc;
  readonly logs: () => string;
  stop(): Promise<void>;
}

/** Starts the official emulator jar on a free port. */
export async function startOfficialEmulator(jar: string, java = "java"): Promise<RunningEmulator> {
  const port = await reserveAvailablePort();
  const child: ChildProcess = spawn(java, ["-jar", jar, `--host=${HOST}`, `--port=${String(port)}`], { stdio: ["ignore", "pipe", "pipe"] });
  let exited = false;
  const output: string[] = [];
  child.once("exit", () => {
    exited = true;
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  const origin = `http://${HOST}:${String(port)}`;
  try {
    await waitForReady(origin, 60_000, () => exited);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${String(error)}\n${output.join("")}`);
  }
  return wrapProcess(child, port, origin, () => exited, () => output.join(""));
}

/** Starts Fireside's standalone Pub/Sub service on a free port. */
export async function startFireside(binary: string, project: string): Promise<RunningEmulator> {
  const port = await reserveAvailablePort();
  const child: ChildProcess = spawn(binary, ["pubsub", "--host", HOST, "--port", String(port), "--project-id", project], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  const output: string[] = [];
  child.once("exit", () => {
    exited = true;
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  const origin = `http://${HOST}:${String(port)}`;
  try {
    await waitForReady(origin, 30_000, () => exited);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${String(error)}\n${output.join("")}`);
  }
  return wrapProcess(child, port, origin, () => exited, () => output.join(""));
}

function wrapProcess(child: ChildProcess, port: number, origin: string, exited: () => boolean, logs: () => string): RunningEmulator {
  const client = new PubsubGrpc(`${HOST}:${String(port)}`);
  return {
    port,
    origin,
    grpc: client,
    logs,
    async stop() {
      client.close();
      child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => {
        if (exited()) {
          resolvePromise();
          return;
        }
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolvePromise();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    },
  };
}
