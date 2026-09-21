import { Select } from '@firenook/kit'

/** A closed select shows the chosen value; the label is visible when hideLabel is false. */
export function Database() {
  return (
    <div className="grid max-w-xs gap-4">
      <Select
        label="Database"
        hideLabel={false}
        defaultValue="(default)"
        items={{ '(default)': '(default)', analytics: 'analytics', staging: 'staging' }}
      />
      <Select
        label="View as"
        hideLabel={false}
        defaultValue="u_9f3k2"
        items={{
          anonymous: 'Anonymous',
          u_9f3k2: 'ada@example.test',
          admin: 'Admin SDK (bypasses rules)',
        }}
      />
    </div>
  )
}

export function Sizes() {
  return (
    <div className="grid max-w-xs gap-3">
      <Select
        label="Order"
        size="sm"
        defaultValue="desc"
        items={{ asc: 'Ascending', desc: 'Descending' }}
      />
      <Select label="Order" defaultValue="desc" items={{ asc: 'Ascending', desc: 'Descending' }} />
    </div>
  )
}
