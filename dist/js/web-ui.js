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

  /** Last URL opened externally (dedup guard) */
  lastExternalOpenUrl: null,

  /** Timestamp of the last external open (dedup guard) */
  lastExternalOpenTime: 0,

  /**
   * Clear the iframe to stop it from making requests to a dead server.
   * Called before stop/restart to prevent ERR_CONNECTION_REFUSED errors.
   */
  unload() {
    const iframe = document.getElementById('dsh-iframe')
    if (iframe) {
      iframe.removeAttribute('src')
      iframe.src = 'about:blank'
    }
    this.loaded = false
    this.stopReconnect()
    if (this.loadTimeout) {
      clearTimeout(this.loadTimeout)
      this.loadTimeout = null
    }
  },

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

    const url = window.dsh.server.getServerUrl()      // bridge URL (iframe)
    const directUrl = window.dsh.server.getDirectUrl() // real DSH URL (display)
    urlDisplay.textContent = directUrl || url

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
      this.injectLinkInterceptor(iframe)
      // Re-trigger preload-level webContents hook for the freshly loaded iframe
      if (window.dsh && window.dsh.hookIframeLinks) {
        window.dsh.hookIframeLinks()
      }
    }

    // Fallback: catch full-page navigations to external URLs (cross-origin)
    iframe.addEventListener('load', () => {
      try {
        const currentUrl = iframe.contentWindow.location.href
        const serverUrl = window.dsh.server.getServerUrl()
        if (currentUrl && !currentUrl.startsWith(serverUrl) && !currentUrl.startsWith('about:')) {
          WebUI.openExternalUrl(currentUrl)
          iframe.src = serverUrl
        }
      } catch (e) {
        // cross-origin — can't read location, the preload webContents hook handles it
      }
    })

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
   * Inject a click interceptor into the DSH iframe.
   * Intercepts <a target="_blank"> and external link clicks,
   * opening them in the system browser via utools.shellOpenExternal.
   * Uses postMessage to communicate (works same-origin only).
   * @param {HTMLIFrameElement} iframe
   */
  injectLinkInterceptor(iframe) {
    // Try direct DOM injection first (works if same-origin)
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document
      const serverUrl = window.dsh.server.getServerUrl()

      // Override window.open inside the iframe
      iframe.contentWindow.open = function (url) {
        if (url && !url.startsWith('about:')) {
          WebUI.openExternalUrl(url)
        }
        return null
      }

      // Capture click events for <a> tags
      doc.addEventListener('click', (e) => {
        const a = e.target.closest('a')
        if (!a || !a.href) return
        const href = a.href
        const target = a.target || ''
        // External link or target=_blank → open in system browser
        if (target === '_blank' || (!href.startsWith(serverUrl) && !href.startsWith('about:') && !href.startsWith('data:'))) {
          e.preventDefault()
          e.stopPropagation()
          WebUI.openExternalUrl(href)
          return false
        }
      }, true)

      console.log('[dsh] link interceptor injected (same-origin)')
    } catch (err) {
      // Cross-origin: can't inject directly.
      // The iframe 'load' listener in load() will catch external navigations
      // as a fallback.
      console.log('[dsh] cross-origin iframe, using fallback navigation interceptor')
    }
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
    const url = window.dsh.server.getDirectUrl()
    this.openExternalUrl(url)
  },

  /**
   * Open any URL in the system's default browser.
   * @param {string} url
   */
  openExternalUrl(url) {
    // Dedup: a single link click can reach this point via multiple layers
    // (bridge postMessage, setWindowOpenHandler, navigation fallback), which
    // previously opened the same URL 2-3 times. Collapse identical URLs that
    // arrive within a short window down to exactly one open.
    const now = Date.now()
    if (url && url === this.lastExternalOpenUrl && now - this.lastExternalOpenTime < 1000) {
      return
    }
    this.lastExternalOpenUrl = url
    this.lastExternalOpenTime = now

    // Prefer the preload-level openExternal: it is the single deduped choke
    // point shared by the bridge, setWindowOpenHandler, new-window, and the
    // navigation fallback, so every layer funnels into one shellOpenExternal.
    if (window.dsh && window.dsh.openExternal) {
      window.dsh.openExternal(url)
    } else if (typeof utools !== 'undefined' && utools.shellOpenExternal) {
      utools.shellOpenExternal(url)
    } else {
      // Last-resort: try Electron shell directly
      try {
        const { shell } = require('electron')
        if (shell && shell.openExternal) shell.openExternal(url)
      } catch {
        console.error('Cannot open URL externally:', url)
      }
    }
  },

  /**
   * Toggle the log panel visibility.
   */
  toggleLogs() {
    const panel = document.getElementById('log-panel')
    if (!panel) return
    if (panel.style.display === 'flex') {
      this.stopLogPolling()
      panel.style.display = 'none'
    } else {
      panel.style.display = 'flex'
      this.logCursor = 0
      this.startLogPolling()
    }
  },

  /**
   * Start polling server stdout/stderr into the log panel.
   */
  startLogPolling() {
    this.stopLogPolling()
    this.pollLogs()
    this.logTimer = setInterval(() => this.pollLogs(), 1000)
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
   * Poll server output and append to log panel.
   */
  pollLogs() {
    const logEl = document.getElementById('log-content')
    if (!logEl) return
    let text = ''
    try {
      text = (window.dsh.server.getStdout(2000) || '') + (window.dsh.server.getStderr(2000) || '')
    } catch { return }

    // If the buffer rolled over (text got shorter than the last cursor),
    // reset the cursor so we re-render the full available content.
    if (text.length < this.logCursor) {
      this.logCursor = 0
      logEl.innerHTML = ''
    }

    const fresh = text.slice(this.logCursor)
    if (fresh) {
      this.logCursor = text.length
      // Highlight errors and warnings
      const escaped = DshUtils.escapeHtml(fresh)
      const colored = escaped
        .replace(/(error|Error|ERROR)/g, '<span class="log-error">$1</span>')
        .replace(/(warn|Warn|WARN)/g, '<span class="log-warn">$1</span>')
      logEl.innerHTML += colored
      // Limit log panel content to ~200k chars to prevent memory bloat
      const maxChars = 200000
      if (logEl.innerHTML.length > maxChars) {
        // Compute the number of chars actually trimmed from the display and
        // subtract it from the cursor, so the next poll only appends new output
        // instead of re-appending the whole buffer (which permanently duplicates
        // the log once the display hits the cap).
        const trimmed = logEl.innerHTML.length - maxChars
        logEl.innerHTML = logEl.innerHTML.slice(-maxChars)
        this.logCursor = Math.max(0, this.logCursor - trimmed)
      }
      logEl.scrollTop = logEl.scrollHeight
    }
  },

  /**
   * Clear the log panel.
   */
  clearLogs() {
    const logEl = document.getElementById('log-content')
    if (logEl) logEl.innerHTML = ''
    // Advance cursor to current end so old buffered content is not re-shown
    let text = ''
    try {
      text = (window.dsh.server.getStdout(2000) || '') + (window.dsh.server.getStderr(2000) || '')
    } catch { /* ignore */ }
    this.logCursor = text.length
  },

  /**
   * Copy the current DSH server URL to clipboard.
   */
  copyUrl() {
    const url = window.dsh.server.getDirectUrl() || window.dsh.server.getServerUrl()
    if (typeof utools !== 'undefined' && utools.copyText) {
      utools.copyText(url)
    } else {
      navigator.clipboard?.writeText(url)
    }
    DshUtils?.notify('已复制地址: ' + url)
  },

  /**
   * Toggle fullscreen (maximize) the Web UI view.
   */
  toggleFullscreen() {
    if (typeof utools !== 'undefined' && utools.setExpendHeight) {
      const isMax = this._isMaximized
      if (isMax) {
        utools.setExpendHeight(800)
        this._isMaximized = false
      } else {
        // Fill the screen with the available window height — 0 would close the
        // uTools window instead of maximizing it.
        utools.setExpendHeight(Math.max(window.screen.availHeight || 800, 800))
        this._isMaximized = true
      }
    }
  },

  /**
   * Initialize event listeners.
   */
  init() {
    // init() runs both at load time (IIFE below) and on every
    // App.showMain() activation — guard so listeners are registered only once
    // (duplicate keydown handlers would make Ctrl+L / Ctrl+Shift+F toggle
    // twice in the same key event, i.e. appear dead).
    if (this._inited) return
    this._inited = true

    // Link bridge: the DSH iframe (via /__dsh_link_bridge.js injected by
    // the preload proxy) posts external-link clicks here so we can open
    // them in the system browser via utools.shellOpenExternal.
    window.addEventListener('message', (event) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      // Only accept messages from our own DSH iframe
      const iframe = document.getElementById('dsh-iframe')
      if (event.source && event.source !== (iframe && iframe.contentWindow)) return

      if (data.type === 'dsh-open-external' && data.url) {
        this.openExternalUrl(String(data.url))
      } else if (data.type === 'dsh-context-link') {
        // Right-click inside the DSH iframe → context menu.
        // With a URL: link actions; without: page-level actions.
        const status = window.dsh.server.getStatus()
        const items = []
        if (data.url) {
          items.push(
            {
              icon: '↗',
              label: '在浏览器中打开链接',
              action: () => this.openExternalUrl(String(data.url)),
            },
            {
              icon: '📋',
              label: '复制链接地址',
              action: () => DshUtils.copyToClipboard(String(data.url)),
            },
            { separator: true },
          )
        }
        items.push(
          {
            icon: '↻',
            label: '刷新页面',
            action: () => this.refresh(),
          },
          {
            icon: '🗔',
            label: '在浏览器中打开 Web UI',
            action: () => this.openExternal(),
          },
          { separator: true },
          {
            icon: '🗒',
            label: status.running ? '服务器日志 (Ctrl+L)' : '服务器日志',
            disabled: !status.running,
            action: () => this.toggleLogs(),
          },
          {
            icon: '🧹',
            label: '清空日志',
            action: () => this.clearLogs(),
          },
        )
        DshUtils.showContextMenu(data.clientX || 0, data.clientY || 0, items)
      }
    })

    // Keyboard shortcuts (only active in Web UI view)
    document.addEventListener('keydown', (e) => {
      const webUiView = document.getElementById('view-web-ui')
      if (!webUiView || !webUiView.classList.contains('active')) return

      // Ctrl/Cmd+R = refresh
      if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
        e.preventDefault()
        this.refresh()
      }
      // Ctrl/Cmd+Shift+F = toggle fullscreen
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'f') {
        e.preventDefault()
        this.toggleFullscreen()
      }
      // Ctrl/Cmd+L = toggle logs
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault()
        this.toggleLogs()
      }
    })

    // Auto-scroll log to bottom when new content arrives
    // (pollLogs already does this, but add a toggle)
    this._autoScrollLog = true

    // Right-click on the Web UI view background → actions
    const webUiView = document.getElementById('view-web-ui')
    if (webUiView) {
      webUiView.addEventListener('contextmenu', (e) => {
        // If the event came from inside the iframe, the bridge script
        // already posts a dsh-context-link message — skip here.
        if (e.target && e.target.closest && e.target.closest('.web-ui-toolbar')) {
          e.preventDefault()
          e.stopPropagation()
          const status = window.dsh.server.getStatus()
          DshUtils.showContextMenu(e.clientX, e.clientY, [
            {
              icon: '↻',
              label: '刷新页面',
              shortcut: 'Ctrl+R',
              action: () => this.refresh(),
            },
            {
              icon: '⛶',
              label: this._isMaximized ? '退出全屏' : '全屏',
              shortcut: 'Ctrl+Shift+F',
              action: () => this.toggleFullscreen(),
            },
            {
              icon: '🗔',
              label: '在浏览器中打开',
              action: () => this.openExternal(),
            },
            {
              icon: '📋',
              label: '复制地址',
              action: () => this.copyUrl(),
            },
            {
              separator: true,
            },
            {
              icon: '🗒',
              label: status.running ? '服务器日志' : '服务器日志 (未运行)',
              shortcut: 'Ctrl+L',
              disabled: !status.running,
              action: () => this.toggleLogs(),
            },
            {
              icon: '🧹',
              label: '清空日志',
              action: () => this.clearLogs(),
            },
          ])
        }
      })
    }

    // Right-click on the log panel → log actions
    const logPanel = document.getElementById('log-panel')
    if (logPanel) {
      logPanel.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const logEl = document.getElementById('log-content')
        const hasContent = !!logEl && logEl.textContent.trim().length > 0
        DshUtils.showContextMenu(e.clientX, e.clientY, [
          {
            icon: '🧹',
            label: '清空日志',
            action: () => this.clearLogs(),
          },
          {
            icon: '📋',
            label: '复制全部日志',
            disabled: !hasContent,
            action: () => {
              const text = logEl ? logEl.textContent : ''
              DshUtils.copyToClipboard(text)
              DshUtils.notify('已复制日志内容')
            },
          },
          {
            separator: true,
          },
          {
            icon: '✕',
            label: '关闭日志面板',
            action: () => {
              const panel = document.getElementById('log-panel')
              if (panel) panel.style.display = 'none'
              this.stopLogPolling()
            },
          },
        ])
      })
    }
  },
}

;(function () {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => WebUI.init())
  } else {
    WebUI.init()
  }
})()

// 显式挂载到 window，确保 onclick 内联事件能访问
window.WebUI = WebUI
