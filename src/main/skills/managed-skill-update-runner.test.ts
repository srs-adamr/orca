import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_SKILL_NAME } from '../../shared/agent-feature-install-commands'
import { homeDiscovery, lockfile, orchestrationRequest } from './managed-skill-test-fixtures'
import { createManagedSkillUpdateRunner } from './managed-skill-update-runner'
import {
  abortManagedSkillUpdateProcesses,
  ManagedSkillUpdateCoordinator
} from './managed-skill-updates'

vi.mock('node:child_process', () => ({
  spawn: vi.fn()
}))

class FakeChildProcess extends EventEmitter {
  readonly kill = vi.fn()
  readonly unref = vi.fn()

  constructor(readonly pid?: number) {
    super()
  }
}

const TEST_ALICE_HOME = join(sep, 'home', 'alice')

describe('createManagedSkillUpdateRunner', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(spawn).mockReset()
  })

  it('resolves timeout without waiting for the child close event', async () => {
    vi.useFakeTimers()
    const child = new FakeChildProcess()
    vi.mocked(spawn).mockReturnValue(child as never)
    const runner = createManagedSkillUpdateRunner({ timeoutMs: 50 })

    const resultPromise = runner(ORCHESTRATION_SKILL_NAME)
    await vi.advanceTimersByTimeAsync(50)

    await expect(resultPromise).resolves.toEqual({ status: 'timeout' })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('kills the process when the shutdown signal aborts', async () => {
    const child = new FakeChildProcess()
    vi.mocked(spawn).mockReturnValue(child as never)
    const controller = new AbortController()
    const runner = createManagedSkillUpdateRunner({ signal: controller.signal, timeoutMs: 1_000 })

    const resultPromise = runner(ORCHESTRATION_SKILL_NAME)
    controller.abort()

    await expect(resultPromise).resolves.toEqual({ status: 'failure', error: 'aborted' })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('does not spawn when the shutdown signal already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const runner = createManagedSkillUpdateRunner({ signal: controller.signal, timeoutMs: 1_000 })

    await expect(runner(ORCHESTRATION_SKILL_NAME)).resolves.toEqual({
      status: 'failure',
      error: 'aborted'
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('spawns the single-skill global update command without a shell from a neutral cwd', async () => {
    const child = new FakeChildProcess()
    vi.mocked(spawn).mockReturnValue(child as never)
    const runner = createManagedSkillUpdateRunner({ cwd: TEST_ALICE_HOME, timeoutMs: 1_000 })

    const resultPromise = runner(ORCHESTRATION_SKILL_NAME)
    child.emit('close', 0)

    await expect(resultPromise).resolves.toEqual({ status: 'success' })
    expect(spawn).toHaveBeenCalledWith(
      'npx',
      ['--yes', 'skills', 'update', 'orchestration', '--global', '--yes'],
      {
        cwd: TEST_ALICE_HOME,
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      }
    )
  })

  it('uses taskkill for Windows process-tree cleanup on timeout', async () => {
    vi.useFakeTimers()
    const child = new FakeChildProcess(123)
    const killer = new FakeChildProcess()
    vi.mocked(spawn)
      .mockReturnValueOnce(child as never)
      .mockReturnValueOnce(killer as never)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const runner = createManagedSkillUpdateRunner({ timeoutMs: 50 })

    const resultPromise = runner(ORCHESTRATION_SKILL_NAME)
    await vi.advanceTimersByTimeAsync(50)

    await expect(resultPromise).resolves.toEqual({ status: 'timeout' })
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      'taskkill',
      ['/pid', '123', '/t', '/f'],
      expect.objectContaining({ stdio: 'ignore', windowsHide: true })
    )
    expect(killer.unref).toHaveBeenCalledTimes(1)
    platform.mockRestore()
  })

  it('allows future default coordinators to update after aborting current update processes', async () => {
    const child = new FakeChildProcess()
    vi.mocked(spawn).mockReturnValue(child as never)
    abortManagedSkillUpdateProcesses()
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      discoverHostSkills: async () => homeDiscovery(),
      readTextFile: async () => lockfile(ORCHESTRATION_SKILL_NAME, 'same-hash')
    })

    const resultPromise = coordinator.ensureManagedReady(orchestrationRequest)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    child.emit('close', 0)

    await expect(resultPromise).resolves.toMatchObject({
      status: 'ready',
      skillName: ORCHESTRATION_SKILL_NAME,
      context: 'agent-orchestration'
    })
  })
})
