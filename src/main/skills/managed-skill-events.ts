import type {
  ManagedAgentSkillEnsureResult,
  ManagedAgentSkillFallback,
  ManagedAgentSkillUpdated
} from '../../shared/skills'
import { shouldEmitManagedAgentSkillFallback } from '../../shared/skills'

export type ManagedSkillEvent =
  | { type: 'fallback'; event: ManagedAgentSkillFallback }
  | { type: 'updated'; event: ManagedAgentSkillUpdated }

const managedSkillEventListeners = new Set<(event: ManagedSkillEvent) => void>()

export function onManagedSkillEvent(listener: (event: ManagedSkillEvent) => void): () => void {
  managedSkillEventListeners.add(listener)
  return () => {
    managedSkillEventListeners.delete(listener)
  }
}

export function publishManagedSkillFallback(result: ManagedAgentSkillEnsureResult): void {
  if (!shouldEmitManagedAgentSkillFallback(result)) {
    return
  }
  publishManagedSkillEvent({ type: 'fallback', event: result })
}

export function publishManagedSkillUpdated(result: ManagedAgentSkillEnsureResult): void {
  if (result.status !== 'updated') {
    return
  }
  publishManagedSkillEvent({ type: 'updated', event: result })
}

function publishManagedSkillEvent(event: ManagedSkillEvent): void {
  for (const listener of managedSkillEventListeners) {
    try {
      listener(event)
    } catch {
      // Why: one broken stream subscriber should not interrupt other skill update listeners.
    }
  }
}
