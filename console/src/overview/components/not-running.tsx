// Every section this engine does not run, with the engine's own reason and
// the fixes it wrote — the firebase.json lines, or the developer's own
// command line with the name added — each a block to copy exactly as the
// engine wrote it. Sections that one fix turns on share it (Functions,
// Extensions, Eventarc and Cloud Tasks all come back with one `"functions"`
// entry). Answers "why is Storage missing?" with something that works. A
// starting section is not here: its card says what it waits for.

import type { SectionFix } from '@/api/generated/SectionFix'
import { CopyButton } from '@/components/console/copy-button'
import type { AbsentGroup } from '../model'

export function NotRunning({ groups }: { groups: readonly AbsentGroup[] }) {
  if (groups.length === 0) return null
  return (
    <>
      <dt className="pt-px text-[12px] leading-5 text-kumo-subtle">Not running</dt>
      <dd className="grid min-w-0 gap-4" data-testid="overview-not-running">
        {groups.map((group) => (
          <div key={group.sections[0]?.section.id} className="grid min-w-0 gap-2">
            <ul className="grid gap-0.5">
              {group.sections.map(({ section, status, detail }) => (
                <li
                  key={section.id}
                  className="text-[12px] leading-5"
                  data-testid={`overview-absent-${section.id}`}
                  data-reason={status.reason ?? undefined}
                >
                  <span className="font-medium text-kumo-default">{section.label}</span>
                  <span className="text-kumo-subtle"> — {detail}</span>
                </li>
              ))}
            </ul>
            {group.fixes.length > 0 && (
              <div className="grid max-w-[640px] gap-2">
                {group.fixes.map((fix) => (
                  <Fix
                    key={`${fix.kind}:${fix.label}`}
                    fix={fix}
                    testId={`overview-absent-${group.sections[0]?.section.id}-fix-${fix.kind}`}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </dd>
    </>
  )
}

/** One fix: what it is, and the text to copy, in the page's 12 px row scale. */
function Fix({ fix, testId }: { fix: SectionFix; testId: string }) {
  return (
    <div className="grid min-w-0 gap-1" data-testid={testId} data-kind={fix.kind}>
      <span className="text-[12px] text-kumo-subtle">{fix.label}</span>
      <div className="relative min-w-0">
        <pre className="overflow-x-auto rounded-md bg-kumo-control py-2 pr-10 pl-3 font-mono text-[12px] leading-5 text-kumo-default ring ring-kumo-line">
          {fix.text}
        </pre>
        <span className="absolute top-1 right-1">
          <CopyButton
            value={fix.text}
            label={`Copy: ${fix.label}`}
            size="sm"
            testId={`${testId}-copy`}
          />
        </span>
      </div>
    </div>
  )
}
