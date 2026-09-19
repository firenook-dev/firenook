// Phase J1: normalization shared by the official-emulator capture and the
// Firenook replay. Message ids, ack ids and schema revision ids are
// registered under templates named after the step that produced them;
// timestamps become `{{time}}`; the push endpoint's origin `{{pushOrigin}}`.
import { Registry, type Json } from "../auth/normalize.ts";

export { Registry };
export type { Json };

/** Keys whose values are wall-clock timestamps (proto `{seconds,nanos}` or RFC 3339). */
const TIME_KEYS = new Set([
  "publishTime",
  "publish_time",
  "expireTime",
  "revisionCreateTime",
  "createTime",
  "updateTime",
  // The dead-letter forwarder stamps the source publish time as an attribute.
  "CloudPubSubDeadLetterSourceTopicPublishTime",
]);

/** Keys whose values are registered under a template named after the step. */
const REGISTERED_KEYS: Readonly<Record<string, string>> = {
  messageId: "messageId",
  message_id: "messageId",
  ackId: "ackId",
  revisionId: "revisionId",
  firstRevisionId: "revisionId",
  lastRevisionId: "revisionId",
  googclient_schemarevisionid: "revisionId",
};

/** Keys whose array elements are registered under the same kind. */
const REGISTERED_ARRAYS: Readonly<Record<string, string>> = {
  messageIds: "messageId",
};

function isTimeLike(value: Json): boolean {
  if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}T/.test(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((key) => key === "seconds" || key === "nanos");
  }
  return false;
}

/**
 * Templates every run-dependent value in `value`, registering new ids under
 * `step`. Objects are walked in sorted key order so `#n` numbering does not
 * depend on the order a transport happens to emit keys in.
 */
export function normalizeValue(value: Json, step: string, registry: Registry, key?: string): Json {
  if (key !== undefined && TIME_KEYS.has(key) && isTimeLike(value)) return "{{time}}";
  // Schema revision listings page by revision creation time.
  if (key === "nextPageToken" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return "{{time}}";
  if (Array.isArray(value)) {
    const kind = key === undefined ? undefined : REGISTERED_ARRAYS[key];
    if (kind !== undefined) {
      return value.map((item) => (typeof item === "string" && item.length > 0 ? registry.register(kind, step, item, true) : item));
    }
    return value.map((item) => normalizeValue(item, step, registry));
  }
  if (value && typeof value === "object") {
    const output: { [key: string]: Json } = {};
    for (const childKey of Object.keys(value).sort()) {
      output[childKey] = normalizeValue(value[childKey] ?? null, step, registry, childKey);
    }
    return output;
  }
  if (typeof value === "string") {
    const kind = key === undefined ? undefined : REGISTERED_KEYS[key];
    if (kind !== undefined && value.length > 0) return registry.register(kind, step, value, true);
    // A schema name carries its revision as `name@revision`.
    if (key === "name" && value.includes("@")) {
      const [base, revision] = value.split("@");
      if (revision) return `${base ?? ""}@${registry.register("revisionId", step, revision, true)}`;
    }
  }
  return value;
}

/**
 * Replaces the run's bound origins (`[raw, template]` pairs) inside every
 * string. Ids are only ever templated by key: an ack id is a prefix of the
 * next one (`sub:1`, `sub:10`), so blind substring replacement is unsafe.
 */
export function finish(value: Json, replacements: readonly (readonly [string, string])[]): Json {
  if (typeof value === "string") {
    let output = value;
    for (const [raw, template] of replacements) {
      if (raw.length > 0 && output.includes(raw)) output = output.split(raw).join(template);
    }
    return output;
  }
  if (Array.isArray(value)) return value.map((item) => finish(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, finish(item, replacements)]));
  }
  return value;
}

/** Sorted keys everywhere, for comparison. */
export function canonicalize(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([childKey, child]) => [childKey, canonicalize(child)]),
    );
  }
  return value;
}
