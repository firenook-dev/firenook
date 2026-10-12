// Resumable uploads an app started and has not finished — a stuck
// uploadBytesResumable has something to look at: the name, how much
// arrived, how long it has been idle, who started it, and Discard (which
// removes the staged bytes). Sessions idle for seven days are swept by the
// engine, as production forgets them.

import { Button, Popover } from '@cloudflare/kumo'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { PanelTitle } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { OWNER_AUTHORIZATION } from '@/lib/identity'
import { toast } from '@/lib/toasts'
import { discardSession } from '../api'
import { useFiles } from '../files-state'
import { sessionsQuery, storageKeys } from '../queries'
import { sessionIdle, sessionOwner, sessionProgress } from '../sessions'

export function useSessions() {
  const files = useFiles()
  return useQuery(sessionsQuery(files.project, files.bucket))
}

/**
 * The list, opened by its owner beside `anchor` — the bucket menu's button,
 * the tray's line, the toolbar when ⌘K asks — rather than by a trigger of
 * its own, since it is reached from several places.
 */
export function UploadsInProgress({
  anchor,
  onClose,
}: {
  /** Where it hangs; `null` while it is shut. */
  anchor: Element | null
  onClose: () => void
}) {
  const files = useFiles()
  const queryClient = useQueryClient()
  const sessions = useSessions()
  const now = useNow('minute')
  const [discarding, setDiscarding] = useState<string | null>(null)
  const items = sessions.data?.items ?? []
  return (
    <Popover open={anchor !== null} onOpenChange={(open) => !open && onClose()}>
      <Popover.Content anchor={anchor} className="grid w-[480px] max-w-[calc(100vw-2rem)] gap-2">
        <div className="contents" data-testid="uploads-in-progress">
          <PanelTitle>Uploads in progress</PanelTitle>
          {items.length === 0 ? (
            <p className="text-[13px] text-kumo-subtle">
              No resumable upload is waiting in{' '}
              <span className="font-mono text-[0.9em]">gs://{files.bucket}</span>.
            </p>
          ) : (
            <ul className="grid max-h-80 gap-0.5 overflow-y-auto">
              {items.map((session) => (
                <li
                  key={session.id}
                  className="flex items-center gap-2 rounded-md px-1 py-1 hover:ink"
                  data-testid="session-row"
                >
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate font-mono text-[12px] text-kumo-default">
                      {session.name}
                    </span>
                    <span className="truncate text-[12px] text-kumo-subtle">
                      <span className="font-mono">{sessionProgress(session)}</span>
                      {sessionIdle(session, now) ? ` · ${sessionIdle(session, now)}` : ''} ·{' '}
                      {sessionOwner(session)}
                    </span>
                  </span>
                  {files.admin && (
                    <Button
                      variant="ghost"
                      size="xs"
                      loading={discarding === session.id}
                      onClick={async () => {
                        setDiscarding(session.id)
                        try {
                          await discardSession(
                            { bucket: files.bucket, id: session.id },
                            { authorization: OWNER_AUTHORIZATION },
                          )
                          void queryClient.invalidateQueries({
                            queryKey: storageKeys.sessions(files.project, files.bucket),
                          })
                          toast({
                            key: 'storage-session',
                            title: `Discarded the upload of ${session.name}`,
                            tone: 'success',
                          })
                        } catch (error) {
                          toast({
                            key: 'storage-session',
                            title: 'Could not discard the upload',
                            description: error instanceof Error ? error.message : String(error),
                            tone: 'danger',
                          })
                        } finally {
                          setDiscarding(null)
                        }
                      }}
                      data-testid="session-discard"
                    >
                      Discard
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12px] text-kumo-subtle">
            Staged bytes count as in flight in the bucket's figures. A session idle for seven days
            is swept, as production forgets it.
          </p>
        </div>
      </Popover.Content>
    </Popover>
  )
}
