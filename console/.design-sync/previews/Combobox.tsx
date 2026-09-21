import { Combobox } from '@firenook/kit'

const TENANTS = ['default', 'shop-eu', 'shop-us', 'staging']

/** A filterable choice: the trigger input filters the list as you type. */
export function TriggerInput() {
  return (
    <div className="max-w-xs">
      <Combobox label="Tenant" value="shop-eu" onValueChange={() => {}} items={TENANTS}>
        <Combobox.TriggerInput placeholder="Choose a tenant" />
        <Combobox.Content>
          <Combobox.Empty />
          <Combobox.List>
            {(item: string) => (
              <Combobox.Item key={item} value={item}>
                {item}
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Content>
      </Combobox>
    </div>
  )
}

/** A closed value trigger with the search inside the popup. */
export function TriggerValue() {
  const databases = [
    { value: '(default)', label: '(default)' },
    { value: 'analytics', label: 'analytics' },
    { value: 'staging', label: 'staging' },
  ]
  return (
    <div className="max-w-xs">
      <Combobox label="Database" value={databases[0]} onValueChange={() => {}} items={databases}>
        <Combobox.TriggerValue className="w-[240px]" placeholder="Select a database" />
        <Combobox.Content>
          <Combobox.Input placeholder="Search databases" />
          <Combobox.Empty>No databases found.</Combobox.Empty>
          <Combobox.List>
            {(database: { value: string; label: string }) => (
              <Combobox.Item key={database.value} value={database}>
                {database.label}
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Content>
      </Combobox>
    </div>
  )
}
