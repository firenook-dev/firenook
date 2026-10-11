import { InlineCopyText, Text } from '@firenook/kit'

/** Borderless copy for ids inside dense rows; the icon appears on hover, or when the enclosing row is hovered. */
export function Ids() {
  return (
    <div className="grid gap-2">
      <Text>
        Document{' '}
        <InlineCopyText value="u_9f3k2" className="font-mono text-[0.9em]">
          u_9f3k2
        </InlineCopyText>
      </Text>
      <Text>
        Auth at{' '}
        <InlineCopyText value="127.0.0.1:9099" className="font-mono text-[0.9em]">
          127.0.0.1:9099
        </InlineCopyText>
      </Text>
    </div>
  )
}
