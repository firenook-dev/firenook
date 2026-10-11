import { Radio } from '@firenook/kit'

export function Vertical() {
  return (
    <Radio.Group legend="Durability" defaultValue="write-behind">
      <Radio.Item label="Write-behind (default)" value="write-behind" />
      <Radio.Item label="Per commit" value="per-commit" />
    </Radio.Group>
  )
}

export function Horizontal() {
  return (
    <Radio.Group legend="Order" orientation="horizontal" defaultValue="asc">
      <Radio.Item label="Ascending" value="asc" />
      <Radio.Item label="Descending" value="desc" />
    </Radio.Group>
  )
}
