/**
 * Compares a Firenook capture of the request-identity corpus with the
 * official emulator's. Status codes must match exactly, except where the
 * divergence table below says why they differ; a denial must keep the
 * production text and name the same rule lines the official emulator names.
 */
type Outcome = { code: number; message: string };
type HttpOutcome = { status: number; code: string; message: string };
export interface IdentityCapture {
  reads: { database: string; identity: string; path: string; grpc: Outcome; rest: HttpOutcome }[];
  claims: { identity: string; path: string; rest: HttpOutcome }[];
  denials: Record<string, { grpc?: Outcome; rest?: HttpOutcome }>;
  metadata: { mode: string; identity: string; grpc: Outcome; rest: HttpOutcome; partition: Outcome }[];
  pipelines: { identity: string; pipeline: Outcome; query: Outcome }[];
  reload: { body: string; status: number; governs: number }[];
}

/** What production answers a refused request; Firenook keeps it first. */
export const PRODUCTION_DENIAL = "Missing or insufficient permissions.";

/**
 * Real divergences, with their reasons. The official emulator answers a
 * credential that is not `Bearer` with an empty UNKNOWN (gRPC 2, HTTP 500),
 * which the SDKs retry; Firenook answers it as it answers any other
 * credential it cannot read, INVALID_ARGUMENT naming the problem.
 */
export const identityDivergences: Record<string, { grpc: number; rest: number; reason: string }> = {
  basic: { grpc: 3, rest: 400, reason: "a non-Bearer credential is INVALID_ARGUMENT, not an empty UNKNOWN" },
  "firebase-owner": { grpc: 3, rest: 400, reason: "a non-Bearer credential is INVALID_ARGUMENT, not an empty UNKNOWN" },
};

/**
 * The jar does not implement `PartitionQuery` (UNIMPLEMENTED). Firenook
 * serves it to the owner, the Admin SDKs' `getPartitions()`, and refuses
 * everyone else as the jar refuses the other reads no rule governs,
 * `ListCollectionIds`.
 */
export const partitionDivergence = { owner: 0, other: 7, reason: "PartitionQuery is served to the owner only; the jar does not implement it" };

/** The `@ L<n>` rule lines a denial names, in order, without repeats. */
export function ruleLines(message: string): string[] {
  return [...new Set([...message.matchAll(/@ L(\d+)/g)].map((match) => match[1]!))];
}

