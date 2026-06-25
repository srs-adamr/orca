import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import type { ManagedAgentSkillName } from '../../shared/skills'

export type ManagedSkillUpdateRunnerResult =
  | { status: 'success' }
  | { status: 'failure'; exitCode?: number | null; error?: string }
  | { status: 'timeout' }

export type ManagedSkillUpdateRunner = (
  skillName: ManagedAgentSkillName
) => Promise<ManagedSkillUpdateRunnerResult>

const DEFAULT_UPDATE_TIMEOUT_MS = 120_000

export function buildManagedSkillUpdateCommand(skillName: ManagedAgentSkillName): {
  executable: string
  args: string[]
} {
  return {
    executable: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['--yes', 'skills', 'update', skillName, '--global', '--yes']
  }
}

export function createManagedSkillUpdateRunner(
  args: {
    cwd?: string
    signal?: AbortSignal
    timeoutMs?: number
  } = {}
): ManagedSkillUpdateRunner {
  const timeoutMs = args.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS
  const cwd = args.cwd ?? homedir()
  return (skillName) => runManagedSkillUpdate(skillName, timeoutMs, cwd, args.signal)
}

async function runManagedSkillUpdate(
  skillName: ManagedAgentSkillName,
  timeoutMs: number,
  cwd: string,
  signal: AbortSignal | undefined
): Promise<ManagedSkillUpdateRunnerResult> {
  if (signal?.aborted) {
    return { status: 'failure', error: 'aborted' }
  }

  const command = buildManagedSkillUpdateCommand(skillName)
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(command.executable, command.args, {
      cwd,
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    })
    const killChildTree = (): void => {
      killSpawnedCommandTree(child)
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (result: ManagedSkillUpdateRunnerResult): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(result)
    }
    const onAbort = (): void => {
      killChildTree()
      finish({ status: 'failure', error: 'aborted' })
    }
    const timeout = setTimeout(() => {
      killChildTree()
      finish({ status: 'timeout' })
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })

    child.once('error', (error) => {
      finish({ status: 'failure', error: error.message })
    })
    child.once('close', (exitCode) => {
      finish(exitCode === 0 ? { status: 'success' } : { status: 'failure', exitCode })
    })
  })
}

function killSpawnedCommandTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid || process.platform !== 'win32') {
    child.kill()
    return
  }
  try {
    // Why: `npx.cmd` can leave its node/npm child alive if only cmd.exe is killed.
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    killer.on('error', () => child.kill())
    killer.unref()
  } catch {
    child.kill()
  }
}
