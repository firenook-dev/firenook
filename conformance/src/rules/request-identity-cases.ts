/**
 * Who a Firestore request is from, as the emulator reads its Authorization
 * header: the synthetic identities, rules and paths of the
 * `request-identity-v1` corpus. No verdict is assumed here; the capture
 * records what the official emulator decides.
 */
export const identityProject = "demo-firenook-identity";

/** The database `firebase.json` would list, and one it would not. */
export const identityDatabases = ["(default)", "unlisted"] as const;

/**
 * One deny-all path, one path only a signed-out client may read, one only
 * `alice` may read, and paths that show what `request.auth` holds.
 */
export const identityRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /deny/{doc} { allow read, write: if false; }
    match /anon/{doc} { allow read, write: if request.auth == null; }
    match /alice/{doc} { allow read, write: if request.auth.uid == 'alice'; }
    match /uid-null/{doc} { allow get: if request.auth != null && request.auth.uid == null; }
    match /token-sub/{doc} { allow get: if request.auth.token.sub == 'alice'; }
    match /token-keys/{doc} { allow get: if request.auth.token.keys().hasOnly(['sub']); }
    match /two/{doc} {
      allow get: if false;
      allow get: if request.auth.uid == 'x';
    }
    match /writes/{doc} { allow create: if request.resource.data.n > 1; }
  }
}
`;

/** Paths every identity reads on every database. */
export const identityPaths = ["deny/x", "anon/x", "alice/x"] as const;

/** Paths that show the claims the rules see, read on `(default)` only. */
export const claimPaths = ["uid-null/x", "token-sub/x", "token-keys/x"] as const;

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** An unsigned JWT the way `createMockUserToken` builds one (`{alg: none, type: JWT}`). */
export function jwt(payload: unknown, header: unknown = { alg: "none", type: "JWT" }, signature = ""): string {
  return `${encode(header)}.${encode(payload)}.${signature}`;
}

/** The claims `createMockUserToken` sets, at `issuedAt`, for `project`. */
export function mockClaims(issuedAt: number, project = identityProject, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `https://securetoken.google.com/${project}`, aud: project, iat: issuedAt, exp: issuedAt + 3600, auth_time: issuedAt,
    sub: "alice", user_id: "alice", firebase: { sign_in_provider: "custom", identities: {} }, ...overrides,
  };
}

export interface Identity {
  readonly id: string;
  /** What the header is, in words, for the fixture. */
  readonly header: string;
  /** The Authorization value, or undefined for none. */
  readonly value: (nowSeconds: number) => string | undefined;
}

export const identities: readonly Identity[] = [
  { id: "absent", header: "no Authorization header (a signed-out client SDK)", value: () => undefined },
  { id: "owner", header: "Bearer owner (the Admin SDKs' emulator credential)", value: () => "Bearer owner" },
  { id: "owner-lowercase", header: "bearer owner", value: () => "bearer owner" },
  { id: "owner-uppercase", header: "BEARER OWNER", value: () => "BEARER OWNER" },
  { id: "user", header: "a current unsigned token for alice", value: (now) => `Bearer ${jwt(mockClaims(now - 30))}` },
  { id: "user-lowercase-scheme", header: "bearer <current unsigned token for alice>", value: (now) => `bearer ${jwt(mockClaims(now - 30))}` },
  { id: "issued-at-zero", header: "the token createMockUserToken builds without iat: iat 0, exp 3600", value: () => `Bearer ${jwt(mockClaims(0))}` },
  { id: "issued-tomorrow", header: "a token issued a day from now", value: (now) => `Bearer ${jwt(mockClaims(now + 86_400))}` },
  { id: "other-project", header: "a token whose aud and iss name another project", value: (now) => `Bearer ${jwt(mockClaims(now - 30, "demo-other-project"))}` },
  { id: "other-audience", header: "a token whose aud alone names another project", value: (now) => `Bearer ${jwt(mockClaims(now - 30, identityProject, { aud: "demo-other-project" }))}` },
  { id: "sub-only", header: "an unsigned token with only sub: alice", value: () => `Bearer ${jwt({ sub: "alice" })}` },
  { id: "user-id-only", header: "an unsigned token with only user_id: alice", value: () => `Bearer ${jwt({ user_id: "alice" })}` },
  { id: "empty-claims", header: "an unsigned token with no claims", value: () => `Bearer ${jwt({})}` },
  { id: "numeric-sub", header: "an unsigned token with sub: 7", value: () => `Bearer ${jwt({ sub: 7 })}` },
  { id: "no-alg", header: "a token whose header has no alg", value: () => `Bearer ${jwt({ sub: "alice" }, {})}` },
  { id: "signed", header: "an RS256 header and a signature nobody checks", value: (now) => `Bearer ${jwt(mockClaims(now - 30), { alg: "RS256", kid: "synthetic" }, "c2lnbmF0dXJl")}` },
  { id: "padded-base64", header: "standard padded base64 segments", value: () => `Bearer ${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64")}.${Buffer.from(JSON.stringify({ sub: "alice" })).toString("base64")}.` },
  { id: "two-segments", header: "a token of two segments", value: () => `Bearer ${encode({ alg: "none" })}.${encode({ sub: "alice" })}` },
  { id: "array-claims", header: "a token whose payload is an array", value: () => `Bearer ${jwt(["alice"])}` },
  { id: "not-a-jwt", header: "Bearer not-a-jwt", value: () => "Bearer not-a-jwt" },
  { id: "basic", header: "a Basic credential", value: () => "Basic YWxpY2U6c2VjcmV0" },
  { id: "firebase-owner", header: "Firebase owner (Storage's admin credential)", value: () => "Firebase owner" },
];

/** Bodies the rules hot-reload route is sent with, and their content types. */
export const reloadBodies = [
  { id: "json", contentType: "application/json" },
  { id: "text-plain", contentType: "text/plain;charset=UTF-8" },
  { id: "no-content-type", contentType: undefined },
] as const;
