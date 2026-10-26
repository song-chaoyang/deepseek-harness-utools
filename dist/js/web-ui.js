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
   * Monotonic load generation — incremented on every load()/unload().
   * Async callbacks capture it before awaiting and bail out if it changed,
   * so a stale continuation can never mutate a torn-down/reloaded view.
   */
  loadGeneration: 0,

  /**
   * Clear the iframe to stop it from making requests to a dead server.
   * Called before stop/restart to prevent ERR_CONNECTION_REFUSED errors.
   */
  unload() {
    this.loadGeneration++
    if (this._blankHintTimer) {
      clearTimeout(this._blankHintTimer)
      this._blankHintTimer = null
    }
    const hint = document.getElementById('webui-blank-hint')
    if (hint) hint.remove()
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
    // Fresh boot telemetry per open (populated via dsh-boot-progress
    // messages from the injected bridge script; surfaced in the blank hint).
    this.bootInfo = { stages: [], latest: '' }
    const staleHint = document.getElementById('webui-blank-hint')
    if (staleHint) staleHint.remove()
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
    App.setExpendHeight(800)
    this.load()
  },

  /**
   * Load the DSH Web UI in the iframe.
   */
  async load() {
    this.loadGeneration++
    const generation = this.loadGeneration
    const iframe = document.getElementById('dsh-iframe')
    const loading = document.getElementById('web-ui-loading')
    const urlDisplay = document.getElementById('web-ui-url-display')

    if (!iframe) return

    // Prefer the authenticated entry URL captured from the DSH process
    // output (browser-trust fence); the bare origin returns 401.
    const url = (window.dsh.server.getWebUrl && window.dsh.server.getWebUrl()) || window.dsh.server.getServerUrl()
    const directUrl = window.dsh.server.getDirectUrl() // real DSH URL (display)
    urlDisplay.textContent = directUrl || url

    // Trust-fence detection: DSH ≥0.2.0 requires the tokenized entry URL.
    // When ours carries no token and the bare origin answers 401, loading
    // the iframe would show the raw "authentication required" text — show
    // actionable guidance (paste the token URL / restart) instead.
    if (!/[?&]token=/.test(url)) {
      try {
        const hc = await window.dsh.server.healthCheck()
        if (generation !== this.loadGeneration) return
        if (hc && hc.trustRequired) {
          loading.style.display = 'none'
          this.showTrustGuidance()
          return
        }
      } catch { /* health probe failed — proceed with the normal load */ }
    }
    this.hideTrustGuidance()

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
      this.hideTrustGuidance()
      this.stopReconnect()
      this.injectLinkInterceptor(iframe)
      // Re-trigger preload-level webContents hook for the freshly loaded iframe
      if (window.dsh && window.dsh.hookIframeLinks) {
        window.dsh.hookIframeLinks()
      }
    }

    // Fallback: if the iframe somehow ended up OFF the bridge URL, reset it
    // back to the bridge — never auto-open the system browser from an iframe
    // navigation (that was the "WebUI jumps to external browser" bug).
    iframe.addEventListener('load', () => {
      try {
        const currentUrl = iframe.contentWindow.location.href
        const serverUrl = window.dsh.server.getServerUrl()
        if (currentUrl && !currentUrl.startsWith(serverUrl) && !currentUrl.startsWith('about:')) {
          console.warn('[dsh] iframe drifted off the bridge URL, resetting:', currentUrl)
          iframe.src = serverUrl
        }
      } catch (e) {
        // cross-origin — can't read location; nothing to do
      }
    })

    // Set a generous timeout — DSH Web UI is a large SPA, first load can be slow
    this.loadTimeout = setTimeout(() => {
      if (this.loaded || generation !== this.loadGeneration) return
      // Don't trust status.running: for adopted external servers there is no
      // process-exit event, so the flag stays true even after the server dies.
      // Verify with a real health check before showing a (possibly blank) iframe.
      window.dsh.server.healthCheck().then(({ healthy }) => {
        if (this.loaded || generation !== this.loadGeneration) return
        if (healthy) {
          // Server is up but iframe didn't fire onload — just show it anyway
          loading.style.display = 'none'
          iframe.style.display = 'block'
          this.loaded = true
        } else {
          this.handleLoadError()
        }
      }).catch(() => {
        // healthCheck itself failed (bridge unavailable etc.) — fall back to
        // the reconnect/error path instead of leaving the spinner forever.
        if (this.loaded || generation !== this.loadGeneration) return
        this.handleLoadError()
      })
    }, 15000)

    // Load the URL
    iframe.src = url

    // Blank-page escape hatch: the DSH shell page fires onload (dark boot
    // background) BEFORE its SPA boots. If the SPA fails to boot inside the
    // uTools iframe, the user would stare at a permanent dark blank with no
    // recourse or clue. After 12s, surface a dismissible bar offering to
    // open the Web UI in the system browser (verified fully working there).
    if (this._blankHintTimer) clearTimeout(this._blankHintTimer)
    this._blankHintTimer = setTimeout(() => {
      this._blankHintTimer = null
      if (this.loadGeneration !== generation) return
      this.showBlankHint(url)
    }, 12000)
  },

  /**
   * Record a boot-telemetry event from the injected bridge script.
   * Keeps the last few milestones plus the latest DOM sample; surfaced in
   * the blank hint so a stuck boot is diagnosable without devtools.
   * @param {string} stage
   * @param {string} detail
   */
  recordBootProgress(stage, detail) {
    if (!this.bootInfo) this.bootInfo = { stages: [], latest: '' }
    if (stage === 'dom-sample') {
      this.bootInfo.latest = detail
      return
    }
    if (stage === 'spa-booted') {
      this.bootInfo.booted = true
      // App mounted — the blank hint is moot now
      const hint = document.getElementById('webui-blank-hint')
      if (hint) hint.remove()
    }
    const line = stage + (detail ? ' — ' + detail : '')
    this.bootInfo.stages.push(line)
    if (this.bootInfo.stages.length > 12) this.bootInfo.stages.shift()
  },

  /**
   * Human-readable one-line diagnostic summary of the iframe boot state.
   * @returns {string}
   */
  bootDiagnosticSummary() {
    const info = this.bootInfo || { stages: [], latest: '' }
    const parts = []
    parts.push('DOM:' + (info.latest || '无采样'))
    const errors = info.stages.filter((s) => s.startsWith('resource-error'))
    if (errors.length) parts.push('资源失败:' + errors[errors.length - 1])
    const milestones = info.stages.filter((s) => !s.startsWith('resource-error')).join(' → ')
    if (milestones) parts.push('里程碑:' + milestones)
    if (!parts.length) parts.push('无遥测(注入脚本未运行)')
    return parts.join(' | ')
  },

  /**
   * Dismissible hint bar shown when the in-app iframe may be stuck on the
   * DSH boot shell — offers opening the Web UI in the system browser.
   * @param {string} url - the URL the iframe was loading (bridge origin)
   */
  showBlankHint(url) {
    if (document.getElementById('webui-blank-hint')) return
    const view = document.getElementById('view-web-ui')
    if (!view) return
    const bar = document.createElement('div')
    bar.id = 'webui-blank-hint'
    bar.style.cssText = [
      'display:flex', 'align-items:center', 'gap:10px', 'flex-wrap:wrap',
      'padding:8px 14px', 'font-size:12px',
      'background:var(--color-warning)', 'color:#000',
      'position:absolute', 'top:52px', 'left:0', 'right:0', 'z-index:60',
    ].join(';')
    const label = document.createElement('span')
    label.style.cssText = 'flex:1;min-width:220px;color:#000'
    label.textContent = '页面若持续空白，可在系统浏览器中打开 Web UI（功能完整可用）'
    const openBtn = document.createElement('button')
    openBtn.className = 'btn btn-sm btn-secondary'
    openBtn.textContent = '浏览器打开 ↗'
    openBtn.onclick = () => { bar.remove(); this.openExternalUrl(url) }
    // One-click diagnostics: boot telemetry + chain state for issue reports
    const diagBtn = document.createElement('button')
    diagBtn.className = 'btn btn-sm btn-secondary'
    diagBtn.textContent = '复制诊断'
    diagBtn.title = '复制页面启动诊断信息，粘贴给开发者即可定位问题'
    diagBtn.onclick = () => {
      const status = window.dsh.server.getStatus()
      const text = [
        'DeepSeekHarness WebUI 诊断',
        '时间: ' + new Date().toISOString(),
        '插件版本: ' + (typeof utools !== 'undefined' && utools.getUtoolsApiVersion ? '(见关于)' : ''),
        '服务器: running=' + status.running + ' port=' + status.port + ' pid=' + status.pid,
        'iframe启动: ' + this.bootDiagnosticSummary(),
      ].join('\n')
      const done = () => DshUtils.notify('诊断信息已复制')
      if (typeof utools !== 'undefined' && utools.copyText) utools.copyText(text), done()
      else if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {})
    }
    const closeBtn = document.createElement('button')
    closeBtn.className = 'btn btn-sm btn-secondary'
    closeBtn.textContent = '✕'
    closeBtn.title = '关闭提示'
    closeBtn.onclick = () => bar.remove()
    bar.appendChild(label)
    bar.appendChild(openBtn)
    bar.appendChild(diagBtn)
    bar.appendChild(closeBtn)
    view.style.position = 'relative'
    view.appendChild(bar)
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
    const target = this._isMaximized ? 800 : Math.max(window.screen.availHeight || 800, 800)
    App.setExpendHeight(target)
    this._isMaximized = !this._isMaximized
  },

  /**
   * Handle a client-side error reported by the DSH Web UI (via the link
   * bridge's window.onerror / unhandledrejection hooks). A React render
   * crash blanks the page — surface the cause and, when profile plugins
   * require a newer DSH core than the one running, say so and offer the fix.
   * @param {string} message
   * @param {string} source
   */
  handleClientError(message, source) {
    // React retries can spam the same error — collapse repeats within 3s
    const now = Date.now()
    if (message === this._lastClientError && now - (this._lastClientErrorTime || 0) < 3000) return
    this._lastClientError = message
    this._lastClientErrorTime = now
    console.error('[dsh] Web UI client error:', message, source)

    // Check installed plugins against the running DSH version
    let compatLine = ''
    try {
      const compat = window.dsh.env.checkPluginCompat()
      if (compat && compat.incompatible && compat.incompatible.length > 0) {
        const list = compat.incompatible
          .slice(0, 5)
          .map((p) => `${p.name}@${p.version} (需 DSH ≥ ${p.required})`)
          .join('、')
        compatLine =
          `<div class="webui-error-compat">检测到 <b>${compat.incompatible.length}</b> 个插件与当前 DSH ` +
          `<code>${DshUtils.escapeHtml(compat.dshVersion || '?')}</code> 不兼容：${DshUtils.escapeHtml(list)}。` +
          `请到 设置 → 环境检测 → 「安装/更新 DSH」升级核心（插件是按较新的 DSH 版本开发的），或卸载这些插件。</div>`
      }
    } catch (e) { /* compat check is best-effort */ }

    const banner = document.createElement('div')
    banner.className = 'webui-error-banner'
    banner.innerHTML = `
      <div class="webui-error-title">⚠️ Web UI 渲染出错</div>
      <div class="webui-error-message">${DshUtils.escapeHtml(message)}</div>
      ${compatLine}
      <div class="webui-error-actions">
        <button class="btn btn-sm btn-secondary" data-act="logs">查看服务器日志</button>
        <button class="btn btn-sm btn-secondary" data-act="reload">刷新页面</button>
        <button class="btn btn-sm btn-secondary" data-act="close">关闭</button>
      </div>
    `
    banner.querySelector('[data-act="logs"]').addEventListener('click', () => {
      const panel = document.getElementById('log-panel')
      if (panel && panel.style.display !== 'flex') this.toggleLogs()
    })
    banner.querySelector('[data-act="reload"]').addEventListener('click', () => {
      this.removeErrorBanner()
      this.refresh()
    })
    banner.querySelector('[data-act="close"]').addEventListener('click', () => this.removeErrorBanner())

    this.removeErrorBanner()
    const container = document.querySelector('#view-web-ui .web-ui-container')
    if (container) container.prepend(banner)
  },

  /**
   * Remove the client-error banner, if present.
   */
  removeErrorBanner() {
    const existing = document.querySelector('#view-web-ui .webui-error-banner')
    if (existing) existing.remove()
  },

  /**
   * Show the trust-fence guidance panel. The running DSH instance (usually
   * an adopted external one whose stdout we cannot read) requires the
   * tokenized entry URL printed by whoever started it.
   */
  showTrustGuidance() {
    this.hideTrustGuidance()
    const directUrl = window.dsh.server.getDirectUrl() || 'http://127.0.0.1:3080'
    const panel = document.createElement('div')
    panel.className = 'webui-trust-panel'
    panel.innerHTML = `
      <div class="webui-trust-title">🔐 此 DSH 实例需要访问令牌</div>
      <div class="webui-trust-text">
        当前服务器启用了浏览器信任机制（DSH ≥0.2 的默认行为），直接访问被拒绝 (401)。
        DSH 在<b>启动它的终端</b>里打印了带 token 的入口地址（例如 VS Code 输出面板），
        形如 <code>${DshUtils.escapeHtml(directUrl)}/?token=…</code>。把它粘贴到下面即可打开：
      </div>
      <div class="webui-trust-form">
        <input type="text" class="webui-trust-input" id="webui-trust-input"
               placeholder="${DshUtils.escapeHtml(directUrl)}/?token=…">
        <button class="btn btn-primary btn-sm" id="webui-trust-open">打开</button>
        <button class="btn btn-secondary btn-sm" id="webui-trust-retry">重试</button>
      </div>
      <div class="webui-trust-hint">
        💡 也可以关闭该外部实例，回到「服务器管理」点 <b>启动服务器</b> ——
        由本插件启动时会自动捕获 token，无需手动粘贴。
      </div>
      <div class="webui-trust-error hidden" id="webui-trust-error"></div>
    `
    const container = document.querySelector('#view-web-ui .web-ui-container')
    if (!container) return
    container.prepend(panel)

    const input = panel.querySelector('#webui-trust-input')
    const errorEl = panel.querySelector('#webui-trust-error')
    const submit = async () => {
      const result = window.dsh.server.setWebEntryUrl(input.value)
      if (result && result.ok) {
        this.hideTrustGuidance()
        this.load()
      } else {
        errorEl.textContent = (result && result.error) || '无效的 URL'
        errorEl.classList.remove('hidden')
      }
    }
    panel.querySelector('#webui-trust-open').addEventListener('click', submit)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit() }
    })
    panel.querySelector('#webui-trust-retry').addEventListener('click', () => {
      this.hideTrustGuidance()
      this.load()
    })
    input.focus()
  },

  /**
   * Remove the trust guidance panel, if present.
   */
  hideTrustGuidance() {
    const existing = document.querySelector('#view-web-ui .webui-trust-panel')
    if (existing) existing.remove()
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
      } else if (data.type === 'dsh-client-error') {
        // Web UI crashed client-side (React/plugin render failure).
        // Show an actionable banner instead of a silently blank page.
        this.handleClientError(String(data.message || ''), String(data.source || ''))
      } else if (data.type === 'dsh-boot-progress') {
        // Boot telemetry from the injected bridge script (milestones,
        // resource failures, DOM growth samples).
        this.recordBootProgress(String(data.stage || ''), String(data.detail || ''))
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
