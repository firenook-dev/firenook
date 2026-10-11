import { Collapsible, Link } from '@firenook/kit'

/** Disclosure for secondary detail, such as a document's subcollections. */
export function Open() {
  return (
    <div className="w-80">
      <Collapsible.Root defaultOpen>
        <Collapsible.DefaultTrigger>Subcollections (2)</Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <div className="grid gap-1">
            <Link href="#" className="font-mono text-[0.9em]">
              orders · 33
            </Link>
            <Link href="#" className="font-mono text-[0.9em]">
              sessions · 8
            </Link>
          </div>
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
    </div>
  )
}

export function Closed() {
  return (
    <div className="w-80">
      <Collapsible.Root defaultOpen={false}>
        <Collapsible.DefaultTrigger>Advanced options</Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>Hidden until opened.</Collapsible.DefaultPanel>
      </Collapsible.Root>
    </div>
  )
}
