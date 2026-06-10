# Project-First Hosts Discussion

## Summary

We started from Issue #4697 and the question of how Orca should treat VMs,
remote servers, SSH machines, and future cloud compute. The first implemented
direction made hosts more visible in the sidebar:

```text
Host
  Project
    Workspace
```

That is useful for operational visibility, especially when a remote host is
offline or incompatible, but it makes the machine feel like the user's primary
unit of organization. After discussion, the stronger long-term model is:

```text
Project
  Host setup
    Workspace
```

In plain English: a host is where a project can run. It should not usually be
the thing that owns the project in the user's mental model.

## Product Direction

The durable Orca model should be:

```text
Project -> ProjectHostSetup -> Workspace
```

Definitions:

- `Project`: the durable repo/project identity the user recognizes.
- `Host`: a local Mac, SSH target, remote runtime, VM, or future Orca cloud VM.
- `ProjectHostSetup`: the fact that a project is available on a host at a
  concrete path with host-specific settings.
- `Workspace`: a branch/task/worktree running from one project setup on one
  host.

This supports several important cases:

- A project exists only on the local machine.
- A project exists only on a remote Linux server.
- The same project exists on both local and remote hosts.
- A project cannot run locally because it needs Linux, GPU hardware, secrets, or
  work-only infrastructure.
- A future Orca cloud VM can be offered as another host where a project can be
  set up and run.

## Reference Research

### Superset

Superset is the closest reference for the desired model.

Its model is effectively:

```text
Project + Host -> Workspace
```

Relevant behavior:

- A workspace stores both the project and the host.
- A project can be set up on multiple hosts.
- Creation is host-targeted: choose project, choose host, then create.
- If a project is not available on a selected host, the UI blocks or asks the
  user to set it up.
- Settings distinguish project-level state from host-local paths and worktree
  locations.

The important lesson for Orca is that the same project should not become two
unrelated top-level projects just because it exists on two machines.

### Cmux

Cmux is more session/workspace-first.

Its model is closer to:

```text
Workspace/session -> local or remote execution context
```

Relevant behavior:

- SSH is a strong first-class execution mode.
- Remote browser/localhost behavior is polished.
- File and terminal views follow the remote session.
- It does not appear to center a durable "project is available on these hosts"
  abstraction.

The important lesson for Orca is SSH polish, not the core data model.

## UX Decisions So Far

### Sidebar

Default organization should trend project-first:

```text
Orca
  Local Mac
    feature-sidebar
  openclaw 2
    fix-ssh-agent-status
```

But host visibility still matters. Hosts should remain available as:

- filters
- optional grouping
- status/health surfaces
- setup targets
- operational troubleshooting context

For single-host projects, the sidebar should avoid noisy host nesting. A local
only user should mostly feel like Orca still works the way it used to.

### Create Workspace

Creating a workspace should eventually ask:

1. Which project?
2. Which host should run it?
3. What branch/task/name?

If the chosen project is not set up on the chosen host, Orca should offer setup
actions such as clone or import existing folder.

### Settings

Settings need to make ownership explicit:

- Client settings belong to the desktop client.
- Host settings belong to a machine/runtime.
- Project settings belong to the durable project.
- Project-host setup settings belong to that project on that specific host.

A host dropdown or host table inside project settings is probably sufficient for
host-specific project settings, similar to the existing Windows/WSL split.

### SSH And VMs

SSH machines, VMs, remote servers, and future cloud machines should all fit the
same broad host model. A VM does not need a special product concept at first; it
can be a host with particular capabilities, provisioning metadata, or billing
metadata later.

## What Needs To Change

This is a real model change, not a small sidebar adjustment. There are 12
meaningful change surfaces.

### 1. Shared Data Model

Add first-class project and project-host setup concepts.

Current `Repo` mixes durable project identity with host-local setup details like
path, worktree base path, connection id, execution host id, and hook settings.
The new model separates those responsibilities.

Needed:

- `Project`
- `ProjectHostSetup`
- explicit host/setup ownership for workspaces
- compatibility projection from old `Repo` records

### 2. Persistence And Migration

Existing users must migrate without drama.

Needed:

