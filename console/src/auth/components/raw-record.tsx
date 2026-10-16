// The Raw tab: the account exactly as the emulator stores and exports it
// (`accounts.json`), read-only, with its password hash and salt masked
// until asked for.

import { Button } from '@cloudflare/kumo'
import type { AuthUserDetail } from '@/api/generated/auth/AuthUserDetail'
import { JsonTree } from '@/components/console/json-tree'
import { CopyGlyph, useCopied } from '@/components/kit'

const SECRETS = new Set(['passwordHash', 'salt'])

export function RawRecord({ detail }: { detail: AuthUserDetail }) {
  const { copied, copy } = useCopied()
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-5 py-3" data-testid="raw-record">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[12px] text-kumo-subtle">
          The record the emulator stores and exports (
          <span className="font-mono text-[0.9em]">accounts.json</span>).
        </p>
        <Button
          variant="secondary"
          size="sm"
          icon={<CopyGlyph copied={copied} />}
          onClick={() => void copy(JSON.stringify(detail.record, null, 2))}
          data-testid="raw-copy"
        >
          {copied ? 'Copied' : 'Copy JSON'}
        </Button>
      </div>
      <JsonTree
        value={detail.record}
        defaultDepth={2}
        height="fill"
        mask={(path) => path.length === 1 && SECRETS.has(String(path[0]))}
        ariaLabel="The stored record"
        testId="raw-tree"
      />
    </div>
  )
}
