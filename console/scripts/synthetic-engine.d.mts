export function startEngine(options?: {
  project?: string
  only?: string
  inherit?: boolean
}): Promise<{
  origin: string
  project: string
  ports: Record<string, number>
  stop: () => Promise<void>
}>
