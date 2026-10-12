// The log line every section shares (observe's isolated commit 10, built
// by the foundation so every stream has it from G2): the Logs page's rows
// by level, sources, multi-line and grouped lines, the cursor row, an
// expanded payload, and an invocation's lines with offsets.

import { Text } from '@cloudflare/kumo'
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react'
import type { CSSProperties, ReactNode } from 'react'
import { LogLine, SOURCE_CHIP } from '@/components/console/log-line'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

const day = '2026-10-12T'
const at = (time: string) => `${day}${time}Z`

function Lines({ children, source = '96px' }: { children: ReactNode; source?: string }) {
  return (
    <div
      className="overflow-hidden rounded-lg bg-kumo-base py-1 ring ring-kumo-line"
      style={{ '--log-source-width': source } as CSSProperties}
    >
      {children}
    </div>
  )
}

function Caret({ open = false }: { open?: boolean }) {
  return (
    <span className={`${SOURCE_CHIP} gap-0.5`}>
      {open ? <CaretDownIcon size={9} /> : <CaretRightIcon size={9} />}
      {'{}'}
    </span>
  )
}

const link = (text: string) => <span className="text-[12px] text-kumo-link">{text}</span>

function LogLinesCard() {
  return (
    <Stack>
      <Section
        title="The Logs page"
        note="Info says nothing about its level; warnings and errors carry a rail. Sources are quiet chips; a line with more lines, or repeated, says so at its end."
      >
        <Lines>
          <LogLine
            time={at('06:04:31.204')}
            level="info"
            source="hub"
            message="All emulators ready; 4 functions discovered"
          />
          <LogLine
            time={at('06:06:09.117')}
            level="info"
            source="hello"
            message='Beginning execution of "us-central1-hello"'
            trail={<span className="font-mono text-[11px] text-kumo-subtle">GET /</span>}
          />
          <LogLine
            time={at('06:06:09.120')}
            level="debug"
            source="hello"
            message="cache miss for cart c_19"
          />
          <LogLine
            time={at('06:06:09.126')}
            level="warn"
            source="hello"
            message="Cart is empty"
            trail={<Caret />}
            selected
          />
          <LogLine
            time={at('06:06:09.311')}
            level="info"
            source="hello"
            message='Finished "us-central1-hello" in 194ms'
          />
          <LogLine
            time={at('06:06:10.002')}
            level="error"
            source="fails"
            message={
              "TypeError: cannot read 'id' of undefined\n    at handler (/functions/index.js:41:18)"
            }
            lines={14}
          />
          <LogLine
            time={at('06:06:10.950')}
            level="warn"
            source="firestore"
            message="Rules denied get on users/u_2fc4c for u_9f3k2"
            trail={link('See why')}
          />
          <LogLine
            time={at('06:06:11.004')}
            level="info"
            source="tasks"
            message="Dispatching task 7f2… to sendWelcome"
            repeat={12}
          />
        </Lines>
      </Section>
      <Section
        title="Expanded"
        note="→ opens a line: the whole message, wrapped, its later lines fainter, and the payload under it."
      >
        <Lines>
          <LogLine
            time={at('06:06:10.002')}
            level="error"
            source="fails"
            expanded
            message={
              "TypeError: cannot read 'id' of undefined\n    at handler (/functions/index.js:41:18)\n    at Layer.handle [as handle_request] (express/lib/router/layer.js:95:5)"
            }
          />
          <LogLine
            time={at('06:06:10.950')}
            level="warn"
            source="firestore"
            expanded
            message="Rules denied list on users for u_9f3k2"
            trail={
              <>
                <Caret open />
                {link('Open collection')}
              </>
            }
            detail={
              <pre className="font-mono text-[12px] leading-5 text-kumo-default">
                {
                  'method   : "list"\npath     : "users"\nuid      : "u_9f3k2"\ndatabase : "(default)"'
                }
              </pre>
            }
          />
        </Lines>
      </Section>
      <Section
        title="An invocation's lines"
        note="Offsets into the invocation instead of the clock; no source column; wrapped, never cut."
      >
        <Lines>
          <LogLine
            time={at('06:06:09.117')}
            timeText="+0 ms"
            level="info"
            wrap
            message='Beginning execution of "us-central1-checkout"'
          />
          <LogLine
            time={at('06:06:09.129')}
            timeText="+12 ms"
            level="info"
            wrap
            message="loading cart c_19 for u_9f3k2"
          />
          <LogLine
            time={at('06:06:09.140')}
            timeText="+23 ms"
            level="warn"
            wrap
            message="price list is 3 days old; using it anyway"
          />
          <LogLine
            time={at('06:06:09.402')}
            timeText="+285 ms"
            level="info"
            wrap
            dim
            message="after it returned: flushed 2 metrics"
          />
        </Lines>
        <Text variant="secondary" size="sm">
          A dim line is quieter than the rest: here, one printed after the invocation returned.
        </Text>
      </Section>
    </Stack>
  )
}

defineCards([
  {
    id: 'log-lines',
    group: 'Components',
    name: 'Log lines',
    subtitle:
      'Rows by level with their rails, source chips, more lines and groups, the cursor row, expanded lines, offsets',
    width: 1100,
    surface: 'canvas',
    render: () => <LogLinesCard />,
  },
  {
    id: 'log-lines-dark',
    group: 'Components',
    name: 'Log lines, dark',
    subtitle: 'The same, in dark mode',
    width: 1100,
    dark: true,
    surface: 'canvas',
    render: () => <LogLinesCard />,
  },
])
