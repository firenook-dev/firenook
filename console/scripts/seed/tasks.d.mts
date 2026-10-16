/** Nothing by default; `large` pauses sendEmail and fills it to its 10,000 tasks. */
export function seed(
  engine: { origin: string; project: string; ports: Record<string, number> },
  options?: { large?: boolean },
): Promise<void>
