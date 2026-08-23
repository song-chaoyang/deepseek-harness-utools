/**
 * web-ui.js — DSH Web UI iframe container.
 *
 * Loads the DSH Web UI in an iframe inside uTools, handles loading states,
 * auto-reconnect, and toolbar actions.
 */

const WebUI = {
  /** Whether the Web UI is currently loaded */
  loaded: false,

  /** Auto-reconnect timer */
  reconnectTimer: null,

  /** Load timeout timer */
  loadTimeout: null,

  /** Log panel polling timer */
  logTimer: null,

  /** Log panel cursor */
  logCursor: 0,

  /**
   * Open the Web UI view.
   */
  open() {
    const status = window.dsh.server.getStatus()
    if (!status.running) {
      // Server not running — show config panel so user can start it
      DshUtils.showView('view-server-manager')
      ServerManager.showConfigPanel()
      DshUtils.setStatusBadge('stopped', '未运行')
      return
    }

    DshUtils.showView('view-web-ui')
    // Use a large height — 0 would close the uTools window
    if (typeof utools !== 'undefined' && utools.setExpendHeight) {
      utools.setExpendHeight(800)
    }
    this.load()
  },

  /**
   * Load the DSH Web UI in the iframe.
   */
  load() {
    const iframe = document.getElementById('dsh-iframe')
    const loading = document.getElementById('web-ui-loading')
    const urlDisplay = document.getElementById('web-ui-url-display')

    if (!iframe) return

    const url = window.dsh.server.getServerUrl()
    urlDisplay.textContent = url

    // Show loading
    loading.style.display = 'flex'
    iframe.style.display = 'none'
    this.loaded = false

    // Clear any previous timeout
    if (this.loadTimeout) clearTimeout(this.loadTimeout)

    // Set up load handler
    iframe.onload = () => {
      if (this.loadTimeout) clearTimeout(this.loadTimeout)
      loading.style.display = 'none'
      iframe.style.display = 'block'
      this.loaded = true
      this.stopReconnect()
    }

    // Set a generous timeout — DSH Web UI is a large SPA, first load can be slow
    this.loadTimeout = setTimeout(() => {
      if (!this.loaded) {
        // Check if server is still running
        const status = window.dsh.server.getStatus()
        if (status.running) {
          // Server is up but iframe didn't fire onload — just show it anyway
          loading.style.display = 'none'
          iframe.style.display = 'block'
          this.loaded = true
        } else {
          this.handleLoadError()
        }
      }
    }, 15000)

    // Load the URL
    iframe.src = url
  },

  /**
   * Handle iframe load error (server not responding).
   */
  handleLoadError() {
    this.stopReconnect()

    const status = window.dsh.server.getStatus()
    if (!status.running) {
      DshUtils.showView('view-server-manager')
      ServerManager.showConfigPanel()
      DshUtils.setStatusBadge('stopped', '已停止')
      return
    }

    // Server is running but iframe didn't load — try health check
    window.dsh.server.healthCheck().then(({ healthy }) => {
      if (healthy) {
        this.load()
      } else {
        this.startReconnect()
      }
    })
  },

  /**
   * Start auto-reconnect timer.
   */
  startReconnect() {
    this.stopReconnect()
    const loading = document.getElementById('web-ui-loading')
    const loadingText = loading?.querySelector('.loading-text')
    if (loadingText) {
      loadingText.textContent = '正在等待服务器响应...'
    }
    loading.style.display = 'flex'

    let attempt = 0
    this.reconnectTimer = setInterval(async () => {
      attempt++
      const { healthy } = await window.dsh.server.healthCheck()
      if (healthy) {
        this.stopReconnect()
        this.load()
        return
      }

      if (attempt > 30) {
        this.stopReconnect()
        DshUtils.showView('view-server-manager')
        DshUtils.setStatusBadge('stopped', '连接超时')
        DshUtils.showError(
          '连接超时',
          '无法连接到 DSH 服务器。服务器可能已崩溃或正在重启。',
          [
            '检查服务器状态',
            '尝试重启服务器',
          ],
        )
      }
    }, 1000)
  },

  /**
   * Stop auto-reconnect timer.
   */
  stopReconnect() {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer)
      this.reconnectTimer = null
    }
  },

  /**
   * Refresh the iframe.
   */
  refresh() {
    const iframe = document.getElementById('dsh-iframe')
    if (iframe) {
      iframe.src = iframe.src
    }
  },

  /**
   * Open the DSH Web UI in the system's default browser.
   */
  openExternal() {
    const url = window.dsh.server.getServerUrl()
    if (typeof utools !== 'undefined' && utools.shellOpenExternal) {
      utools.shellOpenExternal(url)
    }
  },

  /**
   * Toggle the log panel visibility (delegates to global DshUtils).
   */
  toggleLogs() {
    DshUtils.toggleLogPanel()
    // If opening and server is running, start polling server stdout/stderr
    const panel = document.getElementById('log-panel')
    if (panel && panel.style.display === 'flex') {
      this.startLogPolling()
    } else {
      this.stopLogPolling()
    }
  },

  /**
   * Start polling server stdout/stderr into the global log.
   */
  startLogPolling() {
    this.stopLogPolling()
    this.logTimer = setInterval(() => this.pollServerLogs(), 1000)
  },

  /**
   * Stop polling logs.
   */
  stopLogPolling() {
    if (this.logTimer) {
      clearInterval(this.logTimer)
      this.logTimer = null
    }
  },

  /**
   * Poll server stdout/stderr and append to global log buffer.
   */
  pollServerLogs() {
    let text = ''
    try {
      text = (window.dsh.server.getStdout(200) || '') + (window.dsh.server.getStderr(200) || '')
    } catch { return }
    const fresh = text.slice(this.logCursor)
    if (fresh) {
      this.logCursor = text.length
      const level = /error|Error|ERROR/i.test(fresh) ? 'error' : /warn|Warn|WARN/i.test(fresh) ? 'warn' : 'info'
      DshUtils.log(fresh.trimEnd(), level)
    }
  },

  /**
   * Clear the log panel (delegates to global DshUtils).
   */
  clearLogs() {
    DshUtils.clearLogs()
  },

  /**
   * Initialize event listeners.
   */
  init() {
    const btnBack = document.getElementById('btn-back-to-manager')
    if (btnBack) {
      btnBack.addEventListener('click', () => {
        DshUtils.showView('view-server-manager')
        if (typeof utools !== 'undefined' && utools.setExpendHeight) {
          utools.setExpendHeight(600)
        }
        ServerManager.showServerInfo()
      })
    }

    const btnRefresh = document.getElementById('btn-refresh-webui')
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => this.refresh())
    }

    const btnExternal = document.getElementById('btn-open-external')
    if (btnExternal) {
      btnExternal.addEventListener('click', () => this.openExternal())
    }

    const btnLogs = document.getElementById('btn-show-logs')
    if (btnLogs) {
      btnLogs.addEventListener('click', () => this.toggleLogs())
    }

    const btnCloseLogs = document.getElementById('btn-close-logs')
    if (btnCloseLogs) {
      btnCloseLogs.addEventListener('click', () => this.toggleLogs())
    }

    const btnClearLogs = document.getElementById('btn-clear-logs')
    if (btnClearLogs) {
      btnClearLogs.addEventListener('click', () => this.clearLogs())
    }

    const btnMarket = document.getElementById('btn-dsh-market-webui')
    if (btnMarket) {
      btnMarket.addEventListener('click', () => {
        if (typeof utools !== 'undefined' && utools.shellOpenExternal) {
          utools.shellOpenExternal('https://dsh-market.com/')
        }
      })
    }
  },
}

document.addEventListener('DOMContentLoaded', () => {
  WebUI.init()
})
