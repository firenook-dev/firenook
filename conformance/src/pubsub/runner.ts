// Phase J1: the step executor shared by the official-emulator capture and the
// Fireside replay, so both sides drive the transports and normalize the
// results identically.
import type { Json, PushEndpoint, PushRequest, RunningEmulator } from "./client.ts";
import { httpCall } from "./client.ts";
import type { Program, Step, StreamAction } from "./emulator-plan.ts";
import { PROGRAMS } from "./emulator-plan.ts";
import { Registry, finish, normalizeValue } from "./normalize.ts";

/** Push request headers worth recording (the rest name the JVM or the socket). */
const RECORDED_PUSH_HEADERS = ["content-type", "x-goog-version", "authorization"];

export interface RecordedStep {
  readonly id: string;
  readonly note?: string;
  readonly request: Json;
  readonly response: Json;
  /** Push requests the endpoint received during the step. */
  readonly pushes?: readonly Json[];
}

export interface RecordedProgram {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly steps: readonly RecordedStep[];
}

/** Every string literal in the plan is a program constant that must never be templated. */
export function collectConstants(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    into.add(value);
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

export const PLAN_CONSTANTS: ReadonlySet<string> = (() => {
  const constants = new Set<string>();
  collectConstants(PROGRAMS, constants);
  return constants;
})();

export interface StepEnvironment {
  readonly emulator: RunningEmulator;
  readonly push: PushEndpoint;
  readonly registry: Registry;
  /** Wall-clock completion time of earlier steps, for `{{timeBetween:a:b}}`. */
  readonly completedAt: Map<string, number>;
  readonly debug?: boolean;
}

function timeBetween(value: Json, completed: Map<string, number>): Json {
  if (value && typeof value === "object" && !Array.isArray(value) && "$b64repeat" in value) {
    const spec = value.$b64repeat as { text: string; count: number };
    return Buffer.from(spec.text.repeat(spec.count), "utf8").toString("base64");
  }
  if (typeof value === "string") {
    const match = /^\{\{timeBetween:([^:}]+):([^:}]+)\}\}$/.exec(value);
    if (match) {
      const before = completed.get(match[1] ?? "");
      const after = completed.get(match[2] ?? "");
      if (before === undefined || after === undefined) throw new Error(`timeBetween: unknown steps in ${value}`);
      const midpoint = Math.floor((before + after) / 2);
      return { seconds: String(Math.floor(midpoint / 1000)), nanos: (midpoint % 1000) * 1_000_000 };
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => timeBetween(item, completed));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, timeBetween(item, completed)]));
  }
  return value;
}

function recordPush(request: PushRequest, step: string, environment: StepEnvironment): Json {
  const headers: { [key: string]: Json } = {};
  for (const name of RECORDED_PUSH_HEADERS) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  return {
    method: request.method,
    path: request.path,
    headers,
    body: normalizeValue(request.body, step, environment.registry),
  };
}

