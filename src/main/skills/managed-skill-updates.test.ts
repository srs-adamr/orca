import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_SKILL_NAME } from '../../shared/agent-feature-install-commands'
import {
  TEST_OTHER_WORKSPACE_ROOT,
  homeDiscovery,
  lockfile,
  orchestrationRequest
} from './managed-skill-test-fixtures'
import { ManagedSkillUpdateCoordinator } from './managed-skill-updates'

describe('ManagedSkillUpdateCoordinator', () => {
  it('runs one verified update and returns updated when the post-update lock hash changes', async () => {
    const updateRunner = vi.fn(async () => ({ status: 'success' as const }))
    const readTextFile = vi
      .fn()
      .mockResolvedValueOnce(lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'))
      .mockResolvedValueOnce(lockfile(ORCHESTRATION_SKILL_NAME, 'new-hash'))
    const discoverHostSkills = vi.fn(async () => homeDiscovery())
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      appVersion: '1.0.0',
      discoverHostSkills,
      readTextFile,
      updateRunner
    })

    const result = await coordinator.ensureManagedReady(orchestrationRequest)

    expect(result.status).toBe('updated')
    expect(updateRunner).toHaveBeenCalledWith(ORCHESTRATION_SKILL_NAME)
    expect(updateRunner).toHaveBeenCalledTimes(1)
    expect(discoverHostSkills).toHaveBeenCalledTimes(2)
    expect(readTextFile).toHaveBeenCalledTimes(2)
  })

  it('returns ready when the verified update succeeds without changing the lock hash', async () => {
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      discoverHostSkills: async () => homeDiscovery(),
      readTextFile: async () => lockfile(ORCHESTRATION_SKILL_NAME, 'same-hash'),
      updateRunner: async () => ({ status: 'success' })
    })

    const result = await coordinator.ensureManagedReady(orchestrationRequest)

    expect(result.status).toBe('ready')
  })

  it('serves a successful post-update hash from cache without repeated subprocess or metadata work', async () => {
    const updateRunner = vi.fn(async () => ({ status: 'success' as const }))
    const discoverHostSkills = vi.fn(async () => homeDiscovery())
    const readTextFile = vi
      .fn()
      .mockResolvedValueOnce(lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'))
      .mockResolvedValueOnce(lockfile(ORCHESTRATION_SKILL_NAME, 'new-hash'))
      .mockResolvedValue(lockfile(ORCHESTRATION_SKILL_NAME, 'new-hash'))
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      appVersion: '1.0.0',
      discoverHostSkills,
      readTextFile,
      updateRunner
    })

    const first = await coordinator.ensureManagedReady(orchestrationRequest)
    const second = await coordinator.ensureManagedReady(orchestrationRequest)

    expect(first.status).toBe('updated')
    expect(second.status).toBe('ready')
    expect(updateRunner).toHaveBeenCalledTimes(1)
    expect(discoverHostSkills).toHaveBeenCalledTimes(2)
    expect(readTextFile).toHaveBeenCalledTimes(2)
  })

  it('keeps repeated sequential ready checks on the pre-discovery fast path', async () => {
    const updateRunner = vi.fn(async () => ({ status: 'success' as const }))
    const discoverHostSkills = vi.fn(async () => homeDiscovery())
    const readTextFile = vi
      .fn()
      .mockResolvedValueOnce(lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'))
      .mockResolvedValueOnce(lockfile(ORCHESTRATION_SKILL_NAME, 'new-hash'))
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      appVersion: '1.0.0',
      discoverHostSkills,
      readTextFile,
      updateRunner
    })

    const first = await coordinator.ensureManagedReady(orchestrationRequest)
    const results = await Promise.all(
      Array.from({ length: 50 }, () => coordinator.ensureManagedReady(orchestrationRequest))
    )

    expect(first.status).toBe('updated')
    expect(results.every((result) => result.status === 'ready')).toBe(true)
    expect(updateRunner).toHaveBeenCalledTimes(1)
    expect(discoverHostSkills).toHaveBeenCalledTimes(2)
    expect(readTextFile).toHaveBeenCalledTimes(2)
  })

  it('reuses a verified global lock hash across workspaces after discovery safety checks', async () => {
    const updateRunner = vi.fn(async () => ({ status: 'success' as const }))
    const discoverHostSkills = vi.fn(async () => homeDiscovery())
    const readTextFile = vi
      .fn()
      .mockResolvedValueOnce(lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'))
      .mockResolvedValueOnce(lockfile(ORCHESTRATION_SKILL_NAME, 'new-hash'))
      .mockResolvedValue(lockfile(ORCHESTRATION_SKILL_NAME, 'new-hash'))
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      appVersion: '1.0.0',
      discoverHostSkills,
      readTextFile,
      updateRunner
    })

    const first = await coordinator.ensureManagedReady(orchestrationRequest)
    const second = await coordinator.ensureManagedReady({
      ...orchestrationRequest,
      discoveryTarget: { runtime: 'host', projectRootPath: TEST_OTHER_WORKSPACE_ROOT }
    })

    expect(first.status).toBe('updated')
    expect(second.status).toBe('ready')
    expect(updateRunner).toHaveBeenCalledTimes(1)
    expect(discoverHostSkills).toHaveBeenCalledTimes(3)
    expect(readTextFile).toHaveBeenCalledTimes(3)
  })

  it('dedupes concurrent automatic update attempts for the same trigger', async () => {
    let releaseRunner: (() => void) | undefined
    const updateRunner = vi.fn(
      () =>
        new Promise<{ status: 'success' }>((resolve) => {
          releaseRunner = () => resolve({ status: 'success' })
        })
    )
    const readTextFile = vi
      .fn()
      .mockResolvedValueOnce(lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'))
      .mockResolvedValueOnce(lockfile(ORCHESTRATION_SKILL_NAME, 'new-hash'))
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      discoverHostSkills: async () => homeDiscovery(),
      readTextFile,
      updateRunner
    })

    const requests = Array.from({ length: 50 }, () =>
      coordinator.ensureManagedReady(orchestrationRequest)
    )
    await vi.waitFor(() => expect(updateRunner).toHaveBeenCalledTimes(1))
    if (!releaseRunner) {
      throw new Error('runner was not called')
    }
    releaseRunner()
    const results = await Promise.all(requests)

    expect(results.every((result) => result.status === 'updated')).toBe(true)
    expect(updateRunner).toHaveBeenCalledTimes(1)
  })

  it('returns update-failed with the manual update command and then cooldowns automatic retries', async () => {
    let now = 100
    const updateRunner = vi.fn(async () => ({ status: 'failure' as const, exitCode: 1 }))
    const discoverHostSkills = vi.fn(async () => homeDiscovery())
    const readTextFile = vi.fn(async () => lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'))
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      cooldownMs: 1_000,
      now: () => now,
      discoverHostSkills,
      readTextFile,
      updateRunner
    })

    const first = await coordinator.ensureManagedReady(orchestrationRequest)
    now = 200
    const second = await coordinator.ensureManagedReady(orchestrationRequest)
    const repeated = await Promise.all(
      Array.from({ length: 50 }, () => coordinator.ensureManagedReady(orchestrationRequest))
    )

    expect(first.status === 'fallback' ? first.reason : null).toBe('update-failed')
    expect(first.status === 'fallback' ? first.manualCommand?.command : null).toBe(
      'npx --yes skills update orchestration --global --yes'
    )
    expect(second.status === 'fallback' ? second.reason : null).toBe('cooldown')
    expect(repeated.every((result) => result.status === 'fallback')).toBe(true)
    expect(
      repeated.every((result) =>
        result.status === 'fallback' ? result.reason === 'cooldown' : false
      )
    ).toBe(true)
    expect(updateRunner).toHaveBeenCalledTimes(1)
    expect(discoverHostSkills).toHaveBeenCalledTimes(1)
    expect(readTextFile).toHaveBeenCalledTimes(1)
  })

  it('lets explicit re-checks bypass automatic update cooldown', async () => {
    let now = 100
    const updateRunner = vi.fn(async () => ({ status: 'failure' as const, exitCode: 1 }))
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      cooldownMs: 1_000,
      now: () => now,
      discoverHostSkills: async () => homeDiscovery(),
      readTextFile: async () => lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'),
      updateRunner
    })

    await coordinator.ensureManagedReady(orchestrationRequest)
    now = 200
    const forced = await coordinator.ensureManagedReady({ ...orchestrationRequest, force: true })

    expect(forced.status === 'fallback' ? forced.reason : null).toBe('update-failed')
    expect(updateRunner).toHaveBeenCalledTimes(2)
  })

  it('returns update-timeout distinctly with the manual update command', async () => {
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      discoverHostSkills: async () => homeDiscovery(),
      readTextFile: async () => lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'),
      updateRunner: async () => ({ status: 'timeout' })
    })

    const result = await coordinator.ensureManagedReady(orchestrationRequest)

    expect(result.status === 'fallback' ? result.reason : null).toBe('update-timeout')
    expect(result.status === 'fallback' ? result.manualCommand?.kind : null).toBe('update')
  })

  it('falls back to manual update every time by default', async () => {
    const updateRunner = vi.fn(async () => ({ status: 'success' as const }))
    const discoverHostSkills = vi.fn(async () => homeDiscovery())
    const readTextFile = vi.fn(async () => lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'))
    const coordinator = new ManagedSkillUpdateCoordinator({
      cooldownMs: 1_000,
      discoverHostSkills,
      readTextFile,
      updateRunner
    })

    const first = await coordinator.ensureManagedReady(orchestrationRequest)
    const second = await coordinator.ensureManagedReady(orchestrationRequest)
    const repeated = await Promise.all(
      Array.from({ length: 50 }, () => coordinator.ensureManagedReady(orchestrationRequest))
    )

    expect(first.status === 'fallback' ? first.reason : null).toBe('background-update-disabled')
    expect(first.status === 'fallback' ? first.manualCommand?.kind : null).toBe('update')
    expect(second.status === 'fallback' ? second.reason : null).toBe('background-update-disabled')
    expect(second.status === 'fallback' ? second.manualCommand?.kind : null).toBe('update')
    expect(
      repeated.every((result) =>
        result.status === 'fallback' ? result.reason === 'background-update-disabled' : false
      )
    ).toBe(true)
    expect(updateRunner).not.toHaveBeenCalled()
    expect(discoverHostSkills).toHaveBeenCalledTimes(1)
    expect(readTextFile).toHaveBeenCalledTimes(1)
  })

  it('lets explicit re-checks bypass the disabled automatic update fast path', async () => {
    const updateRunner = vi.fn(async () => ({ status: 'success' as const }))
    const discoverHostSkills = vi.fn(async () => homeDiscovery())
    const readTextFile = vi.fn(async () => lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'))
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => false,
      discoverHostSkills,
      readTextFile,
      updateRunner
    })

    await coordinator.ensureManagedReady(orchestrationRequest)
    const forced = await coordinator.ensureManagedReady({ ...orchestrationRequest, force: true })

    expect(forced.status === 'fallback' ? forced.reason : null).toBe('background-update-disabled')
    expect(updateRunner).not.toHaveBeenCalled()
    expect(discoverHostSkills).toHaveBeenCalledTimes(2)
    expect(readTextFile).toHaveBeenCalledTimes(2)
  })

  it('returns update-failed when post-update verification cannot prove the lock entry', async () => {
    const readTextFile = vi
      .fn()
      .mockResolvedValueOnce(lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'))
      .mockResolvedValueOnce(JSON.stringify({ version: 3, skills: {} }))
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      discoverHostSkills: async () => homeDiscovery(),
      readTextFile,
      updateRunner: async () => ({ status: 'success' })
    })

    const result = await coordinator.ensureManagedReady(orchestrationRequest)

    expect(result.status === 'fallback' ? result.reason : null).toBe('update-failed')
    expect(result.status === 'fallback' ? result.manualCommand?.kind : null).toBe('update')
  })

  it('does not run the updater for missing or unmanaged lockfile cases', async () => {
    const updateRunner = vi.fn(async () => ({ status: 'success' as const }))
    const coordinator = new ManagedSkillUpdateCoordinator({
      discoverHostSkills: async () => homeDiscovery(),
      readTextFile: async () => JSON.stringify({ version: 3, skills: {} }),
      updateRunner
    })

    const result = await coordinator.ensureManagedReady(orchestrationRequest)

    expect(result.status === 'fallback' ? result.reason : null).toBe('lock-entry-missing')
    expect(result.status === 'fallback' ? result.manualCommand : undefined).toBeUndefined()
    expect(updateRunner).not.toHaveBeenCalled()
  })
})
