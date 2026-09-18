// Phase I1: normalization shared by the official-emulator capture and the
// Fireside replay. Every value that differs between two runs of the same
// program (random identifiers, tokens, codes, timestamps, the emulator and
// functions-stub origins) is replaced by a template that names the step that
// produced it, so two recordings of the same program compare equal and the
// replay can resolve the templates against its own live values.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Keys whose string/number values are wall-clock dependent. */
const TIME_KEYS = new Set([
  "createdAt",
  "lastLoginAt",
  "lastRefreshAt",
  "passwordUpdatedAt",
  "validSince",
  "iat",
  "exp",
  "auth_time",
  "enrolledAt",
  "timestamp",
  "creation_time",
  "last_sign_in_time",
  "creationTime",
  "lastSignInTime",
  "enrollment_time",
  "expiresAt",
]);

/** Keys whose values are registered under a template named after the step. */
const REGISTERED_KEYS: Readonly<Record<string, string>> = {
  localId: "localId",
  user_id: "localId",
  uid: "localId",
  sub: "localId",
  idToken: "token",
  id_token: "token",
  access_token: "token",
  refreshToken: "refresh",
  refresh_token: "refresh",
  sessionCookie: "cookie",
  mfaPendingCredential: "pending",
  oobCode: "oob",
  sessionInfo: "sessionInfo",
  temporaryProof: "temporaryProof",
  mfaEnrollmentId: "enrollmentId",
  second_factor_identifier: "enrollmentId",
  salt: "salt",
  sessionId: "sessionId",
  tenantId: "tenantId",
  tenant: "tenantId",
  tenant_id: "tenantId",
  challenge: "challenge",
};

/** Keys whose values are random but never referenced again. */
const OPAQUE_KEYS: Readonly<Record<string, string>> = {
  eventId: "{{eventId}}",
  event_id: "{{eventId}}",
};

/** Arrays whose element order depends on random identifiers. */
export const UNORDERED_ARRAYS: readonly string[] = [
  "users",
  "userInfo",
  "oobCodes",
  "verificationCodes",
  "tenants",
];

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const BASE64_JSON_MARKERS = ["_AuthEmulatorRefreshToken", "_AuthEmulatorMfaPendingCredential"];

export class Registry {
  /** raw value → template */
  private readonly templates = new Map<string, string>();
  /** template → raw value */
  private readonly values = new Map<string, string>();
  /** per step, per kind: how many distinct values were registered */
  private readonly counters = new Map<string, number>();
  /** raw values that are program constants and must never be templated */
  private readonly constants: ReadonlySet<string>;

  constructor(constants: Iterable<string> = []) {
    this.constants = new Set(constants);
  }

  /** Registers `raw` under `{{kind:step}}` (or `{{kind:step#n}}` for later distinct values). */
  register(kind: string, step: string, raw: string): string {
    if (this.constants.has(raw)) return raw;
    const counterKey = `${kind}:${step}`;
    const count = (this.counters.get(counterKey) ?? 0) + 1;
    this.counters.set(counterKey, count);
    const template = count === 1 ? `{{${kind}:${step}}}` : `{{${kind}:${step}#${String(count)}}}`;
    // The official emulator re-issues identical refresh tokens for the same
    // account and provider, so a later step may legitimately produce a value
    // an earlier step already named: the first name stays canonical and the
    // later one resolves as an alias.
    if (!this.values.has(template)) this.values.set(template, raw);
    const existing = this.templates.get(raw);
    if (existing) return existing;
    this.templates.set(raw, template);
    return template;
  }

  /** Registers a value under an explicit template (origins, constants of the run). */
  bind(template: string, raw: string): void {
    this.templates.set(raw, template);
    this.values.set(template, raw);
  }

  templateFor(raw: string): string | undefined {
    return this.templates.get(raw);
  }

  /** Whether `raw` is a program constant (never templated, never blanked). */
  isConstant(raw: string): boolean {
    return this.constants.has(raw);
  }

  valueFor(template: string): string | undefined {
    return this.values.get(template);
  }

  /** Replaces every registered raw value inside `text`, longest first. */
  replaceAll(text: string): string {
    if (this.templates.size === 0) return text;
    let output = text;
    const entries = [...this.templates.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [raw, template] of entries) {
      if (raw.length < 4 || !output.includes(raw)) continue;
      if (/^\d+$/.test(raw)) {
        // Verification codes are digits only: replace whole numbers, never a
        // run of digits inside a longer number.
        output = output.replace(new RegExp(`(?<![0-9])${raw}(?![0-9])`, "g"), template);
      } else {
        output = output.split(raw).join(template);
      }
    }
    return output;
  }

  /** Resolves every `{{template}}` inside `text` to its live value. */
  resolve(text: string): string {
    return text.replace(/\{\{[a-zA-Z]+(?::[a-zA-Z0-9_-]+(?:#\d+)?)?\}\}/g, (template) => {
      const value = this.values.get(template);
      if (value === undefined) throw new Error(`unresolved template ${template}`);
      return value;
    });
  }

  resolveJson(value: Json): Json {
    if (typeof value === "string") return this.resolve(value);
    if (Array.isArray(value)) return value.map((item) => this.resolveJson(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolveJson(item)]));
    }
    return value;
  }
}

/** The account a value belongs to: the step that produced its localId, or the constant id. */
function ownerName(localId: string, registry: Registry): string {
  const template = registry.templateFor(localId);
  if (template === undefined) return localId;
  const inner = /^\{\{localId:(.+)\}\}$/.exec(template);
  return inner?.[1] ?? localId;
}

function isTimeLike(value: Json): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return /^\d{9,}$/.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value);
  return false;
}

