export function seedCarts(
  engine: { origin: string; project: string },
  count?: number,
): Promise<void>
export function seedBulk(engine: { origin: string; project: string }, count?: number): Promise<void>
export function seed(engine: {
  origin: string
  project: string
  ports: Record<string, number>
}): Promise<void>
