/** A file's name, which is how people know it; the whole path is a hover away. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}
