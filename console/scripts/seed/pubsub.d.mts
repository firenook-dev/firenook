/** The Pub/Sub world the messaging journeys read; `large` adds the perf dataset. */
export function seed(
  engine: { origin: string; project: string; ports: Record<string, number> },
  options?: { large?: boolean },
): Promise<void>