/** Executes one plan step and returns it in the fixture's recorded form. */
export async function executeStep(step: Step, environment: StepEnvironment): Promise<RecordedStep> {
  const { emulator, push, registry } = environment;
  const replacements: (readonly [string, string])[] = [[push.origin, "{{pushOrigin}}"]];
  const resolveRequest = (value: Json): Json => timeBetween(registry.resolveJson(value), environment.completedAt);
  let request: Json;
  let response: Json;
  push.drain();

  if ("grpc" in step) {
    const resolved = resolveRequest(step.grpc.request);
    request = { transport: "grpc", service: step.grpc.service, method: step.grpc.method, body: step.grpc.request };
    const result = await emulator.grpc.call(step.grpc.service, step.grpc.method, resolved, step.deadlineMs ?? 120_000);
    if (step.sortReceived && "response" in result && result.response && typeof result.response === "object" && !Array.isArray(result.response)) {
      // Sorted by message id before normalization, so ack ids number in a
      // run-independent order.
      const body = result.response;
      if (Array.isArray(body.receivedMessages)) {
        body.receivedMessages = [...body.receivedMessages].sort((a, b) => messageNumber(a) - messageNumber(b));
      }
    }
    response =
      "error" in result
        ? { error: { code: result.error.code, status: result.error.status, message: result.error.message } }
        : { body: normalizeValue(result.response, step.id, registry) };
  } else if ("http" in step) {
    const body = step.http.body === undefined ? undefined : typeof step.http.body === "string" ? registry.resolve(step.http.body) : resolveRequest(step.http.body);
    request = { transport: "http", method: step.http.method, path: step.http.path, ...(step.http.body === undefined ? {} : { body: step.http.body }) };
    const result = await httpCall(emulator.origin, step.http.method, registry.resolve(step.http.path), body);
    response = {
      status: result.status,
      contentType: result.contentType,
      ...(result.text === undefined ? { body: normalizeValue(result.body, step.id, registry) } : { text: result.text }),
    };
  } else if ("stream" in step) {
    request = { transport: "stream", service: step.stream.service, method: step.stream.method, actions: step.stream.actions as unknown as Json };
    const stream = emulator.grpc.stream(step.stream.service, step.stream.method);
    const received: Json[] = [];
    for (const action of step.stream.actions as readonly StreamAction[]) {
      if ("write" in action) {
        stream.write(resolveRequest(action.write));
      } else if ("waitMs" in action) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, action.waitMs));
        // Register ids as they arrive so a later write can reference them.
        for (const message of stream.drain()) received.push(normalizeValue(message, step.id, registry));
      } else if ("end" in action) {
        stream.end();
      } else {
        stream.cancel();
      }
    }
    await stream.settle(2000);
    for (const message of stream.drain()) received.push(normalizeValue(message, step.id, registry));
    if (stream.status === null) stream.cancel();
    const status = stream.status ?? { code: 1, status: "CANCELLED", message: "" };
    response = { received: flattenReceived(received), status: { code: status.code, status: status.status, message: status.message } };
  } else if ("sleepMs" in step) {
    request = { transport: "sleep", sleepMs: step.sleepMs };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, step.sleepMs));
    response = {};
  } else if ("pushes" in step) {
    request = { transport: "pushes", atLeast: step.pushes.atLeast, timeoutMs: step.pushes.timeoutMs };
    await push.waitFor(step.pushes.atLeast, step.pushes.timeoutMs);
    if (step.pushes.atLeast === 0) {
      // A negative check: wait the whole window.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, step.pushes.timeoutMs));
    } else {
      // Late arrivals of the same batch land within a moment.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
    const requests = push.drain();
    const recorded = requests.map((item) => recordPush(item, step.id, environment));
    // Retries repeat the same envelope on a timer, so the count is only a
    // contract when none is expected; the distinct envelopes always are.
    response = {
      ...(step.pushes.atLeast === 0 ? { count: recorded.length } : {}),
      atLeastSatisfied: recorded.length >= step.pushes.atLeast,
      distinct: distinctPushes(recorded),
    };
  } else {
    request = { transport: "pushStatus", status: step.pushStatus };
    push.status = step.pushStatus;
    response = {};
  }

  environment.completedAt.set(step.id, Date.now());
  const late = push.drain();
  const recorded: RecordedStep = {
    id: step.id,
    ...(step.note === undefined ? {} : { note: step.note }),
    request: finish(request, replacements),
    response: finish(response, replacements),
    ...(late.length === 0 ? {} : { pushes: late.map((item) => finish(recordPush(item, step.id, environment), replacements)) }),
  };
  if (environment.debug) console.log(`${step.id}: ${JSON.stringify(recorded.response).slice(0, 300)}`);
  return recorded;
}

function messageNumber(received: Json): number {
  if (received && typeof received === "object" && !Array.isArray(received)) {
    const message = received.message;
    if (message && typeof message === "object" && !Array.isArray(message)) return Number(message.messageId ?? 0);
  }
  return 0;
}

/** Streaming responses batch messages arbitrarily; the flattened message list is the contract. */
function flattenReceived(responses: readonly Json[]): Json {
  const messages: Json[] = [];
  const properties: Json[] = [];
  for (const response of responses) {
    if (response && typeof response === "object" && !Array.isArray(response)) {
      const received = response.receivedMessages;
      if (Array.isArray(received)) messages.push(...received);
      if (response.subscriptionProperties !== undefined) properties.push(response.subscriptionProperties);
      if (response.acknowledgeConfirmation !== undefined) properties.push({ acknowledgeConfirmation: response.acknowledgeConfirmation });
      if (response.modifyAckDeadlineConfirmation !== undefined) properties.push({ modifyAckDeadlineConfirmation: response.modifyAckDeadlineConfirmation });
    }
  }
  return { messages, properties: dedupe(properties) };
}

function dedupe(values: readonly Json[]): Json[] {
  const seen = new Set<string>();
  const output: Json[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

/** Concurrent pushes land in no particular order: the distinct envelopes, sorted. */
function distinctPushes(pushes: readonly Json[]): Json[] {
  return dedupe(pushes).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}

/** Runs one program against a fresh emulator. */
export async function runProgram(program: Program, environment: Omit<StepEnvironment, "registry" | "completedAt">, onStep?: (step: RecordedStep) => void): Promise<RecordedProgram> {
  const registry = new Registry(PLAN_CONSTANTS);
  registry.bind("{{pushOrigin}}", environment.push.origin);
  const completedAt = new Map<string, number>();
  const steps: RecordedStep[] = [];
  for (const step of program.steps) {
    const recorded = await executeStep(step, { ...environment, registry, completedAt });
    steps.push(recorded);
    onStep?.(recorded);
  }
  return { id: program.id, category: program.category, title: program.title, steps };
}
