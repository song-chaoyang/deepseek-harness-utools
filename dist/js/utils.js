/**
 * utils.js — Shared utility functions
 */

const DshUtils = {
  /** Global log entries buffer */
  _logEntries: [],
  _logMax: 500,
  _logPanelOpen: false,

  /**
   * Append a log entry. Visible in the global log panel.
   * @param {string} text
   * @param {string} [level] - 'info' | 'error' | 'warn'
   */
  log(text, level = 'info') {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const entry = { ts, text, level }
    this._logEntries.push(entry)
    if (this._logEntries.length > this._logMax) this._logEntries.shift()

    // If log panel is open, append directly
    if (this._logPanelOpen) {
      this._appendLogToPanel(entry)
    }
  },

  /**
   * Append one entry to the log panel DOM.
   */
  _appendLogToPanel(entry) {
    const logEl = document.getElementById('log-content')
    if (!logEl) return
    const cls = entry.level === 'error' ? 'log-error' : entry.level === 'warn' ? 'log-warn' : ''
    const escaped = this.escapeHtml(entry.text)
    const colored = escaped
      .replace(/(error|Error|ERROR)/g, '<span class="log-error">$1</span>')
      .replace(/(warn|Warn|WARN)/g, '<span class="log-warn">$1</span>')
    logEl.innerHTML += `<span class="log-ts">[${entry.ts}]</span> ${colored}\n`
    // Cap DOM size
    if (logEl.innerHTML.length > 50000) {
      logEl.innerHTML = logEl.innerHTML.slice(-50000)
    }
    logEl.scrollTop = logEl.scrollHeight
  },

  /**
   * Render all buffered logs into the panel (called on open).
   */
  _renderAllLogs() {
    const logEl = document.getElementById('log-content')
    if (!logEl) return
    logEl.innerHTML = ''
    for (const entry of this._logEntries) {
      this._appendLogToPanel(entry)
    }
  },

  /**
   * Toggle the global log panel.
   */
  toggleLogPanel() {
    const panel = document.getElementById('log-panel')
    if (!panel) return
    if (panel.style.display === 'flex') {
      this._logPanelOpen = false
      panel.style.display = 'none'
    } else {
      this._logPanelOpen = true
      this._renderAllLogs()
      panel.style.display = 'flex'
    }
  },

  /**
   * Clear the log panel and buffer.
   */
  clearLogs() {
    this._logEntries = []
    const logEl = document.getElementById('log-content')
    if (logEl) logEl.innerHTML = ''
  },

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
}

// Apply theme on load
DshUtils.applyTheme()
