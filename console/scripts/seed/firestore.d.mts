export function seedFirestore(
  origin: string,
  project: string,
  database?: string,
): Promise<{ documents: number; users: Array<{ uid: string; email: string }> }>

export function seed(engine: { origin: string; project: string }): Promise<void>
