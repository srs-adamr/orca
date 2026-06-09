export type HiddenRendererSkipEligibility = {
  foreground: boolean
  canRestoreHiddenOutput: boolean
  startupRendererQueryWindowActive: boolean
  synchronizedOutputActive: boolean
  data: string
}

function isAllowedPlainHiddenOutputCode(code: number): boolean {
  if (code === 0x09 || code === 0x0a) {
    return true
  }
  return code >= 0x20 && code <= 0x7e
}

function findTitleOscEnd(data: string, startIndex: number): number | null {
  const command = data.charCodeAt(startIndex + 2)
  if (
    data.charCodeAt(startIndex) !== 0x1b ||
    data.charCodeAt(startIndex + 1) !== 0x5d ||
    (command !== 0x30 && command !== 0x31 && command !== 0x32) ||
    data.charCodeAt(startIndex + 3) !== 0x3b
  ) {
    return null
  }

  for (let index = startIndex + 4; index < data.length; index++) {
    const code = data.charCodeAt(index)
    if (code === 0x07) {
      return index + 1
    }
    if (code === 0x1b) {
      return data.charCodeAt(index + 1) === 0x5c ? index + 2 : null
    }
  }
  return null
}

function findSafeCsiEnd(data: string, startIndex: number): number | null {
  if (data.charCodeAt(startIndex) !== 0x1b || data.charCodeAt(startIndex + 1) !== 0x5b) {
    return null
  }

  for (let index = startIndex + 2; index < data.length; index++) {
    const code = data.charCodeAt(index)
    if (code < 0x40 || code > 0x7e) {
      continue
    }
    const body = data.slice(startIndex + 2, index)
    const final = data[index]
    if (isSafeHiddenRedrawCsi(body, final)) {
      return index + 1
    }
    return null
  }
  return null
}

function isSafeHiddenRedrawCsi(body: string, final: string): boolean {
  if (/[^0-9;?]/.test(body)) {
    return false
  }
  if (final === 'h' || final === 'l') {
    return body === '?2026' || body === '?25'
  }
  return (
    final === 'm' ||
    final === 'H' ||
    final === 'f' ||
    final === 'A' ||
    final === 'B' ||
    final === 'C' ||
    final === 'D' ||
    final === 'G' ||
    final === 'J' ||
    final === 'K'
  )
}

function containsOnlyRestorableHiddenOutput(data: string): boolean {
  for (let index = 0; index < data.length; ) {
    const code = data.charCodeAt(index)
    if (code === 0x1b) {
      const nextIndex = findTitleOscEnd(data, index) ?? findSafeCsiEnd(data, index)
      if (nextIndex === null) {
        return false
      }
      index = nextIndex
      continue
    }
    if (code === 0x0d) {
      if (data.charCodeAt(index + 1) !== 0x0a) {
        return false
      }
      index += 1
      continue
    }
    if (!isAllowedPlainHiddenOutputCode(code)) {
      return false
    }
    index += 1
  }
  return true
}

export function shouldSkipHiddenRendererOutput({
  foreground,
  canRestoreHiddenOutput,
  startupRendererQueryWindowActive,
  data
}: HiddenRendererSkipEligibility): boolean {
  if (
    foreground ||
    !canRestoreHiddenOutput ||
    startupRendererQueryWindowActive ||
    data.length === 0
  ) {
    return false
  }
  return containsOnlyRestorableHiddenOutput(data)
}
