// Phase H1 fixture finalization shared by the capture and the replay: token
// placeholders for the deterministic unsigned test JWTs, digests for the
// large extension spec objects repeated in every `/backends` recording, and
// the counts the gate checks.
import { createHash } from "node:crypto";

import { PROJECT_ID, TOKEN_PAYLOADS } from "./plan.ts";
import { tokenFor } from "./runner.ts";

const DIGESTED_BACKEND_KEYS = ["extensionSpec", "extensionVersion", "extension"] as const;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const LARGE_STRING = 4096;
const RFC1123 = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
// Epoch milliseconds (official generations) or microseconds (Fireside generations).
const EPOCH_MILLIS_IN_STRING = /(?<![\d.])1[6-9]\d{11}(?:\d{3})?(?![\d.])/g;
const SHORT_RANDOM_ID = /^[A-Za-z0-9_-]{16}$/;
const VOLATILE_NUMBER_KEYS = new Set(["passwordUpdatedAt", "lastLoginAt", "createdAt", "validSince", "expiresIn"]);

/** Target-independent scrubbing of volatile values the runner cannot see (RFC 1123 dates, epoch millis inside strings, short random event ids). */
export function scrubVolatile(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (RFC1123.test(value)) return "{{time}}";
    if (key === "PORT") return "{{port}}";
    if (key === "eventId" && SHORT_RANDOM_ID.test(value)) return "{{id}}";
    return value.replace(EPOCH_MILLIS_IN_STRING, "{{number}}");
  }
  if (typeof value === "number") return key !== undefined && VOLATILE_NUMBER_KEYS.has(key) ? "{{number}}" : value;
  if (Array.isArray(value)) return value.map((item) => scrubVolatile(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, scrubVolatile(child, childKey)]));
  return value;
}

/** Replaces strings longer than 4 KiB (large echoed bodies) with their digest and length. */
export function compactLargeStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > LARGE_STRING ? { $sha256: createHash("sha256").update(value).digest("hex"), length: value.length } : value;
  }
  if (Array.isArray(value)) return value.map(compactLargeStrings);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, compactLargeStrings(child)]));
  return value;
}

/** Replaces every occurrence of a known unsigned test JWT with `{{jwt:<name>}}`. */
export function placeholderTokens(value: unknown, projectId = PROJECT_ID): unknown {
  const replacements = Object.keys(TOKEN_PAYLOADS).map((name) => [tokenFor(name, projectId), `{{jwt:${name}}}`] as const);
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      let text = node;
      for (const [jwt, placeholder] of replacements) text = text.replaceAll(jwt, placeholder);
      return text;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, child]) => [key, visit(child)]));
    return node;
  };
  return visit(value);
}

/**
 * Replaces the extension spec objects inside a recorded `/backends` body with
 * `{ $digest, name, version }`, keeping the full objects in the profile's
 * readiness inventory only. Two recordings compare equal when the canonical
 * JSON of the spec is identical.
 */
/**
 * Registry object fields that move without any change to the extension
 * itself (install counts, listing state, newer releases, icons); the digest
 * covers the rest so a recorded registry extension stays comparable.
 */
const REGISTRY_VOLATILE_FIELDS = new Set(["metrics", "latestVersion", "latestApprovedVersion", "latestVersionCreateTime", "iconUri", "icons", "listing", "state", "createTime"]);

export function digestBackends(body: unknown): unknown {
  if (!body || typeof body !== "object" || !Array.isArray((body as { backends?: unknown }).backends)) return body;
  const backends = (body as { backends: Record<string, unknown>[] }).backends.map((backend) => {
    const out: Record<string, unknown> = { ...backend };
    for (const key of DIGESTED_BACKEND_KEYS) {
      const value = backend[key];
      if (value && typeof value === "object") {
        const record = value as { name?: unknown; ref?: unknown; version?: unknown; spec?: { version?: unknown } };
        const stable = key === "extensionSpec" ? value : Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([field]) => !REGISTRY_VOLATILE_FIELDS.has(field)));
        out[key] = { $digest: digestOf(stable), ...(record.name !== undefined ? { name: record.name } : {}), ...(record.ref !== undefined ? { ref: record.ref } : {}), ...(record.version !== undefined ? { version: record.version } : record.spec?.version !== undefined ? { version: record.spec.version } : {}) };
      }
    }
    return out;
  });
  return { ...(body as object), backends };
}

interface ProfileLike {
  readonly programs: ReadonlyArray<{ readonly category?: string; readonly steps: ReadonlyArray<object> }>;
}

export function finalizeFixture<T extends { profiles: readonly ProfileLike[] }>(fixture: T): T & { profileCount: number; programCount: number; stepCount: number; observationCount: number; categories: Record<string, number> } {
  const profiles = fixture.profiles.map((profile) => ({
    ...profile,
    programs: profile.programs.map((program) => ({
      ...program,
      steps: program.steps.map((rawStep) => {
        const step = rawStep as Record<string, unknown>;
        const response = step.response as { body?: unknown } | undefined;
        const digested = response && typeof response === "object" && "body" in response ? { ...response, body: digestBackends(response.body) } : response;
        return scrubVolatile(compactLargeStrings(placeholderTokens({ ...step, ...(digested === undefined ? {} : { response: digested }) }))) as Record<string, unknown>;
      }),
    })),
  }));
  const categories: Record<string, number> = {};
  for (const profile of profiles) {
    for (const program of profile.programs as ReadonlyArray<{ category?: string }>) {
      if (program.category) categories[program.category] = (categories[program.category] ?? 0) + 1;
    }
  }
  return {
    ...fixture,
    profiles,
    profileCount: profiles.length,
    programCount: profiles.reduce((sum, profile) => sum + profile.programs.length, 0),
    stepCount: profiles.reduce((sum, profile) => sum + profile.programs.reduce((inner, program) => inner + program.steps.length, 0), 0),
    observationCount: profiles.reduce(
      (sum, profile) => sum + profile.programs.reduce((inner, program) => inner + program.steps.reduce((count, step) => count + ((step.observations as unknown[] | undefined)?.length ?? 0), 0), 0),
      0,
    ),
    categories,
  };
}
