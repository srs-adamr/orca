import { writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { runGitWorktreeRefreshBenchmark } from './git-worktree-refresh-benchmark'
import { renderReport } from './non-terminal-performance-report'
import { runPersistencePayloadBenchmark } from './persistence-payload-benchmark'
import { runSidebarRowProjectionBenchmark } from './sidebar-row-projection-benchmark'
import { runWorktreeRefreshFanoutBenchmark } from './worktree-refresh-fanout-benchmark'
import { runWorkspaceSpaceBenchmark } from './workspace-space-scan-benchmark'

const REPORT_PATH = 'NON_TERMINAL_PERFORMANCE_INVESTIGATION.md'

describe('non-terminal performance benchmarks', () => {
  it('measures non-browser sidebar, git, persistence, and resource-manager paths', async () => {
    const sidebarResults = runSidebarRowProjectionBenchmark()
    const gitResults = await runGitWorktreeRefreshBenchmark()
    const worktreeFanoutResults = runWorktreeRefreshFanoutBenchmark()
    const persistenceResults = await runPersistencePayloadBenchmark()
    const workspaceSpaceResults = await runWorkspaceSpaceBenchmark()

    await writeFile(
      REPORT_PATH,
      renderReport({
        sidebarResults,
        gitResults,
        worktreeFanoutResults,
        persistenceResults,
        workspaceSpaceResults
      })
    )
    console.info(`Wrote ${REPORT_PATH}`)
    expect(sidebarResults.length).toBeGreaterThan(0)
    expect(gitResults.length).toBeGreaterThan(0)
    expect(worktreeFanoutResults.length).toBeGreaterThan(0)
    expect(persistenceResults.patchResults.length).toBeGreaterThan(0)
    expect(workspaceSpaceResults.scanResults.length).toBeGreaterThan(0)
  }, 240_000)
})
