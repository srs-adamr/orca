import {
  getExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import type { ProjectHostSetup, Repo } from '../../../shared/types'

export type ProjectHostSetupOption =
  | {
      id: string
      kind: 'ready'
      projectId: string
      hostId: ExecutionHostId
      repoId: string
      label: string
      detail: string
      path: string
    }
  | {
      id: string
      kind: 'needs-setup'
      projectId: string
      hostId: ExecutionHostId
      label: string
      detail: string
    }

export type ReadyProjectHostSetupOption = Extract<ProjectHostSetupOption, { kind: 'ready' }>

type NeedsSetupProjectHostOption = Extract<ProjectHostSetupOption, { kind: 'needs-setup' }>

type BuildReadySetupOptionsInput = {
  projectId: string
  projectHostSetups: readonly ProjectHostSetup[]
  eligibleRepos: readonly Repo[]
}

type BuildNeedsSetupOptionsInput = {
  projectId: string
  hosts: readonly ExecutionHostRegistryEntry[]
  readySetupByHost: ReadonlyMap<ExecutionHostId, ReadyProjectHostSetupOption>
}

type BuildProjectHostSetupOptionsInput = {
  projectId: string | null
  projectHostSetups: readonly ProjectHostSetup[]
  eligibleRepos: readonly Repo[]
  hosts?: readonly ExecutionHostRegistryEntry[]
}

export function buildProjectHostSetupOptions({
  projectId,
  projectHostSetups,
  eligibleRepos,
  hosts = []
}: BuildProjectHostSetupOptionsInput): ProjectHostSetupOption[] {
  if (!projectId) {
    return []
  }
  const readyOptions = buildReadySetupOptions({ projectId, projectHostSetups, eligibleRepos })
  const readySetupByHost = new Map(readyOptions.map((option) => [option.hostId, option]))
  return [
    ...readyOptions,
    ...buildNeedsSetupOptions({
      projectId,
      hosts,
      readySetupByHost
    })
  ].sort((a, b) => compareProjectHostSetupOptions(a, b))
}

function buildReadySetupOptions({
  projectId,
  projectHostSetups,
  eligibleRepos
}: BuildReadySetupOptionsInput): ReadyProjectHostSetupOption[] {
  const eligibleRepoIds = new Set(eligibleRepos.map((repo) => repo.id))
  return projectHostSetups
    .filter(
      (setup) =>
        setup.projectId === projectId &&
        setup.setupState === 'ready' &&
        eligibleRepoIds.has(setup.repoId)
    )
    .map((setup) => ({
      id: setup.id,
      kind: 'ready' as const,
      projectId: setup.projectId,
      hostId: setup.hostId,
      repoId: setup.repoId,
      label: getExecutionHostLabel(setup.hostId),
      detail: setup.displayName,
      path: setup.path
    }))
}

function buildNeedsSetupOptions({
  projectId,
  hosts,
  readySetupByHost
}: BuildNeedsSetupOptionsInput): NeedsSetupProjectHostOption[] {
  return hosts
    .filter((host) => !readySetupByHost.has(host.id))
    .map((host) => ({
      id: `needs-setup:${host.id}`,
      kind: 'needs-setup' as const,
      projectId,
      hostId: host.id,
      label: host.label || getExecutionHostLabel(host.id),
      detail: 'Project not set up on this host'
    }))
}

function compareProjectHostSetupOptions(
  a: ProjectHostSetupOption,
  b: ProjectHostSetupOption
): number {
  if (a.hostId === LOCAL_EXECUTION_HOST_ID && b.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return -1
  }
  if (b.hostId === LOCAL_EXECUTION_HOST_ID && a.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return 1
  }
  const aDetail = a.kind === 'ready' ? a.path : a.detail
  const bDetail = b.kind === 'ready' ? b.path : b.detail
  return a.label.localeCompare(b.label) || aDetail.localeCompare(bDetail)
}
