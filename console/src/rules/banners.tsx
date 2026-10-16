// The strips under a rules page's toolbar that change what the text on
// screen means, each shown only while it is true: the file on disk does not
// compile, the rules in force moved under the draft, what applying the
// draft would turn around, saved tests the draft breaks. They are the
// foundation's `SectionBanner`; a page adds its own service's (no rules
// loaded, a bucket nobody serves) beside them.

import { Button } from '@cloudflare/kumo'
import type { RulesOutcome } from '@/api/generated/RulesOutcome'
import { SectionBanner } from '@/components/console/section-banner'
import type { RulesDraft } from './draft'

/** The file on disk changed and does not compile; the rules in force are the previous ones. */
export function FileProblemsBanner({
  draft,
  onReveal,
}: {
  draft: RulesDraft
  onReveal: (line: number) => void
}) {
  if (draft.fileProblems.length === 0) return null
  const name = draft.rules.data?.path?.split('/').pop() ?? 'the rules file'
  return (
    <SectionBanner
      tone="danger"
      testId="rules-file-problems"
      action={
        draft.fileSource !== null && (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => {
              if (draft.fileSource !== null) draft.setSource(draft.fileSource)
              const first = draft.fileProblems[0]
              if (first) onReveal(first.line)
            }}
          >
            Open the file to fix it
          </Button>
        )
      }
    >
      {name} changed on disk and does not compile, so the rules in force are the previous ones:{' '}
      {draft.fileProblems
        .map((problem) => `${problem.line}:${problem.column} ${problem.message}`)
        .join('; ')}
    </SectionBanner>
  )
}

/** The rules in force changed while the draft was being written. */
export function OvertakenBanner({ draft }: { draft: RulesDraft }) {
  if (!draft.overtaken) return null
  return (
    <SectionBanner
      tone="warning"
      testId="rules-overtaken"
      action={
        <>
          <Button variant="ghost" size="xs" onClick={draft.revert}>
            Discard my draft
          </Button>
          <Button variant="secondary" size="xs" onClick={draft.rebase}>
            Keep editing mine
          </Button>
        </>
      }
    >
      The rules in force changed while you were editing — saved from somewhere else, or the file
      changed on disk.
    </SectionBanner>
  )
}

/** What applying the draft would turn around among the decisions the engine can re-run. */
export function ImpactBanner({
  impact,
  onShow,
}: {
  impact: { considered: number; flips: ReadonlyArray<{ after: RulesOutcome }> } | undefined
  onShow: () => void
}) {
  if (!impact || impact.flips.length === 0) return null
  const denies = impact.flips.filter((flip) => flip.after !== 'allow').length
  const allows = impact.flips.length - denies
  return (
    <SectionBanner
      tone="warning"
      testId="rules-impact"
      action={
        <Button variant="secondary" size="xs" onClick={onShow}>
          Show them
        </Button>
      }
    >
      Applying this draft would{' '}
      {denies > 0 &&
        `deny ${denies} request${denies === 1 ? '' : 's'} that ${denies === 1 ? 'was' : 'were'} allowed`}
      {denies > 0 && allows > 0 && ' and '}
      {allows > 0 &&
        `allow ${allows} request${allows === 1 ? '' : 's'} that ${allows === 1 ? 'was' : 'were'} denied`}
      , of the {impact.considered} recent requests the engine still holds.
    </SectionBanner>
  )
}

/** Saved tests that fail against the draft. */
export function TestsFailingBanner({
  tests,
  onShow,
}: {
  tests: { total: number; failing: number } | undefined
  onShow: () => void
}) {
  if (!tests || tests.failing === 0) return null
  return (
    <SectionBanner
      tone="warning"
      testId="rules-tests-failing"
      action={
        <Button variant="secondary" size="xs" onClick={onShow}>
          Show the tests
        </Button>
      }
    >
      {tests.failing} of {tests.total} saved test{tests.total === 1 ? '' : 's'}{' '}
      {tests.failing === 1 ? 'fails' : 'fail'} against this draft.
    </SectionBanner>
  )
}
