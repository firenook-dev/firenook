// The observe seeder: what the observe stream writes into a running engine
// for its journeys, using `SEED_USERS` (`./identities.mjs`) for anyone it
// needs and `largeScale()` for its perf dataset. Nothing to write until the
// stream's section needs data; the stream owns this file.

/** @param {{ origin: string, project: string, ports: Record<string, number> }} _engine */
export async function seed(_engine) {}
