import type { AgentStartupShell } from './tui-agent-startup-shell'

const CODEX_STARTUP_RETRY_MAX_RETRIES = 2
const CODEX_STARTUP_RETRY_MIN_SECONDS = 4
const CODEX_STARTUP_RETRY_MAX_SECONDS = 12
const CODEX_STARTUP_RETRY_MESSAGE = 'Codex exited during startup; retrying...'

function wrapCodexStartupRetry(command: string, shell: AgentStartupShell): string {
  if (shell === 'cmd') {
    return command
  }
  // Why: Codex's SQLite busy timeout exits after about five seconds when
  // another tab briefly holds shared local state. Retrying keeps that state shared.
  if (shell === 'powershell') {
    return [
      `function __orca_codex_start { ${command} }`,
      '$__orcaCodexAttempt = 0',
      'while ($true) {',
      '  $__orcaCodexStarted = Get-Date',
      '  __orca_codex_start',
      '  $__orcaCodexStatus = if ($null -eq $global:LASTEXITCODE) { 0 } else { $global:LASTEXITCODE }',
      '  $__orcaCodexElapsed = ((Get-Date) - $__orcaCodexStarted).TotalSeconds',
      `  if ($__orcaCodexStatus -eq 0 -or $__orcaCodexStatus -eq 130 -or $__orcaCodexElapsed -lt ${CODEX_STARTUP_RETRY_MIN_SECONDS} -or $__orcaCodexElapsed -gt ${CODEX_STARTUP_RETRY_MAX_SECONDS} -or $__orcaCodexAttempt -ge ${CODEX_STARTUP_RETRY_MAX_RETRIES}) { break }`,
      '  $__orcaCodexAttempt += 1',
      `  Write-Host "${CODEX_STARTUP_RETRY_MESSAGE}"`,
      '  Start-Sleep -Seconds $__orcaCodexAttempt',
      '}',
      'Remove-Item Function:__orca_codex_start -ErrorAction SilentlyContinue',
      '$global:LASTEXITCODE = $__orcaCodexStatus'
    ].join('; ')
  }
  const retryFunctionBody = [
    '__orca_codex_attempt=0',
    'while :; do __orca_codex_started=$(date +%s)',
    '  __orca_codex_start',
    '  __orca_codex_status=$?',
    '  __orca_codex_elapsed=$(($(date +%s)-__orca_codex_started))',
    `  if [ "$__orca_codex_status" -eq 0 ] || [ "$__orca_codex_status" -eq 130 ] || [ "$__orca_codex_elapsed" -lt ${CODEX_STARTUP_RETRY_MIN_SECONDS} ] || [ "$__orca_codex_elapsed" -gt ${CODEX_STARTUP_RETRY_MAX_SECONDS} ] || [ "$__orca_codex_attempt" -ge ${CODEX_STARTUP_RETRY_MAX_RETRIES} ]; then return "$__orca_codex_status"; fi`,
    '  __orca_codex_attempt=$((__orca_codex_attempt+1))',
    `  printf "%s\\n" "${CODEX_STARTUP_RETRY_MESSAGE}" >&2`,
    '  sleep "$__orca_codex_attempt"',
    'done'
  ].join('; ')
  return [
    `__orca_codex_start() { ${command}; }`,
    `__orca_codex_retry() { ${retryFunctionBody}; }`,
    '__orca_codex_retry',
    '__orca_codex_result=$?',
    'unset -f __orca_codex_start __orca_codex_retry 2>/dev/null || true',
    '(exit "$__orca_codex_result")'
  ].join('; ')
}

export function maybeWrapCodexStartupRetry(
  agent: string,
  command: string,
  shell: AgentStartupShell
): string {
  return agent === 'codex' ? wrapCodexStartupRetry(command, shell) : command
}
