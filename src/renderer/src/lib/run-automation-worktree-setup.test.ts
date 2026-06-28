import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.fn()
const mockCreateTab = vi.fn()
const mockSetTabCustomTitle = vi.fn()
const mockSetTabLayout = vi.fn()
const mockUpdateTabPtyId = vi.fn()
const mockClearTabPtyId = vi.fn()
const mockRegisterEagerPtyBuffer = vi.fn()
const mockSubscribeToPtyExit = vi.fn()

const state = {
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
  worktrees: [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/worktree', displayName: 'main' }],
  allWorktrees: vi.fn(() => state.worktrees),
  createTab: mockCreateTab,
  setTabCustomTitle: mockSetTabCustomTitle,
  setTabLayout: mockSetTabLayout,
  updateTabPtyId: mockUpdateTabPtyId,
  clearTabPtyId: mockClearTabPtyId,
  settings: {}
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/setup-runner', () => ({
  buildSetupRunnerCommand: (path: string) => `bash ${path}`
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: mockRegisterEagerPtyBuffer,
  subscribeToPtyExit: mockSubscribeToPtyExit
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' }),
  callRuntimeRpc: vi.fn()
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getSettingsForWorktreeRuntimeOwner: () => ({})
}))
vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (id: string) => ({ id })
}))
vi.mock('@/runtime/runtime-terminal-stream', () => ({
  getRemoteRuntimeTerminalHandle: vi.fn(),
  toRemoteRuntimePtyId: vi.fn()
}))
vi.mock('@/store/slices/terminal-helpers', () => ({
  singlePaneLayoutSnapshot: (leafId: string, ptyId?: string) => ({ leafId, ptyId })
}))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'leaf-1' }))

/** Let queued microtasks and the awaited spawn callbacks settle before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('runAutomationWorktreeSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
    state.worktrees = [
      { id: 'wt-1', repoId: 'repo-1', path: '/repo/worktree', displayName: 'main' }
    ]
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
    mockSpawn.mockResolvedValue({ id: 'pty-1' })
    mockSubscribeToPtyExit.mockReturnValue(vi.fn())
    vi.stubGlobal('window', { api: { pty: { spawn: mockSpawn } } })
  })

  it('spawns the setup runner in a "Setup" tab and waits for its exit before resolving', async () => {
    let exitWatcher: ((code: number) => void) | undefined
    mockSubscribeToPtyExit.mockImplementation((_id, cb) => {
      exitWatcher = cb
      return vi.fn()
    })
    const { runAutomationWorktreeSetup } = await import('./run-automation-worktree-setup')

    let resolved = false
    const promise = runAutomationWorktreeSetup(
      { runnerScriptPath: '/repo/worktree/.orca/setup.sh', envVars: { FOO: 'bar' } },
      'wt-1'
    ).then(() => {
      resolved = true
    })
    await flush()

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      activate: false,
      recordInteraction: false
    })
    expect(mockSetTabCustomTitle).toHaveBeenCalledWith('tab-1', 'Setup', {
      recordInteraction: false
    })
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo/worktree',
        command: 'bash /repo/worktree/.orca/setup.sh',
        env: { FOO: 'bar' },
        connectionId: null,
        worktreeId: 'wt-1',
        tabId: 'tab-1'
      })
    )
    // The agent must not launch until setup finishes: still pending here.
    expect(resolved).toBe(false)

    exitWatcher?.(0)
    await promise
    expect(resolved).toBe(true)
    expect(mockClearTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-1')
  })

  it('routes the spawn through the SSH connection for a remote worktree', async () => {
    state.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
    mockSubscribeToPtyExit.mockImplementation((_id, cb) => {
      cb(0)
      return vi.fn()
    })
    const { runAutomationWorktreeSetup } = await import('./run-automation-worktree-setup')

    await runAutomationWorktreeSetup(
      { runnerScriptPath: '/repo/worktree/.orca/setup.sh', envVars: {} },
      'wt-1'
    )

    expect(mockSpawn).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'ssh-1' }))
  })

  it('resolves (best-effort) when the setup spawn fails', async () => {
    mockSpawn.mockRejectedValue(new Error('spawn failed'))
    const { runAutomationWorktreeSetup } = await import('./run-automation-worktree-setup')

    await expect(
      runAutomationWorktreeSetup(
        { runnerScriptPath: '/repo/worktree/.orca/setup.sh', envVars: {} },
        'wt-1'
      )
    ).resolves.toBeUndefined()
  })

  it('does nothing when the worktree has no local path', async () => {
    state.worktrees = [{ id: 'wt-1', repoId: 'repo-1', path: '', displayName: 'main' }]
    const { runAutomationWorktreeSetup } = await import('./run-automation-worktree-setup')

    await runAutomationWorktreeSetup({ runnerScriptPath: '/x/setup.sh', envVars: {} }, 'wt-1')

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
  })
})
