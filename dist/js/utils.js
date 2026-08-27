/**
 * utils.js — Shared utility functions
 */

const DshUtils = {
  /**
   * Show a view by ID, hiding all others.
   * @param {string} viewId
   */
  showView(viewId) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'))
    const view = document.getElementById(viewId)
    if (view) view.classList.add('active')
  },

  /**
   * Format milliseconds to human-readable uptime.
   * @param {number} ms
   * @returns {string}
   */
  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000)
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60

    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
    if (minutes > 0) return `${minutes}m ${secs}s`
    return `${secs}s`
  },

  /**
   * Format ISO date string to localized string.
   * @param {string} iso
   * @returns {string}
   */
  formatDate(iso) {
    try {
      const d = new Date(iso)
      return d.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return iso
    }
  },

  /**
   * Escape HTML to prevent XSS.
   * @param {string} text
   * @returns {string}
   */
  escapeHtml(text) {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  },

  /**
   * Debounce a function.
   * @param {Function} fn
   * @param {number} delay
   * @returns {Function}
   */
  debounce(fn, delay = 300) {
    let timer
    return (...args) => {
      clearTimeout(timer)
      timer = setTimeout(() => fn(...args), delay)
    }
  },

  /**
   * Set the status badge UI.
   * @param {string} status - "running" | "stopped" | "unknown"
   * @param {string} text
   */
  setStatusBadge(status, text) {
    const badge = document.getElementById('server-status-badge')
    if (!badge) return
    const dot = badge.querySelector('.status-dot')
    const label = badge.querySelector('.status-text')
    if (dot) {
      dot.className = `status-dot status-${status}`
    }
    if (label) {
      label.textContent = text
    }
  },

  /**
   * Apply dark/light theme based on uTools setting.
   */
  applyTheme() {
    if (typeof utools !== 'undefined' && utools.isDarkColors) {
      const isDark = utools.isDarkColors()
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
    }
  },

  /**
   * Show a notification via uTools.
   * @param {string} body
   * @param {string} [featureCode]
   */
  notify(body, featureCode) {
    if (typeof utools !== 'undefined' && utools.showNotification) {
      utools.showNotification(body, featureCode)
    }
  },

  /**
   * Copy text to clipboard via uTools.
   * @param {string} text
   */
  copyToClipboard(text) {
    if (typeof utools !== 'undefined' && utools.copyText) {
      utools.copyText(text)
    } else {
      navigator.clipboard.writeText(text)
    }
  },

  /**
   * Show an error panel with message and suggestions.
   * @param {string} title
   * @param {string} message
   * @param {string[]} suggestions
   */
  showError(title, message, suggestions = []) {
    const panel = document.getElementById('error-panel')
    const configPanel = document.getElementById('server-config-panel')
    const infoPanel = document.getElementById('server-info-panel')

    document.getElementById('error-title').textContent = title
    document.getElementById('error-message').textContent = message

    const suggestionsEl = document.getElementById('error-suggestions')
    if (suggestions.length > 0) {
      suggestionsEl.innerHTML = '<ul>' + suggestions.map((s) => `<li>${this.escapeHtml(s)}</li>`).join('') + '</ul>'
    } else {
      suggestionsEl.innerHTML = ''
    }

    if (panel) panel.style.display = 'block'
    if (configPanel) configPanel.style.display = 'none'
    if (infoPanel) infoPanel.style.display = 'none'
  },

  /**
   * Hide the error panel.
   */
  hideError() {
    const panel = document.getElementById('error-panel')
    if (panel) panel.style.display = 'none'
  },

  /**
   * Open a folder selection dialog via uTools showOpenDialog.
   * @returns {string|null}
   */
  selectFolder() {
    // Use preload.js bridge — uTools provides utools.showOpenDialog (sync)
    if (window.dsh && window.dsh.fs && window.dsh.fs.showOpenDialog) {
      return window.dsh.fs.showOpenDialog()
    }
    return null
  },

  /**
   * Get a system path via uTools.
   * @param {string} name - "desktop" | "documents" | "downloads" | "home"
   * @returns {string}
   */
  getSystemPath(name) {
    if (typeof utools !== 'undefined' && utools.getPath) {
      try {
        return utools.getPath(name)
      } catch {
        return ''
      }
    }
    return ''
  },

  /** @private Overlay element for click-outside-to-close */
  _cmOverlay: null,

  /**
   * Show a custom right-click context menu.
   *
   * Uses an invisible overlay div (z-index below the menu) to capture
   * all clicks/touches outside the menu. This is more reliable than
   * document-level mousedown listeners, which can be blocked by
   * stopPropagation or iframe boundaries.
   *
   * @param {number} x - Client X coordinate
   * @param {number} y - Client Y coordinate
   * @param {Array<{icon?: string, label?: string, shortcut?: string, action?: Function, disabled?: boolean, separator?: boolean}>} items
   */
  showContextMenu(x, y, items) {
    this.hideContextMenu()
    const menu = document.getElementById('context-menu')
    if (!menu) return

    // ── Build menu HTML ──
    let html = ''
    for (const item of items || []) {
      if (item.separator) {
        html += '<div class="context-menu-sep"></div>'
        continue
      }
      const disabled = item.disabled ? ' disabled' : ''
      const label = item.label !== undefined && item.label !== null ? item.label : ''
      const shortcut = item.shortcut ? `<span class="cm-shortcut">${this.escapeHtml(item.shortcut)}</span>` : ''
      html += `<div class="context-menu-item${disabled}">`
      html += `<span class="cm-icon">${item.icon || ''}</span>`
      html += `<span class="cm-label">${this.escapeHtml(label)}</span>`
      html += shortcut
      html += '</div>'
    }
    menu.innerHTML = html
    menu.style.display = 'block'

    // ── Position menu within viewport ──
    const rect = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x
    let top = y
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'

    // ── Create invisible overlay to capture outside clicks ──
    // z-index 9998 (below menu's 9999) so the menu stays clickable.
    const overlay = document.createElement('div')
    overlay.className = 'context-menu-overlay'
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:9998;background:transparent;'
    // mousedown on overlay = click outside menu → close
    overlay.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.hideContextMenu()
    })
    // contextmenu on overlay = right-click outside → close + let native menu show
    overlay.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.hideContextMenu()
    })
    // touchstart for mobile / touchscreens
    overlay.addEventListener('touchstart', (e) => {
      e.preventDefault()
      this.hideContextMenu()
    }, { passive: false })
    document.body.appendChild(overlay)
    this._cmOverlay = overlay

    // ── Bind item actions ──
    const flatItems = (items || []).filter((i) => !i.separator)
    const itemEls = menu.querySelectorAll('.context-menu-item')
    itemEls.forEach((el, idx) => {
      // Use mousedown so the action fires before the overlay's mousedown
      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const item = flatItems[idx]
        if (item && !item.disabled && typeof item.action === 'function') {
          this.hideContextMenu()
          // Defer action to after menu is hidden
          setTimeout(() => item.action(), 0)
        }
      })
    })
  },

  /**
   * Hide the context menu and remove its overlay.
   */
  hideContextMenu() {
    const menu = document.getElementById('context-menu')
    if (menu) {
      menu.style.display = 'none'
      menu.innerHTML = ''
    }
    if (this._cmOverlay) {
      this._cmOverlay.remove()
      this._cmOverlay = null
    }
  },

  /**
   * Global handler: hide context menu on Escape / blur.
   * (Outside-click dismissal is handled by the overlay in showContextMenu.)
   */
  initContextMenu() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hideContextMenu()
    })
    window.addEventListener('blur', () => this.hideContextMenu())
    // Scroll/resize also dismisses (position would be stale)
    window.addEventListener('resize', () => this.hideContextMenu())
    document.addEventListener('scroll', () => this.hideContextMenu(), true)
  },
}

// 显式挂载到 window，确保 onclick 内联事件能访问
window.DshUtils = DshUtils

// Apply theme on load
DshUtils.applyTheme()

// Global context-menu dismissal (click / contextmenu / Escape / blur)
DshUtils.initContextMenu()
