// Import users (`?new=import`): an emulator export (`accounts.json`), a
// Firebase CLI `auth:export` file or a plain array. The browser reads only
// the first 64 KB to recognise the file; Check uploads the file itself —
// streamed from disk, once — and the engine reads it user by user and
// answers a dry run: how many, by provider, with passwords, with hashes the
// emulator cannot read, with claims, which uids already exist and the first
// problems. Import then starts a job over the upload the engine kept, so a
// 70 MB file crosses the wire once. Imports fire no `user.create`, as the
// emulator's own import fires none.

import { Button, Dialog, Tabs, Text } from '@cloudflare/kumo'
import { FileArrowUpIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { type DragEvent, useEffect, useRef, useState } from 'react'
import type { AuthImportMode } from '@/api/generated/auth/AuthImportMode'
import type { AuthImportPreview } from '@/api/generated/auth/AuthImportPreview'
import { jobProgress } from '@/components/console/danger-confirm'
import { formatBytes, formatCount, formatNumber } from '@/lib/format'
import { cancelJob, useJob } from '@/lib/jobs'
import { discardImport, previewImport, startImport, uploadImport } from '../api'
import { type ImportRecognition, recogniseImportFile } from '../import'
import { refusal } from '../user-actions'
import { DIALOG_INPUT, DialogField } from './dialog-field'

const USERS = { one: 'user', other: 'users' }

export function ImportUsersDialog({
  open,
  onOpenChange,
  project,
  tenant,
  blocked,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: string
  tenant: string | undefined
  blocked: string | undefined
}) {
  const [session, setSession] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setSession((value) => value + 1)
  }
  // The form reports what may not be thrown away by a click outside.
  const [busy, setBusy] = useState(false)
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return
        onOpenChange(next)
      }}
    >
      <Dialog size="lg" className="p-6">
        <ImportForm
          key={session}
          project={project}
          tenant={tenant}
          blocked={blocked}
          onBusy={setBusy}
          onClose={() => onOpenChange(false)}
        />
      </Dialog>
    </Dialog.Root>
  )
}