- derive one `Project` per durable identity
- derive one `ProjectHostSetup` per existing repo checkout
- preserve old ids or aliases where needed
- backfill local-only users into one project with one local setup
- avoid merging same-name folders unless there is reliable provider identity

### 3. Runtime And Request Ownership

Execution still happens on a host even if the UI is project-first.

Needed:

- derive runtime target from workspace/setup host
- keep local, SSH, remote runtime, and future cloud behind one routing contract
- audit terminal, browser, filesystem, git, source-control, agent, hook, and
  automation paths for repo-id assumptions

### 4. Workspace Creation

Creation needs to target a project and host, not only a repo id.

Needed:

- project picker
- run-on host picker
- unavailable-host reasons
- inline setup/import/clone path when a project is not set up
- compatibility mapping to existing `createWorktree(repoId, ...)` while old APIs
  still exist

### 5. Project Setup Flow

"Add project" and "make this project available on this host" become separate
ideas.

Needed:

- import existing folder on local or SSH host
- clone project onto selected host
- set up an existing project on another host
- bulk setup when a new host is added
- future cloud provisioning hook

### 6. Sidebar Row Model

The sidebar should be built from projects, hosts, setups, and workspaces rather
than repo-only grouping.

Needed:

- project-first grouping
- host subgroups only when useful
- host filters/status retained
- drag/reorder rules for project rows, host sections, and workspaces
- clear treatment for disconnected hosts versus hidden/unavailable hosts

### 7. Project Settings

Project settings need a global section and host-specific setup sections.

Needed:

- project-global settings
- host-specific path/worktree/setup-script settings
- host selector or host table
- source-control settings that remain provider-neutral, not GitHub-only

### 8. Host Settings

Hosts need their own settings without duplicating every project setting.

Needed:

- connection details
- display name
- health/status
- server version and protocol compatibility
- platform/capability info
- host-wide defaults and overrides

### 9. Compatibility And Version Skew

New clients and old servers will exist at the same time.

Needed:

- capability probing
- fallback projection when project/setup APIs are missing
- clear disabled states for old server/client combinations
- structured errors for unsupported actions

### 10. Caches And Local State

Some caches are project-global, but many are host/setup-local.

Needed:

- classify caches as project, host, setup, or workspace scoped
- include host/setup ids in cache keys for refs, status, paths, capabilities,
  terminals, browser sessions, and remote filesystem state
- scope cancellation and stale-response handling to the owning host

### 11. CLI And API

External commands need to speak the project-first language.

Needed:

- project list/setup commands
- host list/status commands
- workspace create with project and host
- compatibility aliases for old repo/worktree commands

### 12. Tests And Verification

The change crosses storage, routing, and UI, so tests need to cover the full
shape.

Needed:

- migration tests
- selector/sidebar grouping tests
- create-workspace tests
- settings ownership tests
- SSH setup/workspace tests
- version mismatch tests
- Electron validation of sidebar, creation, and settings flows

## Change Count

The short answer is: 12 major things need to change.

The highest-risk pieces are:

1. data model and migration
2. workspace creation and project setup
3. runtime/request ownership
4. settings ownership
5. compatibility with old clients/servers

The current branch has already started the additive migration by adding
`Project` and `ProjectHostSetup` compatibility records, read-only APIs, runtime
RPC methods, renderer hydration, and initial sidebar grouping support. The full
project-first model is not finished until workspace creation, setup-on-host,
settings, routing/caches, CLI/API, and end-to-end validation are updated too.

## Recommended Implementation Shape

Implement this as an additive migration:

1. Keep existing `Repo` APIs alive while adding project/setup records.
2. Use conservative identity matching so only reliably linked checkouts merge
   into one project.
3. Teach creation flows to resolve `{ projectId, hostId }` into the existing
   repo/setup backend path.
4. Add setup-on-host flows for local and SSH.
5. Split settings into client, host, project, and project-host setup ownership.
6. Audit host-local caches and runtime routing.
7. Move the visible default UX to project-first once the underlying behavior is
   real.

This avoids a jarring migration for local-only users while still making SSH,
VMs, remote servers, and future cloud hosts first-class.
