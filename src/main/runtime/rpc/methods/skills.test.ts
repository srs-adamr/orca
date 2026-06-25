import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest, RpcResponse } from '../core'
import { SKILL_METHODS } from './skills'
import {
  onManagedSkillEvent,
  publishManagedSkillFallback,
  publishManagedSkillUpdated
} from '../../../skills/managed-skill-events'
import type { ManagedAgentSkillFallback, ManagedAgentSkillUpdated } from '../../../../shared/skills'

function makeRequest(method: string): RpcRequest {
  return {
    id: 'req-1',
    authToken: 'token',
    method
  }
}

function makeRuntime(): {
  runtime: {
    getRuntimeId: () => string
    listRepos: () => unknown[]
    registerSubscriptionCleanup: (
      subscriptionId: string,
      cleanup: () => void,
      connectionId?: string
    ) => void
    cleanupSubscription: (subscriptionId: string) => void
  }
  cleanups: Map<string, () => void>
} {
  const cleanups = new Map<string, () => void>()
  return {
    cleanups,
    runtime: {
      getRuntimeId: () => 'runtime-1',
      listRepos: () => [],
      registerSubscriptionCleanup: vi.fn((subscriptionId, cleanup) => {
        cleanups.set(subscriptionId, cleanup)
      }),
      cleanupSubscription: (subscriptionId) => {
        const cleanup = cleanups.get(subscriptionId)
        if (!cleanup) {
          return
        }
        cleanups.delete(subscriptionId)
        cleanup()
      }
    }
  }
}

function parseResponse(raw: string): RpcResponse {
  return JSON.parse(raw) as RpcResponse
}

describe('skills runtime RPC methods', () => {
  it('streams managed skill events from the main-process event bus', async () => {
    const { runtime, cleanups } = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime: runtime as never, methods: SKILL_METHODS })
    const responses: RpcResponse[] = []

    const dispatch = dispatcher.dispatchStreaming(
      makeRequest('skills.managedEvents'),
      (response) => {
        responses.push(parseResponse(response))
      },
      { connectionId: 'conn-1' }
    )

    await vi.waitFor(() => {
      expect(responses[0]).toMatchObject({
        ok: true,
        streaming: true,
        result: { type: 'ready', subscriptionId: expect.stringContaining('conn-1') }
      })
    })

    const fallbackEvent = {
      status: 'fallback',
      skillName: 'orca-linear',
      context: 'linear-worktree',
      runtime: 'host',
      scope: 'missing',
      reason: 'missing-install',
      uiKey: 'host::orca-linear:linear-worktree',
      message: 'Install orca-linear.',
      request: { skillName: 'orca-linear', context: 'linear-worktree' }
    } satisfies ManagedAgentSkillFallback
    const updatedEvent = {
      status: 'updated',
      skillName: 'orchestration',
      context: 'agent-orchestration',
      runtime: 'host',
      scope: 'global'
    } satisfies ManagedAgentSkillUpdated

    publishManagedSkillFallback(fallbackEvent)
    publishManagedSkillUpdated(updatedEvent)

    expect(responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          streaming: true,
          result: { type: 'fallback', event: fallbackEvent }
        }),
        expect.objectContaining({
          ok: true,
          streaming: true,
          result: { type: 'updated', event: updatedEvent }
        })
      ])
    )

    const ready = responses[0]
    const subscriptionId =
      ready.ok && typeof ready.result === 'object' && ready.result
        ? (ready.result as { subscriptionId?: string }).subscriptionId
        : undefined
    expect(subscriptionId).toBeTruthy()
    runtime.cleanupSubscription(subscriptionId!)
    await dispatch

    expect(cleanups.size).toBe(0)
    expect(responses.at(-1)).toMatchObject({
      ok: true,
      streaming: true,
      result: { type: 'end' }
    })
  })

  it('continues publishing managed skill events when one listener throws', () => {
    const received: unknown[] = []
    const unsubscribeThrowing = onManagedSkillEvent(() => {
      throw new Error('listener failed')
    })
    const unsubscribeReceiving = onManagedSkillEvent((event) => {
      received.push(event)
    })
    const fallbackEvent = {
      status: 'fallback',
      skillName: 'orca-linear',
      context: 'linear-worktree',
      runtime: 'host',
      scope: 'missing',
      reason: 'missing-install',
      uiKey: 'host::orca-linear:linear-worktree',
      message: 'Install orca-linear.',
      request: { skillName: 'orca-linear', context: 'linear-worktree' }
    } satisfies ManagedAgentSkillFallback

    try {
      publishManagedSkillFallback(fallbackEvent)
    } finally {
      unsubscribeThrowing()
      unsubscribeReceiving()
    }

    expect(received).toEqual([{ type: 'fallback', event: fallbackEvent }])
  })
})
