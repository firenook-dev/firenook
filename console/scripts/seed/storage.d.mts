export interface StorageSeed {
  users: { ada: string; grace: string }
  default: { files: number; bytes: number; rootFolders: number }
  media: { files: number; bytes: number; banners: number }
  /** Direct entries (files and folders) of each folder of the default bucket; `''` is the root. */
  counts: Record<string, number>
  /** The CSV files in `exports/`. */
  csvCount: number
  largest: { name: string; size: number }
  /** Each seeded file's size, by name (both buckets). */
  sizes: Record<string, number>
  names: {
    avatar: string
    graceAvatar: string
    fromApp: string
    readme: string
    products: string
    events: string
    bigCsv: string
    report: string
    tone: string
    pdf: string
    zip: string
    blob: string
    mislabelled: string
    double: string
    lead: string
    logo: string
    logoSvg: string
    marker: string
    sharedAda: string
    sharedGrace: string
  }
}

export const STORAGE_SEED: StorageSeed
export function seed(engine: { origin: string; project: string }): Promise<void>
