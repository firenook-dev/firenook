// The options a drop's files carry, shared by the conflict step and "Upload
// with options…": a disclosure whose summary says what is set, then the
// content type (each file's own, or one for all), cacheControl and
// contentDisposition (free text with suggestions) and custom keys. The
// reserved token key is refused on its row.

import { Autocomplete, Radio } from '@cloudflare/kumo'
import { CaretRightIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { KeyValueEditor } from '@/components/console/key-value-editor'
import { customKeyProblem } from '../metadata-draft'
import { type UploadOptions, optionsSummary } from '../upload-options'

const TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/json',
  'text/plain',
  'text/csv',
  'application/pdf',
  'video/mp4',
  'application/octet-stream',
]
const CACHE = [
  'public, max-age=3600',
  'public, max-age=31536000, immutable',
  'private, max-age=0',
  'no-cache',
  'no-store',
]
const DISPOSITIONS = ['inline', 'attachment']

function Suggest({
  value,
  onChange,
  items,
  placeholder,
  label,
}: {
  value: string
  onChange: (value: string) => void
  items: readonly string[]
  placeholder: string
  label: string
}) {
  return (
    <label className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-2">
      <span className="font-mono text-[12px] text-kumo-subtle">{label}</span>
      <Autocomplete
        items={[...items]}
        value={value}
        onValueChange={(next) => onChange(String(next ?? ''))}
      >
        <Autocomplete.InputGroup size="sm" className="font-mono" placeholder={placeholder} />
        <Autocomplete.Content>
          <Autocomplete.List>
            {(item: string) => (
              <Autocomplete.Item key={item} value={item}>
                <span className="font-mono text-[12px]">{item}</span>
              </Autocomplete.Item>
            )}
          </Autocomplete.List>
        </Autocomplete.Content>
      </Autocomplete>
    </label>
  )
}

export function UploadOptionsFields({
  options,
  onChange,
  defaultOpen = false,
}: {
  options: UploadOptions
  onChange: (options: UploadOptions) => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const set = (patch: Partial<UploadOptions>) => onChange({ ...options, ...patch })
  return (
    <div className="grid gap-2" data-testid="upload-options">
      <button
        type="button"
        className="-ml-1 flex h-7 w-max items-center gap-1.5 rounded-md px-1 text-[13px] text-kumo-default hover:ink"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-testid="upload-options-toggle"
      >
        <CaretRightIcon size={11} weight="bold" className={open ? 'rotate-90' : ''} />
        Upload options
        <span className="text-[12px] text-kumo-subtle">· {optionsSummary(options)}</span>
      </button>
      {open && (
        <div className="grid gap-2.5 rounded-lg bg-kumo-tint p-3">
          <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-start gap-2">
            <span className="pt-0.5 font-mono text-[12px] text-kumo-subtle">contentType</span>
            <div className="grid gap-1.5">
              <Radio.Group
                legend="contentType"
                value={options.typeMode}
                onValueChange={(value) => set({ typeMode: value as UploadOptions['typeMode'] })}
                orientation="horizontal"
                className="[&_legend]:sr-only"
              >
                <Radio.Item label="From each file" value="auto" />
                <Radio.Item label="One type for every file" value="fixed" />
              </Radio.Group>
              {options.typeMode === 'fixed' && (
                <Autocomplete
                  items={TYPES}
                  value={options.contentType}
                  onValueChange={(next) => set({ contentType: String(next ?? '') })}
                >
                  <Autocomplete.InputGroup
                    size="sm"
                    className="font-mono"
                    placeholder="image/png"
                  />
                  <Autocomplete.Content>
                    <Autocomplete.List>
                      {(item: string) => (
                        <Autocomplete.Item key={item} value={item}>
                          <span className="font-mono text-[12px]">{item}</span>
                        </Autocomplete.Item>
                      )}
                    </Autocomplete.List>
                  </Autocomplete.Content>
                </Autocomplete>
              )}
            </div>
          </div>
          <Suggest
            label="cacheControl"
            value={options.cacheControl}
            onChange={(cacheControl) => set({ cacheControl })}
            items={CACHE}
            placeholder="public, max-age=3600"
          />
          <Suggest
            label="contentDisposition"
            value={options.contentDisposition}
            onChange={(contentDisposition) => set({ contentDisposition })}
            items={DISPOSITIONS}
            placeholder="inline"
          />
          <KeyValueEditor
            label="Custom metadata"
            rows={options.custom}
            onChange={(custom) => set({ custom })}
            validateKey={customKeyProblem}
            testId="upload-custom-metadata"
          />
        </div>
      )}
    </div>
  )
}
