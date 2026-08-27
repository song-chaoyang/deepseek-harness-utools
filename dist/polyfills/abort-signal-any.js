/**
 * AbortSignal.any polyfill.
 *
 * Some DSH runtime dependencies (gaxios, @earendil-works/pi-ai, dsh-llm-* etc.)
 * rely on `AbortSignal.any([...])` which is missing on older Node / uTools'
 * embedded runtime. This file is injected into the spawned DSH server process
 * via NODE_OPTIONS=--require. It is a guarded no-op where native support exists.
 *
 * CommonJS-compatible so it can be loaded with `--require`.
 */

;(function installAbortSignalAny() {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    // Native implementation available — nothing to do.
    return
  }

  if (typeof AbortSignal === 'undefined') return

  /**
   * Return an AbortSignal that aborts when any of the child signals aborts.
   * Mirrors the semantics of the native AbortSignal.any():
   *   - throws TypeError if the argument is not iterable or a member is not a signal
   *   - the returned signal inherits the first child signal's abort reason
   *   - if a child is already aborted, the returned signal is aborted immediately
   *   - listeners are cleaned up once the returned signal aborts
   * @param {Iterable<AbortSignal>} iterable
   * @returns {AbortSignal}
   */
  AbortSignal.any = function any(iterable) {
    if (iterable == null || typeof iterable[Symbol.iterator] !== 'function') {
      throw new TypeError('AbortSignal.any requires an iterable of AbortSignals')
    }

    const controller = new AbortController()
    const signals = Array.from(iterable)

    // A signal is already aborted -> abort immediately and inherit its reason.
    for (const signal of signals) {
      if (!(signal instanceof AbortSignal)) {
        throw new TypeError('AbortSignal.any expects an iterable of AbortSignal instances')
      }
      if (signal.aborted) {
        controller.abort(signal.reason)
        return controller.signal
      }
    }

    let done = false

    const abortListener = (event) => {
      if (done) return
      done = true
      const source = event.target
      // Clean up all listeners attached to children.
      for (const child of signals) {
        child.removeEventListener('abort', abortListener)
      }
      controller.abort(source && source.reason)
    }

    for (const signal of signals) {
      signal.addEventListener('abort', abortListener, { once: true })
    }

    return controller.signal
  }
})()
