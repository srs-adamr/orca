/* eslint-disable max-lines -- Why: PaneManager intentionally co-locates pane lifecycle, identity (stablePaneId), and the cross-boundary callbacks that wire those into the store mirror; splitting would scatter logic that has exactly one consumer. */
import type {
  PaneManagerOptions,
  PaneStyleOptions,
  ManagedPane,
  ManagedPaneInternal,
  DropZone
} from './pane-manager-types'
import {
  createDivider,
  applyDividerStyles,
  applyPaneOpacity,
  applyRootBackground
} from './pane-divider'
import {
  createDragReorderState,
  hideDropOverlay,
  handlePaneDrop,
  updateMultiPaneState
} from './pane-drag-reorder'
import {
  createPaneDOM,
  openTerminal,
  attachWebgl,
  disposeWebgl,
  setLigaturesEnabled,
  disposePane
} from './pane-lifecycle'
import { shouldFollowMouseFocus } from './focus-follows-mouse'
import {
  findPaneChildren,
  removeDividers,
  promoteSibling,
  wrapInSplit,
  safeFit,
  fitAllPanesInternal,
  captureScrollState,
  refitPanesUnder
} from './pane-tree-ops'
import { scheduleSplitScrollRestore } from './pane-split-scroll'
import { toPublicPane } from './pane-public-view'
import { applyTerminalGpuAcceleration } from './pane-terminal-gpu-acceleration'
import { reattachWebglIfNeeded } from './pane-webgl-reattach'
import { mintStablePaneId } from './mint-stable-pane-id'
import { isStablePaneId } from '../../../../shared/stable-pane-id'

export type { PaneManagerOptions, PaneStyleOptions, ManagedPane, DropZone }

export class PaneManager {
  private root: HTMLElement
  private panes: Map<number, ManagedPaneInternal> = new Map()
  private activePaneId: number | null = null
  private nextPaneId = 1
  private options: PaneManagerOptions
  private styleOptions: PaneStyleOptions = {}
  private destroyed = false
  private renderingSuspended: boolean
  // Why: stablePaneId is the cross-boundary identity for paneKey,
  // ORCA_PANE_KEY, and persisted layout snapshots. Mirror the
  // numeric↔stable mapping here so getNumericIdForStable resolves in
  // O(1) without iterating panes.
  private stableIdByNumericId: Map<number, string> = new Map()
  private numericIdByStableId: Map<string, number> = new Map()

  // Drag-to-reorder state
  private dragState = createDragReorderState()

  constructor(root: HTMLElement, options: PaneManagerOptions) {
    this.root = root
    this.options = options
    this.renderingSuspended = options.initialRenderingSuspended === true
  }

  createInitialPane(opts?: { focus?: boolean; stablePaneIdHint?: string }): ManagedPane {
    // Why: layout replay passes the snapshot's stablePaneId at mint time so
    // onPaneCreated → connectPanePty captures the correct cacheKey synchronously.
    // See replayTerminalLayout for context.
    const pane = this.createPaneInternal(opts?.stablePaneIdHint)
    Object.assign(pane.container.style, {
      width: '100%',
      height: '100%',
      position: 'relative',
      overflow: 'hidden'
    })
    this.root.appendChild(pane.container)
    openTerminal(pane)
    this.activePaneId = pane.id
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)

    if (opts?.focus !== false) {
      pane.terminal.focus()
    }

