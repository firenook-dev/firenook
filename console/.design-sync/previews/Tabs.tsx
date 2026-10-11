import { Tabs } from '@firenook/kit'

/** Segmented tabs switch view modes inside a panel. */
export function Segmented() {
  return (
    <div className="flex flex-wrap items-center gap-6">
      <Tabs
        variant="segmented"
        tabs={[
          { value: 'table', label: 'Table' },
          { value: 'json', label: 'JSON' },
          { value: 'requests', label: 'Requests' },
        ]}
        selectedValue="table"
      />
      <Tabs
        variant="segmented"
        size="sm"
        tabs={[
          { value: 'form', label: 'Form' },
          { value: 'text', label: 'Text' },
        ]}
        selectedValue="form"
      />
    </div>
  )
}

/** Underline tabs divide a page into sections. */
export function Underline() {
  return (
    <Tabs
      variant="underline"
      tabs={[
        { value: 'users', label: 'Users' },
        { value: 'inbox', label: 'Inbox' },
        { value: 'signins', label: 'Sign-ins' },
        { value: 'providers', label: 'Providers' },
        { value: 'tenants', label: 'Tenants' },
      ]}
      selectedValue="users"
    />
  )
}