function decodeBase64Json(text: string): Json | undefined {
  try {
    const decoded = Buffer.from(text, "base64").toString("utf8");
    if (!decoded.startsWith("{")) return undefined;
    const parsed = JSON.parse(decoded) as Json;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (BASE64_JSON_MARKERS.some((marker) => marker in parsed)) return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function decodeJwt(text: string): { header: Json; payload: Json } | undefined {
  if (!JWT_PATTERN.test(text)) return undefined;
  const [header = "", payload = ""] = text.split(".");
  try {
    const parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Json;
    const parsedPayload = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Json;
    if (parsedHeader && typeof parsedHeader === "object" && "alg" in parsedHeader) {
      return { header: parsedHeader, payload: parsedPayload };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Structural normalization of a JSON value produced by step `step`: decodes
 * tokens, registers dynamic identifiers and blanks timestamps. String
 * replacement of registered values (`finish`) runs afterwards over the whole
 * recorded step so that values embedded in other strings are templated too.
 */
export function normalizeValue(value: Json, step: string, registry: Registry, key?: string): Json {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, step, registry, key));
  }
  if (value && typeof value === "object") {
    // A salt belongs to its account, not to the step that happened to list
    // it first: name it after the account so listings normalize identically
    // whatever order the emulator returns them in.
    const localId = value.localId;
    if (typeof localId === "string") {
      const owner = ownerName(localId, registry);
      const salt = value.salt;
      if (typeof salt === "string" && salt.length > 0 && !registry.isConstant(salt)) registry.register("salt", owner, salt);
      const hash = value.passwordHash;
      if (typeof hash === "string") {
        const embedded = /^fakeHash:salt=(.+?):password=/.exec(hash);
        if (embedded?.[1] !== undefined && !registry.isConstant(embedded[1])) registry.register("salt", owner, embedded[1]);
      }
    }
    // Keys are visited in sorted order so that the numbering of values first
    // seen in this step does not depend on the emulator's key order.
    const output: { [key: string]: Json } = {};
    for (const childKey of Object.keys(value).sort()) {
      output[childKey] = normalizeValue(value[childKey] as Json, step, registry, childKey);
    }
    return output;
  }
  if (key !== undefined && TIME_KEYS.has(key) && isTimeLike(value) && !(typeof value === "string" && registry.isConstant(value))) {
    return "{{time}}";
  }
  if (typeof value === "string") {
    if (key !== undefined && key in OPAQUE_KEYS) return OPAQUE_KEYS[key] ?? value;
    if (key === "passwordHash") {
      // The official development hash embeds the salt, which may not have
      // been seen under its own key yet.
      const salt = /^fakeHash:salt=(.+?):password=/.exec(value);
      if (salt?.[1] !== undefined && !registry.isConstant(salt[1])) registry.register("salt", step, salt[1]);
      return value;
    }
    const jwt = decodeJwt(value);
    if (jwt) {
      if (key !== undefined && REGISTERED_KEYS[key] !== undefined) registry.register(REGISTERED_KEYS[key], step, value);
      return {
        $jwt: {
          header: normalizeValue(jwt.header, step, registry),
          payload: normalizeValue(jwt.payload, step, registry),
        },
      };
    }
    const base64Json = decodeBase64Json(value);
    if (base64Json) {
      if (key !== undefined && REGISTERED_KEYS[key] !== undefined) registry.register(REGISTERED_KEYS[key], step, value);
      return { $b64json: normalizeValue(base64Json, step, registry) };
    }
    const kind = key === undefined ? undefined : REGISTERED_KEYS[key];
    if (kind !== undefined && value.length > 0) {
      return registry.register(kind, step, value);
    }
    // Passkey options carry the account id base64-encoded.
    if (/^[A-Za-z0-9+/]+=*$/.test(value) && value.length >= 8) {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      const template = registry.templateFor(decoded);
      if (template !== undefined && Buffer.from(decoded, "utf8").toString("base64") === value) {
        return { $base64: template };
      }
    }
    return value;
  }
  return value;
}

/** Applies the registry's string replacement to every string in `value`. */
export function finish(value: Json, registry: Registry): Json {
  if (typeof value === "string") return registry.replaceAll(value);
  if (Array.isArray(value)) return value.map((item) => finish(item, registry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, finish(item, registry)]));
  }
  return value;
}

/** Registers the codes the emulator prints to its log and templates the line. */
export function normalizeLogLine(text: string, step: string, registry: Registry): string {
  let line = text;
  const code = /use the code (\d{6})\./.exec(line);
  if (code?.[1] !== undefined) registry.register("code", step, code[1]);
  const oob = /[?&]oobCode=([A-Za-z0-9_-]+)/.exec(line);
  if (oob?.[1] !== undefined) registry.register("oob", step, oob[1]);
  line = registry.replaceAll(line);
  return line;
}

/** Sorts only the identifier-ordered arrays, keeping every object's key order. */
export function sortUnordered(value: Json, key?: string): Json {
  if (Array.isArray(value)) {
    const items = value.map((item) => sortUnordered(item));
    if (key !== undefined && UNORDERED_ARRAYS.includes(key)) {
      return items
        .map((item) => [JSON.stringify(canonicalize(item)), item] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([, item]) => item);
    }
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sortUnordered(child, childKey)]));
  }
  return value;
}

/** Sorts the arrays whose order is identifier-dependent so two runs compare equal. */
export function canonicalize(value: Json, key?: string): Json {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    if (key !== undefined && UNORDERED_ARRAYS.includes(key)) {
      return items.map((item) => [JSON.stringify(item), item] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, item]) => item);
    }
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([childKey, child]) => [childKey, canonicalize(child, childKey)]),
    );
  }
  return value;
}
