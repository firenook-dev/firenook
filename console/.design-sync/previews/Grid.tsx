import { Grid, LayerCard, Text } from '@firenook/kit'

/** Preset column layouts that collapse on narrow widths. */
export function ThreeUp() {
  return (
    <Grid variant="3up" gap="base">
      {['Firestore', 'Authentication', 'Storage'].map((name) => (
        <LayerCard key={name} className="px-5 py-4">
          <Text bold>{name}</Text>
          <Text variant="secondary">running</Text>
        </LayerCard>
      ))}
    </Grid>
  )
}

export function SideBySide() {
  return (
    <Grid variant="2-1" gap="base">
      <LayerCard className="px-5 py-4">
        <Text bold>Documents</Text>
      </LayerCard>
      <LayerCard className="px-5 py-4">
        <Text bold>Inspector</Text>
      </LayerCard>
    </Grid>
  )
}
