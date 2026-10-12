// A section held back for one test: what its links, hits and pages do while
// it is not built yet. Sections flip `built` as their journeys pass, so the
// tests of that gate take any section and set it back rather than rely on
// one staying unbuilt.

import type { ConsoleSection } from '@/lib/services'

/** Runs `check` with `section` marked not built, and puts it back after. */
export async function whileUnbuilt<T>(
  section: ConsoleSection,
  check: () => T | Promise<T>,
): Promise<T> {
  const built = section.built
  section.built = false
  try {
    return await check()
  } finally {
    section.built = built
  }
}
