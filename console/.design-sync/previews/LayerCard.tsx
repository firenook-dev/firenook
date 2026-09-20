import { Badge, Button, LayerCard, Text } from '@firenook/kit'
import { ArrowRightIcon } from '@phosphor-icons/react'

/** The one container. A secondary strip for a header, primary for the body. Never nest one inside another. */
export function HeaderAndBody() {
  return (
    <LayerCard className="w-72">
      <LayerCard.Secondary className="flex items-center justify-between">
        <Text bold>users</Text>
        <Badge variant="neutral">211,260</Badge>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <Text variant="secondary">Last write 2 minutes ago by the Admin SDK.</Text>
      </LayerCard.Primary>
    </LayerCard>
  )
}

export function Plain() {
  return (
    <LayerCard className="w-72 px-5 py-4">
      <div className="grid gap-1.5">
        <Text variant="heading" as="h3">
          Rules
        </Text>
        <Text variant="secondary">Reloaded 14:02:11 from firestore.rules</Text>
      </div>
    </LayerCard>
  )
}

export function WithAction() {
  return (
    <LayerCard className="w-72">
      <LayerCard.Secondary className="flex items-center justify-between">
        <Text bold>Next steps</Text>
        <Button variant="ghost" size="sm" shape="square" aria-label="Go to next steps">
          <ArrowRightIcon size={16} />
        </Button>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <Text>Seed the orders collection, then run the checkout journey.</Text>
      </LayerCard.Primary>
    </LayerCard>
  )
}
