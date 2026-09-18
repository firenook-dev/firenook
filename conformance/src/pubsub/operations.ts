// Phase J1: maps a recorded step to the official RPC it exercises, for the
// coverage table (every RPC of the four services, over both transports).
import type { ServiceName } from "./client.ts";

export const RPCS: Readonly<Record<ServiceName, readonly string[]>> = {
  Publisher: ["CreateTopic", "GetTopic", "ListTopics", "UpdateTopic", "DeleteTopic", "Publish", "ListTopicSubscriptions", "ListTopicSnapshots", "DetachSubscription"],
  Subscriber: [
    "CreateSubscription",
    "GetSubscription",
    "UpdateSubscription",
    "ListSubscriptions",
    "DeleteSubscription",
    "ModifyAckDeadline",
    "Acknowledge",
    "Pull",
    "StreamingPull",
    "ModifyPushConfig",
    "Seek",
    "CreateSnapshot",
    "GetSnapshot",
    "ListSnapshots",
    "DeleteSnapshot",
  ],
  SchemaService: ["CreateSchema", "GetSchema", "ListSchemas", "ListSchemaRevisions", "CommitSchema", "RollbackSchema", "DeleteSchemaRevision", "DeleteSchema", "ValidateSchema", "ValidateMessage"],
  IAMPolicy: ["GetIamPolicy", "SetIamPolicy", "TestIamPermissions"],
};

export function rpcTotal(): number {
  return Object.values(RPCS).reduce((count, names) => count + names.length, 0);
}

const capitalize = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/** The RPC a gRPC step calls, as `Service.Rpc`. */
export function grpcOperation(service: ServiceName, method: string): string {
  return `${service}.${capitalize(method)}`;
}

/** The RPC an HTTP/JSON request transcodes to, or `undefined` when it is none. */
export function httpOperation(method: string, path: string): string | undefined {
  const pathname = path.split("?")[0] ?? "";
  const match = (pattern: RegExp): boolean => pattern.test(pathname);
  const P = String.raw`/v1/projects/[^/]+`;
  const verb = (collection: string, name: string): RegExp => new RegExp(`^${P}/${collection}/[^/:]+(@[^/:]+)?:${name}$`);
  const item = (collection: string): RegExp => new RegExp(`^${P}/${collection}/[^/:]+$`);
  const list = (collection: string): RegExp => new RegExp(`^${P}/${collection}$`);
  if (method === "PUT" && match(item("topics"))) return "Publisher.CreateTopic";
  if (method === "GET" && match(item("topics"))) return "Publisher.GetTopic";
  if (method === "GET" && match(list("topics"))) return "Publisher.ListTopics";
  if (method === "PATCH" && match(item("topics"))) return "Publisher.UpdateTopic";
  if (method === "DELETE" && match(item("topics"))) return "Publisher.DeleteTopic";
  if (method === "POST" && match(verb("topics", "publish"))) return "Publisher.Publish";
  if (method === "GET" && match(new RegExp(`^${P}/topics/[^/]+/subscriptions$`))) return "Publisher.ListTopicSubscriptions";
  if (method === "GET" && match(new RegExp(`^${P}/topics/[^/]+/snapshots$`))) return "Publisher.ListTopicSnapshots";
  if (method === "POST" && match(verb("subscriptions", "detach"))) return "Publisher.DetachSubscription";
  if (method === "PUT" && match(item("subscriptions"))) return "Subscriber.CreateSubscription";
  if (method === "GET" && match(item("subscriptions"))) return "Subscriber.GetSubscription";
  if (method === "PATCH" && match(item("subscriptions"))) return "Subscriber.UpdateSubscription";
  if (method === "GET" && match(list("subscriptions"))) return "Subscriber.ListSubscriptions";
  if (method === "DELETE" && match(item("subscriptions"))) return "Subscriber.DeleteSubscription";
  if (method === "POST" && match(verb("subscriptions", "modifyAckDeadline"))) return "Subscriber.ModifyAckDeadline";
  if (method === "POST" && match(verb("subscriptions", "acknowledge"))) return "Subscriber.Acknowledge";
  if (method === "POST" && match(verb("subscriptions", "pull"))) return "Subscriber.Pull";
  if (method === "POST" && match(verb("subscriptions", "modifyPushConfig"))) return "Subscriber.ModifyPushConfig";
  if (method === "POST" && match(verb("subscriptions", "seek"))) return "Subscriber.Seek";
  if (method === "PUT" && match(item("snapshots"))) return "Subscriber.CreateSnapshot";
  if (method === "GET" && match(item("snapshots"))) return "Subscriber.GetSnapshot";
  if (method === "GET" && match(list("snapshots"))) return "Subscriber.ListSnapshots";
  if (method === "DELETE" && match(item("snapshots"))) return "Subscriber.DeleteSnapshot";
  if (method === "PATCH" && match(item("snapshots"))) return "Subscriber.UpdateSnapshot";
  if (method === "POST" && match(list("schemas"))) return "SchemaService.CreateSchema";
  if (method === "GET" && match(item("schemas"))) return "SchemaService.GetSchema";
  if (method === "GET" && match(list("schemas"))) return "SchemaService.ListSchemas";
  if (method === "GET" && match(verb("schemas", "listRevisions"))) return "SchemaService.ListSchemaRevisions";
  if (method === "POST" && match(verb("schemas", "commit"))) return "SchemaService.CommitSchema";
  if (method === "POST" && match(verb("schemas", "rollback"))) return "SchemaService.RollbackSchema";
  if (method === "DELETE" && match(verb("schemas", "deleteRevision"))) return "SchemaService.DeleteSchemaRevision";
  if (method === "DELETE" && match(item("schemas"))) return "SchemaService.DeleteSchema";
  if (method === "POST" && match(new RegExp(`^${P}/schemas:validate$`))) return "SchemaService.ValidateSchema";
  if (method === "POST" && match(new RegExp(`^${P}/schemas:validateMessage$`))) return "SchemaService.ValidateMessage";
  if (method === "GET" && match(new RegExp(`^${P}/[a-z]+/[^/:]+:getIamPolicy$`))) return "IAMPolicy.GetIamPolicy";
  if (method === "POST" && match(new RegExp(`^${P}/[a-z]+/[^/:]+:setIamPolicy$`))) return "IAMPolicy.SetIamPolicy";
  if (method === "POST" && match(new RegExp(`^${P}/[a-z]+/[^/:]+:testIamPermissions$`))) return "IAMPolicy.TestIamPermissions";
  return undefined;
}
