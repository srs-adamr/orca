import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  ORCA_LINEAR_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
} from '../../shared/agent-feature-install-commands'
import type { ManagedAgentSkillEnsureRequest, ManagedAgentSkillName } from '../../shared/skills'
import {
  TEST_MANAGED_HOME_ROOT,
  TEST_ALICE_HOME,
  TEST_CENTRAL_SKILLS_ROOT,
  TEST_OTHER_WORKSPACE_ROOT,
  TEST_WORKSPACE_AGENT_SKILLS_ROOT,
  discoveredSkill,
  discovery,
  homeDiscovery,
  lockfile,
  orchestrationRequest
} from './managed-skill-test-fixtures'
import { buildManagedSkillUpdateCommand } from './managed-skill-update-runner'
import { ManagedSkillUpdateCoordinator } from './managed-skill-updates'

describe('ManagedSkillUpdateCoordinator safety cases', () => {
  it('does not auto-update project, ambiguous, bundled, plugin, or symlinked installs', async () => {
    const updateRunner = vi.fn(async () => ({ status: 'success' as const }))
    const cases = [
      {
        skills: [
          discoveredSkill({
            name: ORCHESTRATION_SKILL_NAME,
            sourceKind: 'repo',
            rootPath: TEST_WORKSPACE_AGENT_SKILLS_ROOT,
            directoryPath: join(TEST_WORKSPACE_AGENT_SKILLS_ROOT, 'orchestration')
          })
        ],
        reason: 'project-install'
      },
      {
        skills: [
          discoveredSkill({ name: ORCHESTRATION_SKILL_NAME, sourceKind: 'home' }),
          discoveredSkill({
            name: ORCHESTRATION_SKILL_NAME,
            sourceKind: 'repo',
            rootPath: TEST_WORKSPACE_AGENT_SKILLS_ROOT,
            directoryPath: join(TEST_WORKSPACE_AGENT_SKILLS_ROOT, 'orchestration')
          })
        ],
        reason: 'ambiguous-install'
      },
      {
        skills: [discoveredSkill({ name: ORCHESTRATION_SKILL_NAME, sourceKind: 'bundled' })],
        reason: 'bundled-or-plugin-install'
      },
      {
        skills: [discoveredSkill({ name: ORCHESTRATION_SKILL_NAME, sourceKind: 'plugin' })],
        reason: 'bundled-or-plugin-install'
      },
      {
        skills: [
          discoveredSkill({
            name: ORCHESTRATION_SKILL_NAME,
            sourceKind: 'home',
            directoryIsSymlink: true
          })
        ],
        reason: 'symlinked-global-install'
      },
      {
        skills: [
          discoveredSkill({
            name: ORCHESTRATION_SKILL_NAME,
            sourceKind: 'home',
            directoryPath: join(TEST_ALICE_HOME, '.agents', 'skills', 'orchestration'),
            realDirectoryPath: join(TEST_CENTRAL_SKILLS_ROOT, 'orchestration'),
            skillFilePath: join(TEST_ALICE_HOME, '.agents', 'skills', 'orchestration', 'SKILL.md'),
            realSkillFilePath: join(TEST_CENTRAL_SKILLS_ROOT, 'orchestration', 'SKILL.md')
          })
        ],
        reason: 'symlinked-global-install'
      }
    ] as const

    for (const testCase of cases) {
      const coordinator = new ManagedSkillUpdateCoordinator({
        backgroundUpdatesEnabled: () => true,
        discoverHostSkills: async () => discovery([...testCase.skills]),
        readTextFile: async () => lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'),
        updateRunner
      })
      const result = await coordinator.ensureManagedReady(orchestrationRequest)
      expect(result.status === 'fallback' ? result.reason : null).toBe(testCase.reason)
    }
    expect(updateRunner).not.toHaveBeenCalled()
  })

  it('does not treat Codex or Claude home skills as managed global installs', async () => {
    const updateRunner = vi.fn(async () => ({ status: 'success' as const }))
    const coordinator = new ManagedSkillUpdateCoordinator({
      homeDir: () => TEST_ALICE_HOME,
      discoverHostSkills: async () =>
        discovery([
          discoveredSkill({
            name: ORCHESTRATION_SKILL_NAME,
            sourceKind: 'home',
            providers: ['codex'],
            rootPath: join(TEST_ALICE_HOME, '.codex', 'skills'),
            directoryPath: join(TEST_ALICE_HOME, '.codex', 'skills', 'orchestration')
          })
        ]),
      readTextFile: async () => lockfile(ORCHESTRATION_SKILL_NAME, 'old-hash'),
      updateRunner
    })

    const result = await coordinator.ensureManagedReady(orchestrationRequest)

    expect(result.status === 'fallback' ? result.reason : null).toBe('missing-install')
    expect(result.status === 'fallback' ? result.manualCommand?.kind : null).toBe('install')
    expect(updateRunner).not.toHaveBeenCalled()
  })

  it('keeps concurrent checks for different project roots independent', async () => {
    const discoverHostSkills = vi.fn(async () =>
      discovery([
        discoveredSkill({
          name: ORCHESTRATION_SKILL_NAME,
          sourceKind: 'home',
          rootPath: TEST_MANAGED_HOME_ROOT
        }),
        discoveredSkill({
          name: ORCHESTRATION_SKILL_NAME,
          sourceKind: 'repo',
          rootPath: TEST_WORKSPACE_AGENT_SKILLS_ROOT,
          directoryPath: join(TEST_WORKSPACE_AGENT_SKILLS_ROOT, 'orchestration')
        })
      ])
    )
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      discoverHostSkills,
      readTextFile: async () => lockfile(ORCHESTRATION_SKILL_NAME, 'hash-1'),
      updateRunner: async () => ({ status: 'success' })
    })

    const [currentProject, otherProject] = await Promise.all([
      coordinator.ensureManagedReady(orchestrationRequest),
      coordinator.ensureManagedReady({
        ...orchestrationRequest,
        discoveryTarget: { runtime: 'host', projectRootPath: TEST_OTHER_WORKSPACE_ROOT }
      })
    ])

    expect(currentProject.status === 'fallback' ? currentProject.reason : null).toBe(
      'ambiguous-install'
    )
    expect(otherProject.status).toBe('ready')
    expect(discoverHostSkills).toHaveBeenCalledTimes(3)
  })

  it('returns missing install with an install command without auto-installing', async () => {
    const updateRunner = vi.fn(async () => ({ status: 'success' as const }))
    const coordinator = new ManagedSkillUpdateCoordinator({
      discoverHostSkills: async () => discovery([]),
      updateRunner
    })

    const result = await coordinator.ensureManagedReady({
      skillName: ORCA_LINEAR_SKILL_NAME,
      context: 'linear-worktree',
      discoveryTarget: { runtime: 'host' }
    })

    expect(result.status === 'fallback' ? result.reason : null).toBe('missing-install')
    expect(result.status === 'fallback' ? result.manualCommand?.command : null).toBe(
      'npx --yes skills add https://github.com/stablyai/orca --skill orca-linear --global --yes'
    )
    expect(updateRunner).not.toHaveBeenCalled()
  })

  it('dedupes concurrent missing-install checks before discovery', async () => {
    const discoverHostSkills = vi.fn(async () => discovery([]))
    const coordinator = new ManagedSkillUpdateCoordinator({ discoverHostSkills })

    const [first, second] = await Promise.all([
      coordinator.ensureManagedReady({
        skillName: ORCA_LINEAR_SKILL_NAME,
        context: 'linear-worktree',
        discoveryTarget: { runtime: 'host' }
      }),
      coordinator.ensureManagedReady({
        skillName: ORCA_LINEAR_SKILL_NAME,
        context: 'linear-worktree',
        discoveryTarget: { runtime: 'host' }
      })
    ])

    expect(discoverHostSkills).toHaveBeenCalledTimes(1)
    expect(first.status === 'fallback' ? first.reason : null).toBe('missing-install')
    expect(second.status === 'fallback' ? second.reason : null).toBe('missing-install')
  })

  it('cooldowns repeated missing-install checks and lets force bypass that cooldown', async () => {
    let now = 100
    const discoverHostSkills = vi.fn(async () => discovery([]))
    const coordinator = new ManagedSkillUpdateCoordinator({
      cooldownMs: 1_000,
      now: () => now,
      discoverHostSkills
    })
    const request: ManagedAgentSkillEnsureRequest = {
      skillName: ORCA_LINEAR_SKILL_NAME,
      context: 'linear-worktree',
      discoveryTarget: { runtime: 'host' }
    }

    const first = await coordinator.ensureManagedReady(request)
    now = 200
    const second = await coordinator.ensureManagedReady(request)
    const forced = await coordinator.ensureManagedReady({ ...request, force: true })

    expect(first.status === 'fallback' ? first.reason : null).toBe('missing-install')
    expect(second.status === 'fallback' ? second.reason : null).toBe('cooldown')
    expect(forced.status === 'fallback' ? forced.reason : null).toBe('missing-install')
    expect(discoverHostSkills).toHaveBeenCalledTimes(2)
  })

  it('falls back for WSL, remote, and target-required runtime cases without local commands', async () => {
    const coordinator = new ManagedSkillUpdateCoordinator()

    const wsl = await coordinator.ensureManagedReady({
      skillName: ORCHESTRATION_SKILL_NAME,
      context: 'agent-orchestration',
      discoveryTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
    const remote = await coordinator.ensureManagedReady({
      skillName: ORCHESTRATION_SKILL_NAME,
      context: 'agent-orchestration',
      remoteRuntime: true
    })
    const unknown = await coordinator.ensureManagedReady({
      skillName: ORCHESTRATION_SKILL_NAME,
      context: 'agent-orchestration'
    })

    expect(wsl.status === 'fallback' ? wsl.reason : null).toBe('wsl-runtime')
    expect(wsl.status === 'fallback' ? wsl.manualCommand : undefined).toBeUndefined()
    expect(remote.status === 'fallback' ? remote.reason : null).toBe('remote-runtime')
    expect(remote.status === 'fallback' ? remote.manualCommand : undefined).toBeUndefined()
    expect(unknown.status === 'fallback' ? unknown.reason : null).toBe('target-required')
  })

  it('uses canonical orca-linear as the managed Linear skill and leaves legacy unsupported', async () => {
    const coordinator = new ManagedSkillUpdateCoordinator({
      backgroundUpdatesEnabled: () => true,
      discoverHostSkills: async () => homeDiscovery(ORCA_LINEAR_SKILL_NAME),
      readTextFile: async () => lockfile(ORCA_LINEAR_SKILL_NAME, 'hash-1'),
      updateRunner: async () => ({ status: 'success' })
    })

    const canonical = await coordinator.ensureManagedReady({
      skillName: ORCA_LINEAR_SKILL_NAME,
      context: 'linear-worktree',
      discoveryTarget: { runtime: 'host' }
    })
    const legacy = await coordinator.ensureManagedReady({
      skillName: 'linear-tickets' as ManagedAgentSkillName,
      context: 'linear-worktree',
      discoveryTarget: { runtime: 'host' }
    })

    expect(canonical.status).toBe('ready')
    expect(legacy.status === 'fallback' ? legacy.reason : null).toBe('unsupported-skill')
  })

  it('builds the exact single-skill global update command and Windows executable seam', () => {
    expect(buildManagedSkillUpdateCommand(ORCHESTRATION_SKILL_NAME)).toEqual({
      executable: 'npx',
      args: ['--yes', 'skills', 'update', 'orchestration', '--global', '--yes']
    })
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(buildManagedSkillUpdateCommand(ORCHESTRATION_SKILL_NAME)).toEqual({
      executable: 'npx.cmd',
      args: ['--yes', 'skills', 'update', 'orchestration', '--global', '--yes']
    })
    platform.mockRestore()
  })
})
