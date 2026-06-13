import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

// Why: Sonner's native action sits beside the description and pinches multi-line
// copy; this keeps the CTA in a full-width footer below the text.
export function LinearAgentSkillSetupReminderToastBody({
  description,
  onOpen
}: {
  description: string
  onOpen: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-snug text-popover-foreground/80">{description}</p>
      <div className="flex justify-end">
        <Button size="sm" onClick={onOpen}>
          {translate(
            'auto.components.sidebar.LinearAgentSkillSetupPrompt.openSetup',
            'Set up Linear access'
          )}
        </Button>
      </div>
    </div>
  )
}
