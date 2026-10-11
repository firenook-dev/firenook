export function seedFirestore(
  origin: string,
  project: string,
  database?: string,
): Promise<{ documents: number; users: Array<{ uid: string; email: string }> }>
