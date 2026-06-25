import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type {
  ManagedAgentSkillEnsureRequest,
  ManagedAgentSkillEnsureResult,
  SkillDiscoveryResult
} from '../../shared/skills'
import { discoverSkills } from './discovery'
import {
  buildManagedSkillFallback,
  buildManagedSkillGlobalUpdateFallback,
  buildManagedSkillReadyResult,
  buildManagedSkillUpdatedResult
} from './managed-skill-ensure-result'
import { selectSingleGlobalManagedSkillCandidate } from './managed-skill-global-candidate'
import { readManagedSkillLockEntry } from './managed-skill-lockfile'
import {
  makeManagedSkillPreDiscoveryCacheKey,
  makeManagedSkillSuccessCacheKey,
  makeManagedSkillTargetFallbackCacheKey,
  shouldCooldownFallback
} from './managed-skill-update-cache-key'
import {
  buildManagedSkillManualCommand,
  isManagedAgentSkillName
} from './managed-skill-update-contract'
import { verifyManagedSkillPostUpdate } from './managed-skill-post-update-verification'
import {
  createManagedSkillUpdateRunner,
  type ManagedSkillUpdateRunner
} from './managed-skill-update-runner'
import { resolveManagedSkillTarget, type ResolvedManagedSkillTarget } from './managed-skill-target'

type ManagedSkillCoordinatorDeps = {
  appVersion?: string
  backgroundUpdatesEnabled?: () => boolean
  cooldownMs?: number
  discoverHostSkills?: (projectRootPath?: string | null) => Promise<SkillDiscoveryResult>
  homeDir?: () => string
  now?: () => number
  readTextFile?: (path: string) => Promise<string>
  updateRunner?: ManagedSkillUpdateRunner
}

const DEFAULT_COOLDOWN_MS = 60_000
let defaultUpdateAbortController = new AbortController()

export function abortManagedSkillUpdateProcesses(): void {
  defaultUpdateAbortController.abort()
  // Why: AbortSignal is one-shot; future coordinators need a fresh shutdown signal.
  defaultUpdateAbortController = new AbortController()
}

export class ManagedSkillUpdateCoordinator {
  private readonly appVersion: string
  private readonly backgroundUpdatesEnabled: () => boolean
  private readonly cooldownMs: number
  private readonly discoverHostSkills: (
    projectRootPath?: string | null
  ) => Promise<SkillDiscoveryResult>
  private readonly homeDir: () => string
  private readonly now: () => number
  private readonly readTextFile: (path: string) => Promise<string>
  private readonly updateRunner: ManagedSkillUpdateRunner
  private readonly inFlightByPreDiscoveryKey = new Map<
    string,
    Promise<ManagedAgentSkillEnsureResult>
  >()
  private readonly disabledFallbackByPreDiscoveryKey = new Map<
    string,
    { result: ManagedAgentSkillEnsureResult; until: number }
  >()
  private readonly cooldownUntilByKey = new Map<string, number>()
  private readonly readyUntilByPreDiscoveryKey = new Map<string, number>()
  private readonly successCache = new Set<string>()

  constructor(deps: ManagedSkillCoordinatorDeps = {}) {
    this.appVersion = deps.appVersion ?? 'unknown'
    this.backgroundUpdatesEnabled = deps.backgroundUpdatesEnabled ?? (() => false)
    this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.discoverHostSkills = deps.discoverHostSkills ?? (() => discoverSkills({ repos: [] }))
    this.homeDir = deps.homeDir ?? homedir
    this.now = deps.now ?? Date.now
    this.readTextFile = deps.readTextFile ?? ((path) => readFile(path, 'utf8'))
    this.updateRunner =
      deps.updateRunner ??
      createManagedSkillUpdateRunner({ signal: defaultUpdateAbortController.signal })
  }

  ensureManagedReady(
    request: ManagedAgentSkillEnsureRequest
  ): Promise<ManagedAgentSkillEnsureResult> {
    if (!isManagedAgentSkillName(request.skillName)) {
      return Promise.resolve(
        buildManagedSkillFallback({
          request,
          reason: 'unsupported-skill',
          runtime: 'unknown',
          scope: 'missing'
        })
      )
    }

    const target = resolveManagedSkillTarget(request)
    if (!target.ok) {
      const targetFallbackKey = makeManagedSkillTargetFallbackCacheKey({
        appVersion: this.appVersion,
        distro: target.distro,
        reason: target.reason,
        request,
        runtime: target.runtime
      })
      const cooldownUntil = this.cooldownUntilByKey.get(targetFallbackKey)
      if (!request.force && cooldownUntil && cooldownUntil > this.now()) {
        return Promise.resolve(
          buildManagedSkillFallback({
            request,
            reason: 'cooldown',
            runtime: target.runtime,
            distro: target.distro,
            scope: 'missing'
          })
        )
      }
      this.cooldownUntilByKey.set(targetFallbackKey, this.now() + this.cooldownMs)
      return Promise.resolve(
        buildManagedSkillFallback({
          request,
          reason: target.reason,
          runtime: target.runtime,
          distro: target.distro,
          scope: 'missing'
        })
      )
    }

    const preDiscoveryKey = makeManagedSkillPreDiscoveryCacheKey({
      appVersion: this.appVersion,
      backgroundUpdatesEnabled: this.backgroundUpdatesEnabled(),
      distro: target.distro,
      request,
      runtime: target.runtime
    })
    const existing = this.inFlightByPreDiscoveryKey.get(preDiscoveryKey)
    if (existing) {
      return existing
    }
    const preDiscoveryCooldownUntil = this.cooldownUntilByKey.get(preDiscoveryKey)
    if (!request.force && preDiscoveryCooldownUntil && preDiscoveryCooldownUntil > this.now()) {
      return Promise.resolve(
        buildManagedSkillFallback({
          request,
          reason: 'cooldown',
          runtime: target.runtime,
          distro: target.distro,
          scope: 'missing'
        })
      )
    }
    const readyUntil = this.readyUntilByPreDiscoveryKey.get(preDiscoveryKey)
    if (!request.force && readyUntil && readyUntil > this.now()) {
      return Promise.resolve(buildManagedSkillReadyResult(request))
    }
    const disabledFallback = this.disabledFallbackByPreDiscoveryKey.get(preDiscoveryKey)
    if (!request.force && disabledFallback && disabledFallback.until > this.now()) {
      return Promise.resolve(disabledFallback.result)
    }

    const promise = this.evaluate(request, target)
      .then((result) => {
        if (result.status === 'ready' || result.status === 'updated') {
          this.readyUntilByPreDiscoveryKey.set(preDiscoveryKey, this.now() + this.cooldownMs)
        }
        if (shouldCooldownFallback(result)) {
          this.cooldownUntilByKey.set(preDiscoveryKey, this.now() + this.cooldownMs)
        }
        if (isBackgroundUpdateDisabledFallback(result)) {
          this.disabledFallbackByPreDiscoveryKey.set(preDiscoveryKey, {
            result,
            until: this.now() + this.cooldownMs
          })
        }
        return result
      })
      .finally(() => {
        if (this.inFlightByPreDiscoveryKey.get(preDiscoveryKey) === promise) {
          this.inFlightByPreDiscoveryKey.delete(preDiscoveryKey)
        }
      })
    this.inFlightByPreDiscoveryKey.set(preDiscoveryKey, promise)
    return promise
  }

