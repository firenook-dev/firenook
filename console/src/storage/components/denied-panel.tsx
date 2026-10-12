// A listing the identity may not read: who could not list what, the line
// that refused it in the rules' own words, "See why" with the explanation
// the refusal carried, and the way back to Admin. Never an empty list,
// which would read as "nothing here".

import { Button, Empty } from '@cloudflare/kumo'
import { LockKeyIcon } from '@phosphor-icons/react'
import { describeViewAsShort } from '@/lib/identity'
import type { StorageApiError } from '../api'
import { useFiles } from '../files-state'
import { RefusalDetail, useRulesText } from './refusal-detail'

export function DeniedPanel({ error, what }: { error: StorageApiError; what: string }) {
  const files = useFiles()
  const { line } = useRulesText()
  const who = describeViewAsShort(files.viewAs)
  const refusing = error.extras.line ?? undefined
  const text = refusing === undefined ? undefined : line(refusing)
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="denied-panel">
      <Empty
        icon={<LockKeyIcon size={48} className="text-kumo-inactive" />}
        title={`${who} can't list ${what}`}
        description={
          error.extras.noRuleset
            ? 'No rules govern this bucket, so the emulator refuses every client request to it.'
            : refusing === undefined
              ? 'No allow matched, so the rules refused it by default.'
              : `Line ${refusing} refused it.`
        }
        contents={
          <div className="grid w-[min(560px,100%)] justify-items-center gap-3">
            {text && (
              <code className="max-w-full rounded-md bg-kumo-tint px-2 py-1 font-mono text-[12px] break-words text-kumo-default">
                {text}
              </code>
            )}
            <div className="flex gap-2">
              <RefusalDetail
                extras={error.extras}
                trigger={
                  <Button variant="secondary" data-testid="denied-see-why">
                    See why
                  </Button>
                }
              />
              <Button
                variant="ghost"
                onClick={() => files.setViewAs({ kind: 'owner' })}
                data-testid="denied-back-to-admin"
              >
                Back to Admin
              </Button>
            </div>
          </div>
        }
      />
    </div>
  )
}
