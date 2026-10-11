import { Badge } from '@firenook/kit'
import { InfoIcon, WarningCircleIcon } from '@phosphor-icons/react'

/** Filled badges label; dot badges name a state the reader checks at a glance. */
export function Semantic() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="primary">primary</Badge>
      <Badge variant="secondary">secondary</Badge>
      <Badge variant="info">info</Badge>
      <Badge variant="success">success</Badge>
      <Badge variant="warning">warning</Badge>
      <Badge variant="error">error</Badge>
      <Badge variant="outline">outline</Badge>
      <Badge variant="beta">beta</Badge>
    </div>
  )
}

export function Status() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="success" appearance="dot">
        listening
      </Badge>
      <Badge variant="neutral" appearance="dot">
        not running
      </Badge>
      <Badge variant="warning" appearance="dot">
        reloading
      </Badge>
      <Badge variant="error" appearance="dot">
        engine unreachable
      </Badge>
    </div>
  )
}

export function WithIcon() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="info" icon={<InfoIcon />}>
        info
      </Badge>
      <Badge variant="error" icon={<WarningCircleIcon />}>
        denied
      </Badge>
    </div>
  )
}

/** The colour tokens, used for Firestore value types in the grid. */
export function Colours() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="blue">string</Badge>
      <Badge variant="teal">number</Badge>
      <Badge variant="green">boolean</Badge>
      <Badge variant="purple">timestamp</Badge>
      <Badge variant="orange">reference</Badge>
      <Badge variant="neutral">map</Badge>
      <Badge variant="red">null</Badge>
    </div>
  )
}