export function compareIdentityCapture(actual: IdentityCapture, expected: IdentityCapture): string[] {
  const problems: string[] = [];
  const expectCode = (label: string, identity: string, actualCode: number, expectedCode: number, transport: "grpc" | "rest") => {
    const divergence = identityDivergences[identity];
    const wanted = divergence ? divergence[transport] : expectedCode;
    if (actualCode !== wanted) problems.push(`${label}: ${transport} ${actualCode}, expected ${wanted}${divergence ? ` (${divergence.reason})` : ""}`);
  };
  const expectDenial = (label: string, actualMessage: string, expectedMessage: string) => {
    if (!actualMessage.startsWith(PRODUCTION_DENIAL)) problems.push(`${label}: denial "${actualMessage}" does not start with "${PRODUCTION_DENIAL}"`);
    const lines = ruleLines(actualMessage).join(",");
    const wanted = ruleLines(expectedMessage).join(",");
    if (lines !== wanted) problems.push(`${label}: denial names rule lines [${lines}], the official emulator [${wanted}]`);
    if (expectedMessage === "No matching allow statements" && !actualMessage.endsWith(expectedMessage)) problems.push(`${label}: denial "${actualMessage}" does not say "${expectedMessage}"`);
  };
  const pairs = <T extends object>(name: string, left: T[], right: T[], key: (value: T) => string) => {
    const index = new Map(right.map((value) => [key(value), value]));
    if (left.length !== right.length) problems.push(`${name}: ${left.length} observations, expected ${right.length}`);
    return left.flatMap((value) => {
      const match = index.get(key(value));
      if (!match) problems.push(`${name}: unexpected ${key(value)}`);
      return match ? [[value, match] as const] : [];
    });
  };
  for (const [got, want] of pairs("reads", actual.reads, expected.reads, (read) => `${read.database} ${read.identity} ${read.path}`)) {
    const label = `read ${got.database} ${got.identity} ${got.path}`;
    expectCode(label, got.identity, got.grpc.code, want.grpc.code, "grpc");
    expectCode(label, got.identity, got.rest.status, want.rest.status, "rest");
    if (want.grpc.code === 7 && got.grpc.code === 7) expectDenial(`${label} grpc`, got.grpc.message, want.grpc.message);
    if (want.rest.status === 403 && got.rest.status === 403) expectDenial(`${label} rest`, got.rest.message, want.rest.message);
  }
  for (const [got, want] of pairs("claims", actual.claims, expected.claims, (claim) => `${claim.identity} ${claim.path}`)) {
    expectCode(`claim ${got.identity} ${got.path}`, got.identity, got.rest.status, want.rest.status, "rest");
  }
  for (const [name, want] of Object.entries(expected.denials)) {
    const got = actual.denials[name];
    if (!got) { problems.push(`denial ${name}: missing`); continue; }
    for (const transport of ["grpc", "rest"] as const) {
      const wanted = want[transport];
      const observed = got[transport];
      if (!wanted) continue;
      if (!observed) { problems.push(`denial ${name}: no ${transport} observation`); continue; }
      const code = "code" in observed && typeof observed.code === "number" ? observed.code : (observed as HttpOutcome).status;
      const wantedCode = "code" in wanted && typeof wanted.code === "number" ? wanted.code : (wanted as HttpOutcome).status;
      if (code !== wantedCode) problems.push(`denial ${name}: ${transport} ${code}, expected ${wantedCode}`);
      expectDenial(`denial ${name} ${transport}`, observed.message, wanted.message);
    }
  }
  for (const [got, want] of pairs("metadata", actual.metadata, expected.metadata, (row) => `${row.mode} ${row.identity}`)) {
    expectCode(`metadata ${got.mode} ${got.identity}`, got.identity, got.grpc.code, want.grpc.code, "grpc");
    expectCode(`metadata ${got.mode} ${got.identity}`, got.identity, got.rest.status, want.rest.status, "rest");
    if (want.grpc.code === 7 && got.grpc.message !== want.grpc.message) problems.push(`metadata ${got.mode} ${got.identity}: "${got.grpc.message}", expected "${want.grpc.message}"`);
    const partition = got.identity === "owner" ? partitionDivergence.owner : partitionDivergence.other;
    if (want.partition.code !== 12) problems.push(`metadata ${got.mode} ${got.identity}: the oracle now answers PartitionQuery ${want.partition.code}; recapture and drop the divergence`);
    if (got.partition.code !== partition) problems.push(`partition ${got.mode} ${got.identity}: ${got.partition.code}, expected ${partition} (${partitionDivergence.reason})`);
  }
  for (const [got, want] of pairs("pipelines", actual.pipelines, expected.pipelines, (row) => row.identity)) {
    for (const kind of ["pipeline", "query"] as const) {
      if (got[kind].code !== want[kind].code) problems.push(`${kind} as ${got.identity}: ${got[kind].code}, expected ${want[kind].code}`);
      if (want[kind].code === 7 && got[kind].code === 7) expectDenial(`${kind} as ${got.identity}`, got[kind].message, want[kind].message);
    }
  }
  for (const [got, want] of pairs("reload", actual.reload, expected.reload, (row) => row.body)) {
    if (got.status !== want.status || got.governs !== want.governs) problems.push(`reload ${got.body}: ${got.status}/${got.governs}, expected ${want.status}/${want.governs}`);
  }
  return problems;
}
