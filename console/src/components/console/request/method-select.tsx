// The method of a composed request. A method is data — it is what goes on
// the wire and what a person retypes in curl — so it is set in the data
// face, in a menu that names every choice the way the scope picker does.

import { Button, DropdownMenu } from '@cloudflare/kumo'
import { CaretDownIcon } from '@phosphor-icons/react'
import { MenuCheck } from '@/components/kit'
import { HTTP_METHODS, type HttpMethod } from './types'

export function MethodSelect({
  value,
  onChange,
  allowed = HTTP_METHODS,
  testId = 'request-method',
}: {
  value: HttpMethod
  onChange: (method: HttpMethod) => void
  /** The methods this target accepts (a callable: POST only). */
  allowed?: readonly HttpMethod[]
  testId?: string
}) {
  if (allowed.length === 1)
    return (
      <span
        className="flex h-8 shrink-0 items-center rounded-lg bg-kumo-tint px-2.5 font-mono text-[12px] text-kumo-default"
        data-testid={testId}
      >
        {value}
      </span>
    )
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Method ${value}`}
            className="h-8 shrink-0 rounded-lg px-2.5"
            data-testid={testId}
          >
            <span className="flex items-center gap-1.5">
              <span className="font-mono text-[12px]">{value}</span>
              <CaretDownIcon size={12} className="text-kumo-subtle" />
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content>
        {allowed.map((method) => (
          <DropdownMenu.Item key={method} onClick={() => onChange(method)}>
            <span className="font-mono text-[12px]">{method}</span>
            <MenuCheck on={method === value} />
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
