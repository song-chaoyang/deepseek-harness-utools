/**
 * server-manager.js — DSH server lifecycle management UI.
 */

const ServerManager = {
  envResults: null,
  startupLogTimer: null,
  startupLogCursor: 0,
  isStarting: false,

  setStartupStep(step, state, label) {
    const el = document.querySelector(`.startup-step[data-step="${step}"]`)
    if (!el) return
    el.classList.remove('active', 'done', 'failed')
    if (state) el.classList.add(state)
    const icon = el.querySelector('.step-icon')
    if (icon) icon.textContent = state === 'done' ? '✔' : state === 'failed' ? '✘' : '○'
    if (label) {
      const lbl = el.querySelector('.step-label')
      if (lbl) lbl.textContent = label
    }
  },

  showStartupProgress() {
    const panel = document.getElementById('startup-progress')
    const logEl = document.getElementById('startup-log')
    if (panel) panel.style.display = 'flex'
    if (logEl) logEl.style.display = 'block'
    this.startupLogCursor = 0
    if (logEl) logEl.textContent = ''
    this.updateProgressBar(0)
  },

  updateProgressBar(percent) {
    const bar = document.getElementById('startup-progress-bar')
    if (bar) bar.style.width = Math.max(0, Math.min(100, percent)) + '%'
  },

  pollStartupLog() {
    const logEl = document.getElementById('startup-log')
    if (!logEl) return
    let text = ''
    try {
      text = (window.dsh.server.getStdout(200) || '') + (window.dsh.server.getStderr(200) || '')
    } catch { return }
    const fresh = text.slice(this.startupLogCursor)
    if (fresh) {
      this.startupLogCursor = text.length
      logEl.textContent += fresh
      logEl.scrollTop = logEl.scrollHeight
    }
  },

  startStartupLogPolling() {
    this.stopStartupLogPolling()
    this.startupLogTimer = setInterval(() => this.pollStartupLog(), 500)
  },

  stopStartupLogPolling() {
    if (this.startupLogTimer) {
      clearInterval(this.startupLogTimer)
      this.startupLogTimer = null
    }
  },

  /**
   * Check environment and update the UI.
   * Fast check — does NOT call the slow hasDshInstalled() npx execSync.
   */
  async checkEnvironment() {
    const checkList = document.getElementById('env-check-list')
    if (!checkList) return null

    const items = checkList.querySelectorAll('.env-check-item')
    items.forEach((item) => {
      item.querySelector('.env-check-icon').textContent = '⏳'
      item.querySelector('.env-check-result').textContent = '检测中...'
      item.querySelector('.env-check-result').className = 'env-check-result'
    })

    await new Promise(r => setTimeout(r, 10))

    const results = window.dsh.env.checkPrerequisites({ skipDshCheck: true })
    this.envResults = results

    const nodeSource = results.nodeSource ? ` (${results.nodeSource === 'bundled' ? '自带运行时' : '系统'})` : ''
    this.updateEnvItem('nodejs', results.nodeOk,
      results.nodeOk ? `${results.nodeVersion}${nodeSource}` : (results.nodeVersion ? `版本过低: ${results.nodeVersion}` : '未安装 (需要 24.0+)'),
      results.nodeOk ? 'success' : 'error')

    this.updateEnvItem('npx', results.npxOk,
      results.npxOk ? '可用' : '未找到 npx',
      results.npxOk ? 'success' : 'error')

    // DSH: fast check only — MUST skip the npx path: it can execSync-block
    // the renderer for up to 30s (or download the package), which uTools
    // treats as "not responding" and kills the plugin window.
    let dshInstalled = false, dshVersion = null, dshMethod = null
    try {
      const dshResult = window.dsh.env.hasDshInstalled({ skipNpx: true })
      dshInstalled = dshResult.installed
      dshVersion = dshResult.version
      dshMethod = dshResult.method
    } catch { /* ignore */ }
    this.updateEnvItem('dsh', dshInstalled,
      dshInstalled ? `${dshVersion} (${dshMethod})` : '未安装 (首次启动自动安装)',
      dshInstalled ? 'success' : 'warning')

    return results
  },

  updateEnvItem(checkName, ok, resultText, status) {
    const item = document.querySelector(`.env-check-item[data-check="${checkName}"]`)
    if (!item) return
    const icon = item.querySelector('.env-check-icon')
    const result = item.querySelector('.env-check-result')
    icon.textContent = ok ? '✅' : (status === 'warning' ? '⚠️' : '❌')
    result.textContent = resultText
    result.className = `env-check-result ${status}`

    const actionsEl = document.getElementById(`env-actions-${checkName}`)
    if (actionsEl) {
      actionsEl.innerHTML = ''
      if (!ok) {
        if (checkName === 'nodejs') {
          const btnAuto = document.createElement('button')
          btnAuto.className = 'btn btn-primary btn-sm'
          btnAuto.textContent = '🔧 自动安装运行时'
          btnAuto.addEventListener('click', async () => {
            btnAuto.disabled = true
            btnAuto.textContent = '正在下载...'
            try {
              const result = await window.dsh.env.runtime.download({ onProgress: (msg) => btnAuto.textContent = msg })
              if (result.success) {
                btnAuto.textContent = '✅ 安装成功'
                DshUtils.notify('Node.js 运行时安装完成')
                setTimeout(() => { this.checkEnvironment() }, 1000)
              } else {
                btnAuto.textContent = '❌ ' + (result.error || '安装失败')
              }
            } catch (err) { btnAuto.textContent = '❌ ' + err.message }
          })
          actionsEl.appendChild(btnAuto)

          const btnDownload = document.createElement('button')
          btnDownload.className = 'btn btn-secondary btn-sm'
          btnDownload.textContent = '手动下载'
          btnDownload.addEventListener('click', () => {
            if (typeof utools !== 'undefined' && utools.shellOpenExternal) utools.shellOpenExternal('https://nodejs.org/en/download')
          })
          actionsEl.appendChild(btnDownload)
        }
      } else if (checkName === 'dsh') {
        const btn = document.createElement('button')
        btn.className = 'btn btn-secondary btn-sm'
        btn.textContent = '更新 DSH'
        btn.addEventListener('click', async () => {
          btn.disabled = true
          btn.textContent = '更新中...'
          const ok = await window.dsh.cli.install({})
          btn.textContent = ok ? '更新成功' : '更新失败'
          DshUtils.notify(ok ? 'DSH 更新成功' : 'DSH 更新失败')
          setTimeout(() => { this.checkEnvironment() }, 2000)
        })
        actionsEl.appendChild(btn)
      }

      if (checkName === 'dsh' && !ok) {
        const btn = document.createElement('button')
        btn.className = 'btn btn-primary btn-sm'
        btn.textContent = '安装 DSH'
        btn.addEventListener('click', async () => {
          btn.disabled = true
          btn.textContent = '安装中...'
          const ok = await window.dsh.cli.install({})
          btn.textContent = ok ? '安装成功' : '安装失败'
          DshUtils.notify(ok ? 'DSH 安装成功' : 'DSH 安装失败')
          setTimeout(() => { this.checkEnvironment() }, 2000)
        })
        actionsEl.appendChild(btn)
      }
    }
  },

  showEnvResults(results) {
    const container = document.getElementById('env-check-list-settings')
    if (!container) return
    const nodeActions = results.nodeOk ? '' :
      `<button class="btn btn-primary btn-sm" onclick="ServerManager.autoInstallRuntime()">🔧 自动安装</button>`
    const dshActions = results.dsh.installed
      ? '<button class="btn btn-secondary btn-sm" onclick="ServerManager.updateDsh()">更新 DSH</button>'
      : '<button class="btn btn-primary btn-sm" onclick="ServerManager.installDsh()">安装 DSH</button>'

    // Plugin ↔ DSH core compatibility (best-effort; filesystem-only check).
    // Incompatible community plugins crash the Web UI React tree (blank page).
    let compatRow = ''
    try {
      const compat = window.dsh.env.checkPluginCompat()
      if (compat && compat.incompatible && compat.incompatible.length > 0) {
        const list = compat.incompatible
          .slice(0, 3)
          .map((p) => `${DshUtils.escapeHtml(p.name)}@${p.version} ≥${p.required}`)
          .join('、')
        const more = compat.incompatible.length > 3 ? ` 等 ${compat.incompatible.length} 个` : ''
        compatRow = `
          <div class="env-check-item">
            <span class="env-check-icon">⚠️</span>
            <span class="env-check-name">插件兼容性</span>
            <span class="env-check-result warning" title="${DshUtils.escapeHtml(compat.incompatible.map((p) => `${p.name}@${p.version} 需 ${p.required}`).join('\n'))}">${DshUtils.escapeHtml(list)}${more} 与 DSH ${DshUtils.escapeHtml(compat.dshVersion || '')} 不兼容</span>
            <div class="env-check-actions"><button class="btn btn-secondary btn-sm" onclick="ServerManager.updateDsh()">升级 DSH</button></div>
          </div>
        `
      }
    } catch { /* compat check is best-effort */ }

    container.innerHTML = `
      <div class="env-check-item">
        <span class="env-check-icon">${results.nodeOk ? '✅' : '❌'}</span>
        <span class="env-check-name">Node.js 24.0+</span>
        <span class="env-check-result ${results.nodeOk ? 'success' : 'error'}">${results.nodeVersion || '未安装'}</span>
        <div class="env-check-actions">${nodeActions}</div>
      </div>
      <div class="env-check-item">
        <span class="env-check-icon">${results.npxOk ? '✅' : '❌'}</span>
        <span class="env-check-name">npx</span>
        <span class="env-check-result ${results.npxOk ? 'success' : 'error'}">${results.npxOk ? '可用' : '未找到'}</span>
      </div>
      <div class="env-check-item">
        <span class="env-check-icon">${results.dsh.installed ? '✅' : '⚠️'}</span>
        <span class="env-check-name">DSH</span>
        <span class="env-check-result ${results.dsh.installed ? 'success' : 'warning'}">${results.dsh.installed ? `${results.dsh.version} (${results.dsh.method})` : '未安装'}</span>
        <div class="env-check-actions">${dshActions}</div>
      </div>
      ${compatRow}
    `
  },

  async autoInstallRuntime() {
    DshUtils.notify('正在下载 Node.js 运行时...')
    try {
      const result = await window.dsh.env.runtime.download({ onProgress: (msg) => DshUtils.notify(msg) })
      if (result.success) DshUtils.notify('Node.js 运行时安装完成')
      else DshUtils.notify('安装失败: ' + (result.error || '未知'))
    } catch (err) { DshUtils.notify('安装失败: ' + err.message) }
  },

  async installDsh() {
    const btn = document.getElementById('btn-install-dsh')
    if (btn) { btn.disabled = true; btn.textContent = '安装中...' }
    const ok = await window.dsh.cli.install({})
    if (btn) { btn.disabled = false; btn.textContent = '安装/更新 DSH' }
    DshUtils.notify(ok ? 'DSH 安装成功' : 'DSH 安装失败')
  },

  async updateDsh() { return this.installDsh() },

  /**
   * Show the server configuration panel.
   * ALWAYS shows the env-check-panel so the user sees the full UI.
   */
  showConfigPanel() {
    // Always show env check panel
    document.getElementById('env-check-panel').style.display = 'block'
    document.getElementById('server-config-panel').style.display = 'block'
    DshUtils.hideError()

    // Hide server info section (not running)
    document.getElementById('server-info-section').style.display = 'none'
    document.getElementById('btn-start-server').style.display = 'block'
    document.getElementById('btn-stop-server').style.display = 'none'
    document.getElementById('btn-open-webui').style.display = 'none'
    document.getElementById('btn-restart-server').style.display = 'none'

    DshUtils.setStatusBadge('stopped', '未运行')
  },

  showServerInfo() {
    document.getElementById('env-check-panel').style.display = 'block'
    document.getElementById('server-config-panel').style.display = 'block'
    DshUtils.hideError()

    const status = window.dsh.server.getStatus()
    const isRunning = status.running

    const infoSection = document.getElementById('server-info-section')
    if (infoSection) {
      infoSection.style.display = 'block'
      document.getElementById('info-status').textContent = isRunning ? '运行中' : '已停止'
      document.getElementById('info-status').style.color = isRunning ? 'var(--color-success)' : 'var(--color-danger)'
      document.getElementById('info-url').textContent = window.dsh.server.getDirectUrl()
        || window.dsh.server.getServerUrl()
      document.getElementById('info-pid').textContent = status.pid || '外部'
      document.getElementById('info-uptime').textContent = DshUtils.formatUptime(status.uptime)
    }

    document.getElementById('btn-start-server').style.display = isRunning ? 'none' : 'block'
    document.getElementById('btn-stop-server').style.display = isRunning ? 'block' : 'none'
    document.getElementById('btn-open-webui').style.display = isRunning ? 'block' : 'none'
    document.getElementById('btn-restart-server').style.display = isRunning ? 'block' : 'none'

    DshUtils.setStatusBadge(isRunning ? 'running' : 'stopped', isRunning ? '运行中' : '已停止')

    if (isRunning) App.startUptimeDisplay()
    else App.stopUptimeDisplay()
  },

  /**
   * Start the DSH server with progress bar.
   */
  async startServer(options = {}) {
    console.log('[dsh] startServer() called, isStarting=', this.isStarting)
    if (this.isStarting) {
      console.log('[dsh] startServer() already in progress, ignoring')
      return
    }
    this.isStarting = true

    // Safety: check window.dsh exists
    if (!window.dsh || !window.dsh.server) {
      console.error('[dsh] window.dsh is not available!')
      DshUtils.showError('启动失败', 'window.dsh 不可用 — preload.js 可能未正确加载', [
        '请检查 preload.js 是否有语法错误',
        '在 uTools 开发者工具中查看 Console 错误信息',
      ])
      this.isStarting = false
      return
    }

    try {
      const workspace = options.workspace || window.dsh.workspace.getCurrent() || ''
      const port = options.port || App.getSetting('port', 3080)
      const profile = 'web'
      console.log('[dsh] starting server on port', port, 'workspace:', workspace)

      App.setSetting('port', port)
      App.setSetting('profile', profile)

      DshUtils.setStatusBadge('unknown', '启动中...')
      document.getElementById('server-config-panel').style.display = 'none'
      DshUtils.showView('view-loading')
      document.getElementById('loading-text').textContent = '正在启动 DeepSeek Harness...'
      this.showStartupProgress()
      this.setStartupStep('env', 'active')
      this.updateProgressBar(10)

      await new Promise(r => setTimeout(r, 50))

      // Step 1: Environment check
      let prereq
      try {
        prereq = window.dsh.env.checkPrerequisites({ skipDshCheck: true })
        this.setStartupStep('env', 'done',
          prereq.nodeOk
            ? `检查环境 ✔ ${prereq.nodeVersion}${prereq.nodeSource === 'bundled' ? ' (自带运行时)' : ''}`
            : `检查环境 ✔ ${prereq.nodeVersion || 'Node 缺失'}`)
        this.updateProgressBar(25)
      } catch {
        this.setStartupStep('env', 'done', '检查环境 ✔')
        this.updateProgressBar(25)
        prereq = { nodeOk: false, npxOk: false }
      }

      // If Node is not available, auto-download bundled runtime
      if (!prereq.nodeOk) {
        document.getElementById('loading-text').textContent = '正在下载 Node.js 运行时...'
        this.setStartupStep('spawn', 'active', '下载 Node.js 运行时...')
        this.updateProgressBar(30)
        const rtResult = await window.dsh.env.runtime.download({
          onProgress: (msg) => {
            document.getElementById('loading-text').textContent = msg
            this.setStartupStep('spawn', 'active', msg)
          },
        })
        if (!rtResult.success) throw new Error('Node.js 运行时下载失败: ' + (rtResult.error || '未知'))
        this.setStartupStep('spawn', 'done', 'Node.js 运行时就绪')
        this.updateProgressBar(45)
      }

      // Step 2: Start the server process
      document.getElementById('loading-text').textContent = '正在启动 DSH 服务器...'
      this.setStartupStep('spawn', 'active', '启动 DSH 进程...')
      this.updateProgressBar(50)
      this.startStartupLogPolling()

      const result = await window.dsh.server.start({ workspace, port, profile })
      this.stopStartupLogPolling()

      if (result.success) {
        this.setStartupStep('spawn', 'done')
        this.setStartupStep('ready', 'done')
        this.updateProgressBar(90)
        document.getElementById('loading-text').textContent = '服务器已就绪，正在打开 Web UI...'
        await new Promise(r => setTimeout(r, 300))

        this.setStartupStep('open', 'done')
        this.updateProgressBar(100)

        DshUtils.showView('view-server-manager')
        this.showServerInfo()

        App.addDynamicFeature('dsh-quick-session', '快速打开 DSH 当前会话', ['dsh session', 'DSH 会话'])

        App.setExpendHeight(800)
        WebUI.open()
      } else {
        this.setStartupStep('spawn', 'failed')
        this.setStartupStep('ready', 'failed')
        DshUtils.showView('view-server-manager')
        DshUtils.setStatusBadge('stopped', '启动失败')

        const suggestions = []
        const combinedOutput = (result.stderr || '') + (result.stdout || '')
        if (combinedOutput.includes('EADDRINUSE')) {
          suggestions.push('端口被占用 — 可能是之前的 DSH 服务器未正常关闭')
          suggestions.push('请点击"停止服务器"后再试，或更换端口')
        }
        if (combinedOutput.includes('EACCES')) {
          suggestions.push('端口访问被拒绝 — 请在设置中更换端口 (如 3081)')
        }
        if (combinedOutput.includes('ENOENT')) {
          suggestions.push('Node.js 或 npx 未正确安装')
        }
        if (combinedOutput.includes('MODULE_NOT_FOUND')) {
          suggestions.push('DSH 模块缺失，请尝试: npm install -g @deepseek-ai/dsh')
        }
        if (combinedOutput) {
          suggestions.push('服务器输出:\n' + combinedOutput.slice(-500))
        }

        DshUtils.showError('服务器启动失败', result.error || '未知错误', suggestions)
        // Also show the config panel so the user can retry
        this.showConfigPanel()
      }
    } catch (err) {
      console.error('[dsh] startServer() error:', err)
      DshUtils.showView('view-server-manager')
      DshUtils.setStatusBadge('stopped', '启动失败')
      DshUtils.showError('服务器启动异常', err.message || String(err), [
        '请检查环境配置后重试',
        '如持续失败，请尝试手动运行: npx @deepseek-ai/dsh web',
      ])
      this.showConfigPanel()
    } finally {
      console.log('[dsh] startServer() finished, isStarting reset to false')
      this.isStarting = false
    }
  },

  async stopServer() {
    // Suppress the dsh-server-exited event from switching views (intentional stop)
    App.suppressExitView = true
    // Unload iframe FIRST to prevent ERR_CONNECTION_REFUSED errors
    WebUI.unload()
    DshUtils.showView('view-server-manager')
    DshUtils.setStatusBadge('unknown', '正在停止...')
    App.removeDynamicFeature('dsh-quick-session')
    await window.dsh.server.stop()
    App.stopUptimeDisplay()
    this.showConfigPanel()
  },

  async restartServer() {
    // Suppress the dsh-server-exited event from switching views (intentional restart)
    App.suppressExitView = true
    // Unload iframe FIRST to prevent ERR_CONNECTION_REFUSED errors
    WebUI.unload()
    DshUtils.showView('view-server-manager')
    DshUtils.setStatusBadge('unknown', '重启中...')
    const status = window.dsh.server.getStatus()
    const result = await window.dsh.server.restart({
      workspace: status.workspace,
      port: status.port,
      profile: status.profile,
    })
    if (result.success) {
      this.showServerInfo()
      DshUtils.setStatusBadge('running', '运行中')
      // Reload the Web UI after server is back up
      WebUI.open()
    } else {
      DshUtils.showError('重启失败', result.error || '未知错误')
    }
  },

  /**
   * Initialize event listeners.
   * NOTE: All buttons already have onclick="" in HTML.
   * Do NOT add addEventListener here — it causes duplicate firing.
   */
  init() {
    // No-op: all button handlers are bound via onclick in index.html
  },
}

// 显式挂载到 window，确保 onclick 内联事件能访问
window.ServerManager = ServerManager

// Robust initialization — works even if DOMContentLoaded already fired
;(function () {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ServerManager.init())
  } else {
    ServerManager.init()
  }
})()
