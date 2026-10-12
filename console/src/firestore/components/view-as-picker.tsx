// Who the workbench reads as. The engine evaluates rules for the chosen
// identity on every read, so a denial here is the denial the app would get,
// with the decision behind it on the rules page. The picker is the console's
// one identity picker; Firestore keeps its test id.

import { IdentityPicker } from '@/components/console/identity-picker'
import { useWorkbench } from './workbench-context'

export function ViewAsPicker() {
  const workbench = useWorkbench()
  return (
    <IdentityPicker
      project={workbench.project}
      value={workbench.viewAs}
      onChange={workbench.setViewAs}
      testId="view-as"
    />
  )
}