function ImportForm({
  project,
  tenant,
  blocked,
  onBusy,
  onClose,
}: {
  project: string
  tenant: string | undefined
  blocked: string | undefined
  onBusy: (busy: boolean) => void
  onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | undefined>(undefined)
  const [recognition, setRecognition] = useState<ImportRecognition | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const [mode, setMode] = useState<AuthImportMode>('skip')
  const [replacePassword, setReplacePassword] = useState('')
  const [jobId, setJobId] = useState<string | undefined>(undefined)
  const choose = (chosen: File | undefined) => {
    setFile(chosen)
    setRecognition(undefined)
    upload.reset()
    if (chosen) void recogniseImportFile(chosen).then(setRecognition)
  }
  const upload = useMutation({
    mutationFn: (chosen: File) => uploadImport(project, tenant, chosen),
  })
  const uploaded = upload.data
  const options = {
    mode,
    ...(replacePassword.trim() ? { replacePassword: replacePassword.trim() } : {}),
  }
  // The options change what the import would do: the kept upload is previewed again.
  const reviewed = useQuery({
    queryKey: ['auth', project, 'import-preview', uploaded?.importId, mode, replacePassword.trim()],
    queryFn: ({ signal }) =>
      previewImport({ importId: uploaded?.importId ?? '', ...options }, signal),
    enabled:
      uploaded !== undefined &&
      jobId === undefined &&
      (mode !== 'skip' || replacePassword.trim() !== ''),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
  const preview: AuthImportPreview | undefined = reviewed.data ?? uploaded
  const start = useMutation({
    mutationFn: () => startImport({ importId: uploaded?.importId ?? '', ...options }),
    onSuccess: (job) => setJobId(job.id),
  })
  const job = useJob(jobId)
  const running = upload.isPending || start.isPending || job?.state === 'running'
  const finished = job !== undefined && job.state !== 'running'
  useEffect(() => onBusy(running), [running, onBusy])

  const close = () => {
    // An upload that was never imported is not kept waiting for its 10 minutes.
    if (uploaded && jobId === undefined) void discardImport(uploaded.importId).catch(() => {})
    onClose()
  }
  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    choose(event.dataTransfer.files[0])
  }
  return (
    <div className="flex max-h-[calc(100vh-6rem)] flex-col" data-testid="import-users-dialog">
      <div className="mb-3 flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold">Import users</Dialog.Title>
        <Button
          variant="ghost"
          shape="square"
          icon={<XIcon />}
          aria-label="Close"
          disabled={running}
          onClick={close}
        />
      </div>
      <Dialog.Description className="text-kumo-subtle">
        An emulator export (accounts.json), a Firebase CLI auth:export file or a JSON array of
        users, into {tenant ? `tenant ${tenant}` : 'the project’s users'}. Imports do not fire
        user.create, as the emulator’s own import does not.
      </Dialog.Description>
      {/* Inset a step so the rings of what scrolls are not cut by the scroller. */}
      <div className="-mx-1 mt-4 grid min-h-0 gap-3 overflow-y-auto px-1 py-1">
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          disabled={running || jobId !== undefined}
          className={`flex min-h-24 flex-col items-center justify-center gap-1 rounded-lg px-4 py-3 text-center ring-1 ring-dashed hover:ink ${
            dragging ? 'bg-kumo-tint ring-kumo-focus' : 'ring-kumo-line'
          }`}
          data-testid="import-drop"
        >
          <FileArrowUpIcon size={22} className="text-kumo-subtle" />
          {file ? (
            <span className="text-[13px] text-kumo-default">
              <span className="font-mono text-[0.9em]">{file.name}</span> · {formatBytes(file.size)}
            </span>
          ) : (
            <span className="text-[13px] text-kumo-subtle">Drop a file here, or choose one</span>
          )}
          {recognition && (
            <span
              className={`text-[12px] ${recognition.ok ? 'text-kumo-subtle' : 'text-kumo-danger'}`}
              data-testid="import-recognised"
            >
              {recognition.ok ? recognition.label : recognition.message}
            </span>
          )}
        </button>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => choose(event.target.files?.[0])}
          data-testid="import-file"
        />
        {preview && <ImportSummary preview={preview} />}
        {preview && jobId === undefined && (
          <div className="grid gap-3">
            {preview.existingCount > 0 && (
              <Tabs
                size="sm"
                variant="segmented"
                value={mode}
                onValueChange={(value) => setMode(value as AuthImportMode)}
                tabs={[
                  { value: 'skip', label: 'Skip users whose uid exists' },
                  { value: 'overwrite', label: 'Overwrite them' },
                ]}
              />
            )}
            {preview.opaqueHashes > 0 && (
              <DialogField
                label="Replace every password with"
                hint={`(${formatCount(preview.opaqueHashes, USERS)} carry production hashes the emulator cannot check)`}
              >
                <input
                  value={replacePassword}
                  onChange={(event) => setReplacePassword(event.target.value)}
                  spellCheck={false}
                  placeholder="password-1"
                  className={`${DIALOG_INPUT} ring-kumo-line`}
                  data-testid="import-replace-password"
                />
              </DialogField>
            )}
          </div>
        )}
        {job && (
          <Text variant="secondary" size="sm">
            <span data-testid="import-progress">{jobProgress(job, 'imported')}</span>
          </Text>
        )}
        {(upload.isError || start.isError || reviewed.isError) && (
          <p className="text-[13px] text-kumo-danger" data-testid="import-error">
            {refusal(upload.error ?? start.error ?? reviewed.error)}
          </p>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        {job?.state === 'running' ? (
          <Button variant="secondary" onClick={() => void cancelJob(job.id)}>
            Cancel
          </Button>
        ) : (
          <Button variant="secondary" onClick={close} disabled={upload.isPending}>
            {finished ? 'Close' : 'Cancel'}
          </Button>
        )}
        {!uploaded ? (
          <Button
            variant="primary"
            onClick={() => {
              if (file) upload.mutate(file)
            }}
            disabled={!file || recognition?.ok === false || blocked !== undefined}
            loading={upload.isPending}
            data-testid="import-check"
          >
            Check
          </Button>
        ) : (
          !finished && (
            <Button
              variant="primary"
              onClick={() => start.mutate()}
              loading={start.isPending || job?.state === 'running'}
              disabled={
                reviewed.isFetching ||
                blocked !== undefined ||
                preview === undefined ||
                preview.total === 0
              }
              data-testid="import-go"
            >
              Import {preview ? formatCount(importable(preview, mode), USERS) : ''}
            </Button>
          )
        )}
      </div>
    </div>
  )
}

/** How many users the import would write with these options. */
function importable(preview: AuthImportPreview, mode: AuthImportMode): number {
  const skipped = mode === 'skip' ? preview.existingCount : 0
  return Math.max(0, preview.total - skipped - preview.problemCount)
}

function ImportSummary({ preview }: { preview: AuthImportPreview }) {
  const facts: string[] = [
    formatCount(preview.total, USERS),
    `${formatNumber(preview.withPassword)} with passwords`,
    `${formatNumber(preview.withClaims)} with claims`,
  ]
  return (
    <div
      className="grid gap-2 rounded-md bg-kumo-tint p-3 text-[13px]"
      data-testid="import-preview"
    >
      <p className="text-kumo-default">{facts.join(' · ')}</p>
      {preview.byProvider.length > 0 && (
        <p className="font-mono text-[12px] text-kumo-subtle">
          {preview.byProvider
            .map((entry) => `${entry.provider} ${formatNumber(entry.users)}`)
            .join(' · ')}
        </p>
      )}
      {preview.opaqueHashes > 0 && (
        <p className="text-kumo-warning">
          {formatCount(preview.opaqueHashes, USERS)} carry a production password hash the emulator
          cannot check; they cannot sign in with a password until one is set.
        </p>
      )}
      {preview.existingCount > 0 && (
        <p className="text-kumo-subtle">
          {formatCount(preview.existingCount, USERS)} already exist here
          {preview.existing.length > 0 ? (
            <>
              {': '}
              <span className="font-mono text-[12px]">
                {preview.existing.slice(0, 5).join(', ')}
                {preview.existingCount > 5 ? ', …' : ''}
              </span>
            </>
          ) : null}
          .
        </p>
      )}
      {preview.problemCount > 0 && (
        <div className="grid gap-1">
          <p className="text-kumo-danger">
            {formatCount(preview.problemCount, { one: 'user is', other: 'users are' })} refused:
          </p>
          <ul className="grid max-h-32 gap-0.5 overflow-auto text-[12px]">
            {preview.problems.map((problem) => (
              <li key={problem.index} className="text-kumo-subtle">
                <span className="font-mono">#{problem.index}</span>
                {problem.uid ? <span className="font-mono"> {problem.uid}</span> : null}:{' '}
                {problem.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
