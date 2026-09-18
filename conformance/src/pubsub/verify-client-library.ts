// Phase J4: the pinned `@google-cloud/pubsub` client library against
// Fireside's standalone service, with `PUBSUB_EMULATOR_HOST` set exactly as an
// application would: publish, `subscription.on('message')` (streaming pull),
// ordering keys, push delivery to a local endpoint and an Avro schema.
//
//   node --import tsx src/pubsub/verify-client-library.ts --binary ../target/release/fireside [--output result.json]
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { PushEndpoint, startFireside } from "./client.ts";

// The client library's own type declarations do not pass the harness's
// strict type check, so the pinned package is loaded untyped and driven
// through the minimal surface below.
interface Message {
  readonly data: Buffer;
  readonly attributes: Record<string, string>;
  ack(): void;
}
interface Subscription {
  readonly name: string;
  on(event: "message", listener: (message: Message) => void): void;
  close(): Promise<void>;
  delete(): Promise<unknown>;
}
interface Topic {
  readonly name: string;
  createSubscription(name: string, options?: Record<string, unknown>): Promise<[Subscription]>;
  publishMessage(message: { data: Buffer; attributes?: Record<string, string>; orderingKey?: string }): Promise<string>;
  delete(): Promise<unknown>;
}
interface PubSubClient {
  createTopic(name: string | Record<string, unknown>): Promise<[Topic]>;
  createSchema(id: string, type: string, definition: string): Promise<unknown>;
  topic(name: string, options?: Record<string, unknown>): Topic;
  subscription(name: string): Subscription;
  getTopics(): Promise<[Topic[]]>;
  getSubscriptions(): Promise<[Subscription[]]>;
  close(): Promise<void>;
}
interface PubSubModule {
  readonly PubSub: new (options: { projectId: string }) => PubSubClient;
  readonly Encodings: { readonly Json: string };
  readonly SchemaTypes: { readonly Avro: string };
}

function parseArguments(argv: readonly string[]): { binary: string; output?: string | undefined } {
  let binary = "";
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--binary") binary = argv[++index] ?? "";
    else if (argument === "--output") output = argv[++index];
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!binary) throw new Error("--binary is required");
  return { binary, output };
}

const args = parseArguments(process.argv.slice(2));
const project = "fireside-client-check";
const emulator = await startFireside(resolve(args.binary), project);
process.env.PUBSUB_EMULATOR_HOST = `127.0.0.1:${String(emulator.port)}`;
process.env.PUBSUB_PROJECT_ID = project;
const require = createRequire(import.meta.url);
const { PubSub, Encodings, SchemaTypes } = require("@google-cloud/pubsub") as PubSubModule;
const push = new PushEndpoint();
await push.start();
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
};

