// A file the page handed the browser to save.

/** A download's bytes, as text. */
export async function readDownload(download: { path(): Promise<string> }): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(await download.path(), 'utf8')
}
