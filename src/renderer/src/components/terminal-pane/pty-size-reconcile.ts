// Why: the deferred-rAF fit can spawn the PTY at a stale (wide) width when the
// pane's real layout has not settled by the first frame — e.g. a tab that
// MOUNTS with a split layout already present (a new worktree opened with the
// side panel on). The PTY is born at the wide window width while xterm later
// reflows to the narrower split/pane width. The corrective xterm onResize is
// dropped during the mount window because it honors the visibility gate, which
// is not yet authoritative (deps.isVisibleRef flips true after mount). So
// process.stdout.columns stays pinned wide forever and interactive TUIs render
// garbled (output sized for the wide width wrapping ~1 char per line into the
// narrow pane). Only a later manual resize re-syncs it.
//
// This post-spawn reconcile bridges exactly that gap: it polls across frames,
// forwarding xterm's measured grid to the PTY on every actual change. Its
// resize is authoritative by definition, so it bypasses the visibility gate.
// It keeps polling while the pane is NOT yet authoritative (the hidden mount
// window where onResize is dropped) so a late-settling split/sidebar layout is
// still forwarded; once the pane is authoritative and the grid has been stable,
// it stops and hands off to the live onResize path, which catches any later
// layout change. A hard frame cap guarantees termination.
//
// This loop tracks what it last SENT, not what the PTY actually applied, so a
// forward dropped main-side (e.g. a mobile take-back resize-suppression window)
// can still leave the PTY stale here. The visibility-resume re-assert in
// pty-connection.ts is the backstop: on show it reads the PTY's real size
// (pty:getSize) and re-forwards on true drift, healing a pane that later
// hides/shows.

export type PtySizeReconcileDimensions = { cols: number; rows: number }

export type PtySizeReconcileOptions = {
  /** Dimensions the PTY was spawned at — the size it currently believes it is. */
  spawnCols: number
  spawnRows: number
  /** True while this reconcile still owns a live PTY (not disposed / not rebound). */
  isAlive: () => boolean
  /**
   * True while the PTY is legitimately parked at non-pane dims (mobile-fit
   * override / mobile driving). Such frames are skipped — neither fit nor
   * forwarded — but still count toward the hard cap so a permanently-parked
   * PTY cannot loop forever.
   */
  isParked: () => boolean
  /**
   * True once the live onResize path will forward future PTY resizes itself
   * (i.e. the pane is visible / renderer resize is authoritative). The
   * reconcile only needs to run while this is false (the mount window where
   * onResize is dropped); once true and the grid is stable it hands off.
   */
  isAuthoritative: () => boolean
  /**
   * Fit the pane and return its current measured grid, or null when the pane is
   * not yet measurable. A measured grid that differs from what the PTY was last
   * told is forwarded; a matching grid counts toward the stability window.
   */
  measure: () => PtySizeReconcileDimensions | null
  /** Forward the settled size to the PTY (authoritative — bypasses visibility). */
  resize: (cols: number, rows: number) => void
  /** Schedule the next frame; mirrors requestAnimationFrame's id contract. */
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
}

export type PtySizeReconcileHandle = { cancel: () => void }

// Hand off (stop) once the grid has held steady for SETTLE_FRAMES of frames
// observed *while authoritative*. Rationale for the two-part gate:
//  - While hidden, the live onResize is dropped, so the reconcile is the SOLE
//    corrector: it must keep polling and forwarding every change (a narrow that
//    settles during the hidden window is the real shipped bug). Hidden frames
//    therefore never count toward the settle window — the loop cannot hand off.
//  - Once authoritative (pane visible), the live onResize/ResizeObserver path
//    is the authoritative detector of any further reflow, so after a short
//    stable window under authority the reconcile hands off to it. The settle
//    window also gives a ~SETTLE-frame grace for a narrow landing right at the
//    visibility transition before the handoff.
// MAX_FRAMES (~3s at 60fps) guarantees termination for a pane that never
// becomes authoritative (a permanently-hidden background spawn) or never
// stabilizes; such panes re-fit via the resume-time path when shown.
const POST_SPAWN_RECONCILE_SETTLE_FRAMES = 8
const POST_SPAWN_RECONCILE_MAX_FRAMES = 180

export function reconcilePtySizeAcrossFrames(
  options: PtySizeReconcileOptions
): PtySizeReconcileHandle {
  let frame = 0
  // Counts consecutive unchanged frames observed *while authoritative*. Frames
  // measured while hidden never advance it, so a long hidden-wide mount window
  // cannot make the loop hand off the instant the pane becomes visible (before
  // the split has equalized) on a width it never confirmed under authority.
  let authoritativeStableFrames = 0
  let lastSentCols = options.spawnCols
  let lastSentRows = options.spawnRows
  let pendingFrame: number | null = null
  let cancelled = false

  const tick = (): void => {
    pendingFrame = null
    if (cancelled || !options.isAlive()) {
      return
    }
    frame += 1
    if (!options.isParked()) {
      const measured = options.measure()
      if (measured && measured.cols > 0 && measured.rows > 0) {
        if (measured.cols !== lastSentCols || measured.rows !== lastSentRows) {
          // Authoritative spawn-time correction: bypasses the visibility gate
          // the live onResize honors (but the caller still skips parked frames).
          // A real change resets the stability window so we wait for it to hold.
          options.resize(measured.cols, measured.rows)
          lastSentCols = measured.cols
          lastSentRows = measured.rows
          authoritativeStableFrames = 0
        } else if (options.isAuthoritative()) {
          // Only stability seen *under authority* counts toward handoff — a grid
          // that merely held steady while hidden is not a safe stopping point.
          authoritativeStableFrames += 1
        }
      }
      // A null/zero measurement makes no stability progress: layout isn't ready.
    }
    // Why authoritative-gated rather than a fixed frame floor: while the pane is
    // hidden the live onResize cannot forward, so the reconcile must keep
    // watching (and forwarding, since its resize bypasses the gate) for a late
    // layout settle. Once the pane has been visible AND its grid has held steady
    // for the settle window, the live onResize/ResizeObserver path owns any
    // further change, so we hand off. The hard cap guarantees termination.
    const settled = authoritativeStableFrames >= POST_SPAWN_RECONCILE_SETTLE_FRAMES
    if (!settled && frame < POST_SPAWN_RECONCILE_MAX_FRAMES) {
      pendingFrame = options.requestFrame(tick)
    }
  }

  pendingFrame = options.requestFrame(tick)

  return {
    cancel: () => {
      cancelled = true
      if (pendingFrame !== null) {
        options.cancelFrame(pendingFrame)
        pendingFrame = null
      }
    }
  }
}
