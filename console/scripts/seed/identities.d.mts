export interface SeedUser {
  uid: string
  email: string
  displayName: string
  password: string
}

export const SEED_USERS: readonly SeedUser[]
export function largeScale(): boolean
export function ensureSeedUsers(engine: { origin: string }): Promise<void>