try {
  const pubsub = new PubSub({ projectId: project });
  const [topic] = await pubsub.createTopic("orders");
  const [subscription] = await topic.createSubscription("orders-sub", { ackDeadlineSeconds: 10 });
  check("createTopic/createSubscription", topic.name.endsWith("/topics/orders") && subscription.name.endsWith("/subscriptions/orders-sub"), `${topic.name}, ${subscription.name}`);

  // Publish and consume through the streaming pull the client library uses.
  const received: string[] = [];
  const done = new Promise<void>((resolvePromise) => {
    subscription.on("message", (message: Message) => {
      received.push(`${message.data.toString()}:${String(message.attributes.n ?? "")}`);
      message.ack();
      if (received.length === 3) resolvePromise();
    });
  });
  const ids = await Promise.all([
    topic.publishMessage({ data: Buffer.from("one"), attributes: { n: "1" } }),
    topic.publishMessage({ data: Buffer.from("two"), attributes: { n: "2" } }),
    topic.publishMessage({ data: Buffer.from("three"), attributes: { n: "3" } }),
  ]);
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("no messages within 10 s")), 10_000))]);
  await subscription.close();
  check("publishMessage + on('message')", ids.every((id) => /^\d+$/.test(id)) && received.sort().join(",") === "one:1,three:3,two:2", `ids ${ids.join(",")}; received ${received.join(",")}`);

  // Ordering keys: the library batches per key; delivery keeps the order.
  const [orderedTopic] = await pubsub.createTopic("ordered");
  const [orderedSub] = await orderedTopic.createSubscription("ordered-sub", { enableMessageOrdering: true });
  const publisher = pubsub.topic("ordered", { messageOrdering: true });
  for (const index of [1, 2, 3, 4, 5]) {
    await publisher.publishMessage({ data: Buffer.from(`k${String(index)}`), orderingKey: "key" });
  }
  const ordered: string[] = [];
  const orderedDone = new Promise<void>((resolvePromise) => {
    orderedSub.on("message", (message: Message) => {
      ordered.push(message.data.toString());
      message.ack();
      if (ordered.length === 5) resolvePromise();
    });
  });
  await Promise.race([orderedDone, new Promise((_, reject) => setTimeout(() => reject(new Error("ordered messages not delivered within 10 s")), 10_000))]);
  await orderedSub.close();
  check("ordering keys over streaming pull", ordered.join(",") === "k1,k2,k3,k4,k5", ordered.join(","));

  // Push delivery to a local endpoint.
  const [pushTopic] = await pubsub.createTopic("pushed");
  await pushTopic.createSubscription("push-sub", { pushConfig: { pushEndpoint: `${push.origin}/hook` } });
  await pushTopic.publishMessage({ data: Buffer.from("pushed-body"), attributes: { via: "push" } });
  await push.waitFor(1, 5000);
  const envelope = push.requests[0];
  const body = envelope?.body as { message?: { data?: string; attributes?: Record<string, string> }; subscription?: string } | undefined;
  check(
    "push delivery envelope",
    envelope !== undefined && Buffer.from(body?.message?.data ?? "", "base64").toString() === "pushed-body" && body?.message?.attributes?.via === "push" && (body?.subscription ?? "").endsWith("/subscriptions/push-sub"),
    JSON.stringify(envelope?.body ?? null).slice(0, 200),
  );

  // Avro schema bound to a topic: valid JSON publishes, invalid is rejected.
  const definition = JSON.stringify({ type: "record", name: "Reading", fields: [{ name: "sensor", type: "string" }, { name: "value", type: "double" }] });
  await pubsub.createSchema("readings", SchemaTypes.Avro, definition);
  const [schemaTopic] = await pubsub.createTopic({ name: `projects/${project}/topics/readings`, schemaSettings: { schema: `projects/${project}/schemas/readings`, encoding: Encodings.Json } });
  const okId = await schemaTopic.publishMessage({ data: Buffer.from(JSON.stringify({ sensor: "s1", value: 1.5 })) });
  let rejected = "";
  try {
    await schemaTopic.publishMessage({ data: Buffer.from("not a reading") });
  } catch (error) {
    rejected = error instanceof Error ? error.message : String(error);
  }
  check("Avro schema on a topic", /^\d+$/.test(okId) && rejected.includes("Could not parse message"), `accepted ${okId}; rejected: ${rejected}`);

  // Admin-style listing and cleanup.
  const [topics] = await pubsub.getTopics();
  const [subscriptions] = await pubsub.getSubscriptions();
  check("getTopics/getSubscriptions", topics.length === 4 && subscriptions.length === 3, `${String(topics.length)} topics, ${String(subscriptions.length)} subscriptions`);
  await pubsub.subscription("orders-sub").delete();
  await pubsub.topic("orders").delete();
  const [afterDelete] = await pubsub.getTopics();
  check("delete", afterDelete.length === 3, `${String(afterDelete.length)} topics left`);
  await pubsub.close();
} finally {
  await push.stop();
  await emulator.stop();
}

const failed = checks.filter((entry) => !entry.ok);
if (args.output) {
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify({ client: "@google-cloud/pubsub", checks }, null, 2)}\n`, "utf8");
}
console.log(`${String(checks.length - failed.length)}/${String(checks.length)} client library checks passed`);
if (failed.length > 0) process.exit(1);
