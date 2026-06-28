import { useAppStore } from '@/store'
import { buildSetupRunnerCommand } from '@/lib/setup-runner'
import {
  registerEagerPtyBuffer,
  subscribeToPtyExit
} from '@/components/terminal-pane/pty-dispatcher'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  getRemoteRuntimeTerminalHandle,
  toRemoteRuntimePtyId
} from '@/runtime/runtime-terminal-stream'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import type { WorktreeSetupLaunch } from '../../../shared/types'

// Why: a broken or hung setup script must never strand a scheduled run forever.
// After this cap we proceed to launch the agent anyway (degraded but unblocked).
const SETUP_MAX_WAIT_MS = 10 * 60 * 1000

// The fixed tab label, matching the "Setup" tab manual creation spawns.
const SETUP_TAB_TITLE = 'Setup'

/**
 * Run a freshly-created worktree's setup runner to completion before a background
 * automation launches its agent, so gitignored config/skills/.env exist first
 * (issue #5918). Background automations never reveal the workspace, so the
 * mount-driven Setup tab manual creation relies on never spawns its PTY — we
 * spawn the runner eagerly and await its exit, mirroring the routing in
 * launchAgentBackgroundSession. Best-effort: any failure resolves rather than
 * rejecting, since the worktree already exists on disk.
 */
export async function runAutomationWorktreeSetup(
  setup: WorktreeSetupLaunch,
  worktreeId: string
): Promise<void> {
  const store = useAppStore.getState()
  const worktree = store.allWorktrees().find((entry) => entry.id === worktreeId)
  if (!worktree?.path) {
    return
  }
  const repo = store.repos.find((entry) => entry.id === worktree.repoId)
  const command = buildSetupRunnerCommand(setup.runnerScriptPath)

  // A dedicated inactive "Setup" tab keeps the run visible if the user later
  // opens the workspace, matching manual creation's convention.
  const tab = store.createTab(worktreeId, undefined, undefined, {
    activate: false,
    recordInteraction: false
  })
  store.setTabCustomTitle(tab.id, SETUP_TAB_TITLE, { recordInteraction: false })
  const leafId = createBrowserUuid()
  store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId))

  // Route by the worktree's owner host so setup runs where the worktree lives,
  // not on the focused runtime — the same rule launchAgentBackgroundSession uses.
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(store, worktreeId)
  )

  try {
    if (runtimeTarget.kind === 'environment') {
      // Why: runtime environments execute on the server; a local pty.spawn would
      // silently run setup on the client for a remote workspace.
      const created = await callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
        runtimeTarget,
        'terminal.create',
        {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          command,
          env: setup.envVars,
          title: SETUP_TAB_TITLE,
          tabId: tab.id,
          leafId,
          focus: false
        },
        { timeoutMs: 15_000 }
      )
      const ptyId = toRemoteRuntimePtyId(created.terminal.handle, runtimeTarget.environmentId)
      store.updateTabPtyId(tab.id, ptyId)
      store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId, ptyId))
      const terminal = getRemoteRuntimeTerminalHandle(ptyId)
      if (!terminal) {
        return
      }
      await callRuntimeRpc<{ wait: { exitCode?: number | null } }>(
        runtimeTarget,
        'terminal.wait',
        { terminal, for: 'exit' },
        { timeoutMs: SETUP_MAX_WAIT_MS }
      )
    } else {
      const result = await window.api.pty.spawn({
        cols: 120,
        rows: 40,
        cwd: worktree.path,
        command,
        env: setup.envVars,
        connectionId: repo?.connectionId ?? null,
        worktreeId,
        tabId: tab.id,
        leafId
      })
      const ptyId = result.id
      store.updateTabPtyId(tab.id, ptyId)
      store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId, ptyId))
      await raceSetupTimeout(waitForSetupPtyExit(tab.id, ptyId))
    }
  } catch (error) {
    // Best-effort: keep the run going even if setup couldn't be spawned/awaited.
    console.error('Automation worktree setup failed to run before agent launch', error)
  }
}

/**
 * Resolve when the setup PTY exits. The eager buffer catches the exit while the
 * Setup tab stays hidden; the sidecar keeps tracking alive if its pane later
 * mounts. Mirrors launchAgentBackgroundSession's exit handling.
 */
function waitForSetupPtyExit(tabId: string, ptyId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    let unsubscribeExit = (): void => {}
    /** Dedupe the eager-buffer and sidecar exit signals into a single resolve. */
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      unsubscribeExit()
      useAppStore.getState().clearTabPtyId(tabId, ptyId)
      resolve()
    }
    registerEagerPtyBuffer(ptyId, () => finish())
    unsubscribeExit = subscribeToPtyExit(ptyId, () => finish())
  })
}

/**
 * Resolve when `promise` settles or the setup cap elapses, whichever comes
 * first, clearing the pending timer so it never dangles.
 */
function raceSetupTimeout(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SETUP_MAX_WAIT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
