---
name: ephemeral-vms
description: >-
  Create, review, debug, or validate Orca ephemeral VM recipes for cloud
  sandboxes and one-workspace remote runtimes. Use when the user wants to set
  up or fix a repo-local `orca.yaml` `vmRecipes` entry, provider lifecycle
  scripts, or `orca vm recipe doctor` failure for cloud sandboxes, custom cloud
  VMs, container-like runtimes, or other ephemeral coding environments.
---

# Ephemeral VMs

Use this skill to help a user make a repo-owned VM recipe work. Orca should stay a thin wrapper:
do not manage provider accounts, images, cloud resources, credentials, or lifecycle policy for the
user. Author scripts that call the user's chosen provider tools, start `orca serve` in the remote
runtime, and return Orca's recipe result JSON.

## Core Contract

A repo can define recipes in `orca.yaml`:

```yaml
vmRecipes:
  - id: cloud-sandbox
    name: Cloud Sandbox
    create: ./scripts/orca-vm/cloud-sandbox-create.sh
    suspend: ./scripts/orca-vm/cloud-sandbox-suspend.sh
    resume: ./scripts/orca-vm/cloud-sandbox-resume.sh
    destroy: ./scripts/orca-vm/cloud-sandbox-destroy.sh
```

The `create` script runs locally on the user's desktop from the repo root. It must provision the remote
environment, ensure the repo exists there, start `orca serve` in that remote environment, then
print one JSON object to stdout:

```json
{
  "schemaVersion": 1,
  "pairingCode": "orca-pairing-code-or-url",
  "projectRoot": "/absolute/path/to/repo/on/remote",
  "userData": {
    "provider": "example",
    "resourceId": "provider-resource-id"
  }
}
```

Required fields:

- `pairingCode`: the Orca pairing code or pairing URL emitted by `orca serve --recipe-json`.
- `projectRoot`: absolute repo path on the remote VM/sandbox.

Optional fields:

- `schemaVersion`: use `1`.
- `userData`: provider metadata needed for lifecycle hooks or debugging. Do not put secrets here.

Lifecycle hooks:

- `create`: required. Runs locally and prints recipe result JSON.
- `suspend`: optional. Runs locally when Orca sleeps the workspace. Reads lifecycle payload JSON on stdin.
- `resume`: optional. Runs locally when Orca wakes the workspace. Reads lifecycle payload JSON on stdin and prints fresh recipe result JSON.
- `destroy`: optional unless `destroy: none`. Runs locally when Orca deletes/cleans up the runtime. Reads lifecycle payload JSON on stdin.

Backward compatibility exists for old recipes: `command` maps to `create`, `cleanup` maps to `destroy`, and `cleanup: none` maps to `destroy: none`. Prefer the lifecycle field names for new work.

## Workflow

1. Inspect the repo for existing `orca.yaml`, scripts, provider docs, Dockerfiles, devcontainer
   config, or README setup notes.
2. Ask the user which provider/tool should create the VM if the repo does not make it obvious.
3. Check what provider CLIs are installed before relying on them.
4. Add or update the smallest repo-owned recipe files needed.
5. Keep scripts portable: prefer `#!/usr/bin/env bash` only when bash is required, quote paths,
   fail fast with clear stderr, and keep stdout reserved for the final JSON object.
6. Run `orca vm recipe doctor <recipe-id> --repo-path <repo>` for non-destructive validation.
7. If the user explicitly wants a live test, create a workspace through Orca's `Run on -> Ephemeral VM` picker, then verify sleep, wake, and delete invoke the expected provider lifecycle.

Do not create an Orca workspace unless the user explicitly asks. Do not commit changes unless the
user asks.

## Create Script Pattern

The create script owns provider-specific setup. The exact provider commands vary, but the shape
should be:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
recipe_id="${ORCA_VM_RECIPE_ID:-cloud-sandbox}"
instance_id="${ORCA_VM_INSTANCE_ID:-manual}"

# 1. Create or locate the provider runtime.
# 2. Ensure the repo exists on the remote VM.
# 3. Ensure Orca is installed on the remote VM.
# 4. Start orca serve remotely with recipe JSON output.
# 5. Print only the final recipe result JSON to stdout.
```

When starting Orca in the remote runtime, prefer the recipe-friendly serve mode:

```bash
orca serve --host 0.0.0.0 --port "$PORT" --recipe-json
```

If the provider exposes the server through a public URL, ensure the pairing code/URL emitted by
`orca serve` points at the externally reachable address. Provider-specific tunneling or port
mapping belongs in the user's script.

## Lifecycle Payload Pattern

For `suspend`, `resume`, and `destroy`, Orca passes a JSON payload on stdin. Read it, extract
`recipeResult.userData`, and call the provider lifecycle action. If destruction is intentionally
manual, set `destroy: none` in `orca.yaml`.

```bash
#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
resource_id="$(node -e '
  const data = JSON.parse(process.argv[1])
  console.log(data.recipeResult?.userData?.resourceId ?? "")
' "$payload")"

if [ -z "$resource_id" ]; then
  echo "No resource id found in lifecycle payload" >&2
  exit 1
fi

# case "$ORCA_VM_MODE" in
#   suspend) provider-cli suspend "$resource_id" ;;
#   resume) provider-cli resume "$resource_id"; print_recipe_result_json ;;
#   destroy) provider-cli delete "$resource_id" ;;
# esac
```

`resume` must print a fresh recipe result JSON object to stdout because the runtime endpoint or pairing data may change after waking.

## Validation Checklist

- `orca.yaml` parses and contains the recipe id.
- `create`, `suspend`, `resume`, and `destroy` commands are repo-relative and executable where needed.
- The create command prints valid recipe JSON on stdout.
- The resume command prints valid recipe JSON on stdout when `resume` is configured.
- Logs, progress, and provider errors go to stderr.
- `pairingCode` is present and not logged elsewhere.
- `projectRoot` is an absolute path on the remote VM and points to the repo.
- Provider credentials come from the user's environment or provider CLI auth, not checked-in files.
- Destroy is either implemented and tested or explicitly set to `none`.

## Boundaries

- Do not invent provider credentials, org ids, projects, regions, images, or billing choices.
- Do not hide provider errors behind generic messages; preserve actionable stderr.
- Do not put tokens, pairing material, or private keys in `userData`, comments, docs, or commits.
- Do not make Orca responsible for provider lifecycle beyond invoking the configured scripts.