  private async evaluate(
    request: ManagedAgentSkillEnsureRequest,
    target: Extract<ResolvedManagedSkillTarget, { ok: true }>
  ): Promise<ManagedAgentSkillEnsureResult> {
    if (target.runtime === 'wsl') {
      return buildManagedSkillFallback({
        request,
        reason: 'wsl-runtime',
        runtime: 'wsl',
        distro: target.distro,
        scope: 'missing'
      })
    }

    const discovery = await this.discoverHostSkills(request.discoveryTarget?.projectRootPath)
    const globalCandidateDecision = selectSingleGlobalManagedSkillCandidate({
      discovery,
      homeDir: this.homeDir(),
      projectRootPath: request.discoveryTarget?.projectRootPath,
      skillName: request.skillName
    })
    if (globalCandidateDecision.status === 'fallback') {
      return buildManagedSkillFallback({
        request,
        reason: globalCandidateDecision.fallback.reason,
        runtime: 'host',
        scope: globalCandidateDecision.fallback.scope,
        manualCommand: globalCandidateDecision.fallback.manualCommand
      })
    }

    const lockEntryResult = await readManagedSkillLockEntry({
      homeDir: this.homeDir(),
      readTextFile: this.readTextFile,
      skillName: request.skillName
    })
    if (!lockEntryResult.ok) {
      return buildManagedSkillFallback({
        request,
        reason: lockEntryResult.reason,
        runtime: 'host',
        scope: 'global'
      })
    }
    const currentLockHash = lockEntryResult.entry.skillFolderHash
    const cacheKey = makeManagedSkillSuccessCacheKey({
      appVersion: this.appVersion,
      request,
      currentLockHash
    })
    if (this.successCache.has(cacheKey)) {
      return buildManagedSkillReadyResult(request)
    }
    const backgroundUpdatesEnabled = this.backgroundUpdatesEnabled()
    if (!backgroundUpdatesEnabled) {
      return buildManagedSkillFallback({
        request,
        reason: 'background-update-disabled',
        runtime: 'host',
        scope: 'global',
        manualCommand: buildManagedSkillManualCommand('update', request.skillName)
      })
    }

    const cooldownUntil = this.cooldownUntilByKey.get(cacheKey)
    if (!request.force && cooldownUntil && cooldownUntil > this.now()) {
      return buildManagedSkillFallback({
        request,
        reason: 'cooldown',
        runtime: 'host',
        scope: 'global'
      })
    }

    const updateResult = await this.updateRunner(request.skillName)
    if (updateResult.status !== 'success') {
      this.cooldownUntilByKey.set(cacheKey, this.now() + this.cooldownMs)
      return buildManagedSkillGlobalUpdateFallback(
        request,
        updateResult.status === 'timeout' ? 'update-timeout' : 'update-failed'
      )
    }

    const postUpdate = await verifyManagedSkillPostUpdate({
      discoverHostSkills: this.discoverHostSkills,
      homeDir: this.homeDir(),
      readTextFile: this.readTextFile,
      request
    })
    if (!postUpdate.ok) {
      this.cooldownUntilByKey.set(cacheKey, this.now() + this.cooldownMs)
      return buildManagedSkillGlobalUpdateFallback(request, 'update-failed')
    }
    const postLockHash = postUpdate.lockHash
    this.successCache.add(
      makeManagedSkillSuccessCacheKey({
        appVersion: this.appVersion,
        request,
        currentLockHash: postLockHash
      })
    )
    if (postLockHash === currentLockHash) {
      return buildManagedSkillReadyResult(request)
    }
    return buildManagedSkillUpdatedResult(request)
  }
}

function isBackgroundUpdateDisabledFallback(result: ManagedAgentSkillEnsureResult): boolean {
  return result.status === 'fallback' && result.reason === 'background-update-disabled'
}