    void this.options.onPaneCreated?.(toPublicPane(pane))
    return toPublicPane(pane)
  }

  splitPane(
    paneId: number,
    direction: 'vertical' | 'horizontal',
    opts?: { ratio?: number; cwd?: string; stablePaneIdHint?: string }
  ): ManagedPane | null {
    const existing = this.panes.get(paneId)
    if (!existing) {
      return null
    }
    const parent = existing.container.parentElement
    if (!parent) {
      return null
    }
    // Why: layout replay passes the snapshot's stablePaneId at mint time so
    // onPaneCreated → connectPanePty captures the correct cacheKey synchronously.
    // See replayTerminalLayout for context.
    const newPane = this.createPaneInternal(opts?.stablePaneIdHint)

    const isVertical = direction === 'vertical'
    const divider = this.createDividerWrapped(isVertical)

    // Why: wrapInSplit reparents the existing container, resetting scrollTop.
    const scrollState = captureScrollState(existing.terminal)
    // Why: lock prevents safeFit/fitAllPanes from restoring scroll during
    // the async settle window — scheduleSplitScrollRestore owns the restore.
    existing.pendingSplitScrollState = scrollState

    // Why: DOM reparenting can silently invalidate a WebGL context without
    // firing contextlost — Chromium reclaims the oldest context near its
    // ~8–16 limit. Dispose before the move, reattach in the 200ms timer.
    const hadWebgl = !!existing.webglAddon
    disposeWebgl(existing)

    wrapInSplit(existing.container, newPane.container, isVertical, divider, opts)

    openTerminal(newPane)
    this.activePaneId = newPane.id
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)
    applyDividerStyles(this.root, this.styleOptions)
    newPane.terminal?.focus()
    updateMultiPaneState(this.getDragCallbacks())
    // Why: forward cwd hint so the new PTY spawns in the source pane's cwd.
    void this.options.onPaneCreated?.(
      toPublicPane(newPane),
      opts?.cwd ? { cwd: opts.cwd } : undefined
    )
    this.options.onLayoutChanged?.()

    const reattach = hadWebgl ? reattachWebglIfNeeded : undefined
    scheduleSplitScrollRestore(
      (id) => this.panes.get(id),
      existing.id,
      scrollState,
      () => this.destroyed,
      reattach
    )

    return toPublicPane(newPane)
  }

  closePane(paneId: number): void {
    const pane = this.panes.get(paneId)
    if (!pane) {
      return
    }
    // Why: clean up stableId state FIRST so an early-return below (e.g. detached
    // container) still releases the pane's mirror entry. The DOM-layout cleanup
    // below is purely cosmetic for an already-orphaned container.
    const closedStableId = pane.stablePaneId
    this.stableIdByNumericId.delete(paneId)
    if (closedStableId) {
      this.numericIdByStableId.delete(closedStableId)
    }
    this.options.onStableIdReleased?.(paneId, closedStableId)
    const paneContainer = pane.container
    const parent = paneContainer.parentElement
    disposePane(pane, this.panes)
    // Why: only the DOM-layout shuffling depends on a non-null parent. Active
    // pane reassignment + onPaneClosed + onLayoutChanged must run on both
    // paths so the lifecycle hook can persist the post-close layout snapshot
    // and consumers don't observe activePaneId pointing at a disposed pane.
    if (parent) {
      if (parent.classList.contains('pane-split')) {
        const siblings = findPaneChildren(parent)
        const sibling = siblings.find((c) => c !== paneContainer) ?? null
        paneContainer.remove()
        removeDividers(parent)
        promoteSibling(sibling, parent, this.root)
      } else {
        paneContainer.remove()
      }
    }
    if (this.activePaneId === paneId) {
      const next = this.panes.values().next().value as ManagedPaneInternal | undefined
      this.activePaneId = next?.id ?? null
      next?.terminal.focus()
    }
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)
    for (const p of this.panes.values()) {
      safeFit(p)
    }
    updateMultiPaneState(this.getDragCallbacks())
    this.options.onPaneClosed?.(paneId, closedStableId ?? null)
    this.options.onLayoutChanged?.()
  }

  getPanes(): ManagedPane[] {
    return Array.from(this.panes.values()).map(toPublicPane)
  }

  fitAllPanes(): void {
    fitAllPanesInternal(this.panes)
  }

  getActivePane(): ManagedPane | null {
    if (this.activePaneId === null) {
      return null
    }
    const pane = this.panes.get(this.activePaneId)
    return pane ? toPublicPane(pane) : null
  }

  setActivePane(paneId: number, opts?: { focus?: boolean }): void {
    const pane = this.panes.get(paneId)
    if (!pane) {
      return
    }
    const changed = this.activePaneId !== paneId
    this.activePaneId = paneId
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)

    if (opts?.focus !== false) {
      pane.terminal.focus()
    }

    if (changed) {
      this.options.onActivePaneChange?.(toPublicPane(pane))
    }
  }

  setPaneStyleOptions(opts: PaneStyleOptions): void {
    this.styleOptions = { ...opts }
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)
    applyDividerStyles(this.root, this.styleOptions)
    applyRootBackground(this.root, this.styleOptions)
  }

  setPaneLigaturesEnabled(paneId: number, enabled: boolean): void {
    const pane = this.panes.get(paneId)
    if (!pane) {
      return
    }
    setLigaturesEnabled(pane, enabled)
  }

  setPaneGpuRendering(paneId: number, enabled: boolean): void {
    const pane = this.panes.get(paneId)
    if (!pane) {
      return
    }
    pane.gpuRenderingEnabled = enabled
    if (!enabled) {
      disposeWebgl(pane, { refreshDimensions: true })
      return
    }
    if (pane.webglAttachmentDeferred || pane.webglDisabledAfterContextLoss) {
      return
    }
    if (!pane.webglAddon) {
      attachWebgl(pane)
      safeFit(pane)
    }
  }

  setTerminalGpuAcceleration(mode: PaneManagerOptions['terminalGpuAcceleration']): void {
    applyTerminalGpuAcceleration(this.panes.values(), this.options, mode)
  }

  suspendRendering(): void {
    this.renderingSuspended = true
    for (const pane of this.panes.values()) {
      pane.webglAttachmentDeferred = true
      disposeWebgl(pane)
    }
  }

  resumeRendering(): void {
    this.renderingSuspended = false
    for (const pane of this.panes.values()) {
      pane.webglAttachmentDeferred = false
      reattachWebglIfNeeded(pane)
      // Why: fresh WebGL canvas has no content — refresh prevents frozen terminal.
      if (pane.webglAddon) {
        try {
          pane.terminal.refresh(0, pane.terminal.rows - 1)
        } catch {
          /* ignore */
        }
      }
    }
  }

  movePane(sourcePaneId: number, targetPaneId: number, zone: DropZone): void {
    handlePaneDrop(sourcePaneId, targetPaneId, zone, this.dragState, this.getDragCallbacks())
  }

  destroy(): void {
    this.destroyed = true
    hideDropOverlay(this.dragState)
    const releasedEntries = Array.from(this.stableIdByNumericId.entries())
    for (const pane of this.panes.values()) {
      disposePane(pane, this.panes)
    }
    this.stableIdByNumericId.clear()
    this.numericIdByStableId.clear()
    this.root.innerHTML = ''
    this.activePaneId = null
    if (this.options.onStableIdReleased) {
      for (const [numericId, stableId] of releasedEntries) {
        this.options.onStableIdReleased(numericId, stableId)
      }
    }
  }

  private createPaneInternal(stablePaneIdHint?: string): ManagedPaneInternal {
    const id = this.nextPaneId++
    // Why: when layout replay supplies the snapshot's UUID at mint time, the
    // pane is born with its persisted identity. This eliminates the race where
    // adoptStablePaneId-after-mint would lose to onPaneCreated → connectPanePty
    // capturing the freshly-minted UUID synchronously. Fall back to mint when
    // no hint, when the hint isn't a valid v4 UUID, or when it's already bound
    // to another live pane (corrupt snapshot / sibling collision).
    const stablePaneId =
      stablePaneIdHint &&
      isStablePaneId(stablePaneIdHint) &&
      !this.numericIdByStableId.has(stablePaneIdHint)
        ? stablePaneIdHint
        : mintStablePaneId()
    const pane = createPaneDOM(
      id,
      stablePaneId,
      this.options,
      this.dragState,
      this.getDragCallbacks(),
      // Why: always re-focus even if already active — after splits the
      // browser's real textarea focus can lag the manager's activePaneId.
      (paneId) => {
        if (!this.destroyed) {
          this.setActivePane(paneId, { focus: true })
        }
      },
      (paneId, event) => {
        this.handlePaneMouseEnter(paneId, event)
      }
    )
    pane.webglAttachmentDeferred = this.renderingSuspended
    this.panes.set(id, pane)
    this.stableIdByNumericId.set(id, stablePaneId)
    this.numericIdByStableId.set(stablePaneId, id)
    this.options.onStableIdRegistered?.(id, stablePaneId)
    return pane
  }

  /** Look up a pane's UUID by its renderer-local numeric id. */
  getStablePaneId(numericId: number): string | null {
    return this.stableIdByNumericId.get(numericId) ?? null
  }

  /** Look up a pane's renderer-local numeric id by its UUID. Returns null
   *  when the UUID is unknown (closed pane, legacy snapshot, or a paneKey
   *  minted before the upgrade). */
  getNumericIdForStable(stablePaneId: string): number | null {
    return this.numericIdByStableId.get(stablePaneId) ?? null
  }

  /** Reattach a previously-persisted UUID to a freshly created pane during
   *  layout replay. Replaces whatever UUID createPaneInternal minted so the
   *  cross-boundary identity (paneKey, ORCA_PANE_KEY) is preserved across
   *  reloads. Safe no-op when the snapshot's UUID equals the just-minted one. */
  adoptStablePaneId(numericId: number, stablePaneId: string): void {
    const pane = this.panes.get(numericId)
    if (!pane) {
      return
    }
    // Why: snapshots can carry corrupt non-UUID values (e.g. legacy or
    // hand-edited). Reject here so the manager's invariant — every entry
    // in numericIdByStableId is a v4 UUID — holds even when callers
    // bypass createPaneInternal's mint-time validation.
    if (!isStablePaneId(stablePaneId)) {
      return
    }
    const previousStable = pane.stablePaneId
    if (previousStable === stablePaneId) {
      return
    }
    const conflictingNumericId = this.numericIdByStableId.get(stablePaneId)
    if (conflictingNumericId !== undefined && conflictingNumericId !== numericId) {
      // Why: snapshot UUID is already mapped to a different live pane (corrupt
      // snapshot or sibling-collision). Bail BEFORE mutating either map so the
      // pane keeps its previously-minted UUID intact; any retained agent rows
      // under the conflicting key will surface as stale on click via
      // surfaceStaleAgentRow rather than silently rerouting.
      return
    }
    if (previousStable) {
      this.numericIdByStableId.delete(previousStable)
    }
    pane.stablePaneId = stablePaneId
    this.stableIdByNumericId.set(numericId, stablePaneId)
    this.numericIdByStableId.set(stablePaneId, numericId)
    this.options.onStableIdAdopted?.(numericId, stablePaneId, previousStable)
  }

  /** Return a fresh Map snapshot of numericId → stablePaneId for layout
   *  serialization. Why fresh: the caller may persist asynchronously while
   *  panes close, and a live view would mutate under them. */
  getStablePaneIdMap(): ReadonlyMap<number, string> {
    return new Map(this.stableIdByNumericId)
  }

  private handlePaneMouseEnter(paneId: number, event: MouseEvent): void {
    if (
      shouldFollowMouseFocus({
        featureEnabled: this.styleOptions.focusFollowsMouse ?? false,
        activePaneId: this.activePaneId,
        hoveredPaneId: paneId,
        mouseButtons: event.buttons,
        windowHasFocus: document.hasFocus(),
        managerDestroyed: this.destroyed
      })
    ) {
      this.setActivePane(paneId, { focus: true })
    }
  }

  private createDividerWrapped(isVertical: boolean): HTMLElement {
    return createDivider(isVertical, this.styleOptions, {
      refitPanesUnder: (el) => refitPanesUnder(el, this.panes),
      onLayoutChanged: this.options.onLayoutChanged
    })
  }

  private getDragCallbacks() {
    return {
      getPanes: () => this.panes,
      getRoot: () => this.root,
      getStyleOptions: () => this.styleOptions,
      isDestroyed: () => this.destroyed,
      safeFit,
      applyPaneOpacity: () =>
        applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions),
      applyDividerStyles: () => applyDividerStyles(this.root, this.styleOptions),
      refitPanesUnder: (el: HTMLElement) => refitPanesUnder(el, this.panes),
      onLayoutChanged: this.options.onLayoutChanged
    }
  }
}
