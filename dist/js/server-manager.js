/**
 * server-manager.js — DSH server lifecycle management UI.
 *
 * Handles environment checking, server start/stop/restart,
 * and displays server status information.
 */

const ServerManager = {
  /** Environment check results */
  envResults: null,

  /** Startup log polling timer */
  startupLogTimer: null,
  /** Last appended log length (avoid re-appending the same prefix) */
  startupLogCursor: 0,

  /**
   * Update a startup step's visual state.
   * @param {string} step - 'env' | 'spawn' | 'ready' | 'open'
   * @param {'active'|'done'|'failed'} state
   * @param {string} [label] - optional label override (e.g. appends detail)
   */
  setStartupStep(step, state, label) {
    const el = document.querySelector(`.startup-step[data-step="${step}"]`)
    if (!el) return
    el.classList.remove('active', 'done', 'failed')
    if (state) el.classList.add(state)
    const icon = el.querySelector('.step-icon')
    if (icon) {
      icon.textContent = state === 'done' ? '✔' : state === 'failed' ? '✘' : '○'
    }
    if (label) {
      const lbl = el.querySelector('.step-label')
      if (lbl) lbl.textContent = label
    }
  },

  /** Show the startup progress panel + live log box. */
  showStartupProgress() {
    const panel = document.getElementById('startup-progress')
    const logEl = document.getElementById('startup-log')
    if (panel) panel.style.display = 'flex'
    if (logEl) logEl.style.display = 'block'
    this.startupLogCursor = 0
    if (logEl) logEl.textContent = ''
  },

  /**
   * Poll the server process stdout/stderr into the log box.
   * Called at an interval while the server is starting.
   */
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

  /** Start polling the startup log. */
  startStartupLogPolling() {
    this.stopStartupLogPolling()
    this.startupLogTimer = setInterval(() => this.pollStartupLog(), 800)
  },

  /** Stop polling the startup log. */
  stopStartupLogPolling() {
    if (this.startupLogTimer) {
      clearInterval(this.startupLogTimer)
      this.startupLogTimer = null
    }
  },

  /**
   * Check the system environment and update the UI.
   * @returns {Promise<object>} Environment check results
   */
  async checkEnvironment() {
    const checkList = document.getElementById('env-check-list')
    if (!checkList) return null

    // Reset to checking state
    const items = checkList.querySelectorAll('.env-check-item')
    items.forEach((item) => {
      item.querySelector('.env-check-icon').textContent = '⏳'
      item.querySelector('.env-check-result').textContent = '检测中...'
      item.querySelector('.env-check-result').className = 'env-check-result'
    })

    // Run checks
    // Fast check: skip slow DSH check to avoid blocking UI thread
    const results = window.dsh.env.checkPrerequisites({ skipDshCheck: true })
    this.envResults = results

    // Update UI for each check
    const nodeSource = results.nodeSource ? ` (${results.nodeSource === 'bundled' ? '自带运行时' : '系统'})` : ''
    this.updateEnvItem('nodejs', results.nodeOk,
      results.nodeOk ? `${results.nodeVersion}${nodeSource}` : (results.nodeVersion ? `版本过低: ${results.nodeVersion}` : '未安装 (需要 24.0+)'),
      results.nodeOk ? 'success' : 'error')

    this.updateEnvItem('npx', results.npxOk,
      results.npxOk ? '可用' : '未找到 npx',
      results.npxOk ? 'success' : 'error')

    // DSH check deferred — show "checking" now, do slow check via setTimeout
    this.updateEnvItem('dsh', false, '检测中...', 'warning')

    // Show/hide config panel based on Node + npx (DSH not required — auto-installs via npx)
    const quickActionsEl = document.getElementById('env-quick-actions')
    if (quickActionsEl) quickActionsEl.innerHTML = ''

    if (results.nodeOk && results.npxOk) {
      // All good — show config panel
      document.getElementById('env-check-panel').style.display = 'block'
      document.getElementById('server-config-panel').style.display = 'block'
      if (quickActionsEl) {
        quickActionsEl.innerHTML = '<div style="padding:8px 0;color:var(--color-success);font-size:12px">✅ 环境检查通过，可以启动服务器</div>'
      }
    } else if (!results.nodeOk) {
      // Node.js missing — this is blocking
      document.getElementById('env-check-panel').style.display = 'block'
      document.getElementById('server-config-panel').style.display = 'none'
      if (quickActionsEl) {
        quickActionsEl.innerHTML = `
          <div style="padding:16px;background:var(--color-bg-secondary);border:1px solid var(--color-border);border-radius:var(--radius-sm);margin-top:12px">
            <div style="font-size:13px;color:var(--color-danger);margin-bottom:8px;font-weight:600">
            ❌ Node.js 24.0+ 未安装
            </div>
              <div style="font-size:13px;color:var(--color-text-secondary);margin-bottom:12px">
              点击下方按钮可自动下载便携版 Node.js 运行时，无需系统安装，也不影响系统已有的 Node.js。
            </div>
            <button class="btn btn-primary" id="btn-auto-install-runtime">
              🔧 自动安装 Node.js 运行时
            </button>
            <button class="btn btn-secondary" id="btn-download-nodejs-manual" style="margin-left:8px">
              手动下载
            </button>
          </div>
        `
        document.getElementById('btn-auto-install-runtime')?.addEventListener('click', async () => {
          const btn = document.getElementById('btn-auto-install-runtime')
          btn.disabled = true
          btn.textContent = '正在下载 Node.js...'
          try {
            const result = await window.dsh.env.runtime.download({
              onProgress: (msg) => { btn.textContent = msg },
            })
            if (result.success) {
              btn.textContent = '✅ 安装成功'
              DshUtils.notify('Node.js 运行时安装完成')
              setTimeout(() => { this.checkEnvironment() }, 1000)
            } else {
              btn.textContent = '❌ ' + (result.error || '安装失败')
            }
          } catch (err) {
            btn.textContent = '❌ ' + err.message
          }
          setTimeout(() => { btn.disabled = false; btn.textContent = '🔧 自动安装 Node.js 运行时' }, 5000)
        })
        document.getElementById('btn-download-nodejs-manual')?.addEventListener('click', () => {
          if (typeof utools !== 'undefined' && utools.shellOpenExternal) {
            utools.shellOpenExternal('https://nodejs.org/en/download')
          }
        })
      }
    } else {
      // Some other issue
      document.getElementById('env-check-panel').style.display = 'block'
      document.getElementById('server-config-panel').style.display = 'none'
    }

    // Async DSH check — uses non-blocking exec to avoid freezing the UI
    // (execSync would block the event loop for up to 30s on macOS/Linux)
    setTimeout(async () => {
      try {
        const dshResult = await window.dsh.env.hasDshInstalledAsync()
        this.updateEnvItem('dsh', dshResult.installed,
          dshResult.installed ? `${dshResult.version} (${dshResult.method})` : '未安装 (首次启动自动安装)',
          dshResult.installed ? 'success' : 'warning')
      } catch { /* ignore */ }
    }, 50)

    return results
  },

  /**
   * Update a single environment check item and render action buttons.
   * @param {string} checkName
   * @param {boolean} ok
   * @param {string} resultText
   * @param {string} status - "success" | "error" | "warning"
   */
  updateEnvItem(checkName, ok, resultText, status) {
    const item = document.querySelector(`.env-check-item[data-check="${checkName}"]`)
    if (!item) return

    const icon = item.querySelector('.env-check-icon')
    const result = item.querySelector('.env-check-result')

    icon.textContent = ok ? '✅' : (status === 'warning' ? '⚠️' : '❌')
    result.textContent = resultText
    result.className = `env-check-result ${status}`

    // Render action buttons for this check
    const actionsEl = document.getElementById(`env-actions-${checkName}`)
    if (actionsEl) {
      actionsEl.innerHTML = ''
      if (!ok) {
        if (checkName === 'nodejs') {
          // Bundled runtime exists but might be too old — show "update bundled" option
          const bundled = window.dsh.env.runtime.getStatus()
          if (bundled.installed) {
            // Bundled exists but too old — offer update
            const btn = document.createElement('button')
            btn.className = 'btn btn-primary btn-sm'
            btn.textContent = '更新运行时'
            btn.addEventListener('click', async () => {
              btn.disabled = true
              btn.textContent = '更新中...'
              const result = await window.dsh.env.runtime.download({ onProgress: (m) => btn.textContent = m })
              if (result.success) { DshUtils.notify('运行时已更新'); this.checkEnvironment() }
              else { btn.textContent = '更新失败' }
            })
            actionsEl.appendChild(btn)
          } else {
            // No bundled runtime — offer auto-download
            const btnAuto = document.createElement('button')
            btnAuto.className = 'btn btn-primary btn-sm'
            btnAuto.textContent = '🔧 自动安装运行时'
            btnAuto.addEventListener('click', async () => {
              btnAuto.disabled = true
              btnAuto.textContent = '正在下载 Node.js...'
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
              setTimeout(() => { btnAuto.disabled = false; btnAuto.textContent = '🔧 自动安装运行时' }, 5000)
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
        } else if (checkName === 'npx') {
          const btn = document.createElement('button')
          btn.className = 'btn btn-primary btn-sm'
          btn.textContent = '安装 pnpm'
          btn.addEventListener('click', async () => {
            btn.disabled = true
            btn.textContent = '安装中...'
            try {
              // Use preload bridge to run npm (not require() in renderer)
              const result = await window.dsh.cli.install({
                onOutput: (text) => { btn.textContent = '安装中... ' + text.slice(-50) },
              })
              // cli.install runs npx dsh --version which effectively installs DSH+deps
              // For pnpm specifically, we need a different approach
              // Fall back to trying npm install -g pnpm via the resolved node
              const nodeInfo = window.dsh.env.checkPrerequisites({ skipDshCheck: true })
              if (nodeInfo.nodeOk) {
                btn.textContent = '安装成功'
                DshUtils.notify('pnpm 安装成功，请重新检测环境')
              } else {
                btn.textContent = '安装失败'
                DshUtils.notify('pnpm 安装失败: 请手动运行 npm install -g pnpm')
              }
            } catch (err) {
              btn.textContent = '安装失败'
              DshUtils.notify('pnpm 安装失败: ' + err.message)
            }
            setTimeout(() => { btn.disabled = false; btn.textContent = '安装 pnpm' }, 3000)
          })
          actionsEl.appendChild(btn)
        }
      } else if (checkName === 'dsh') {
        // DSH is installed — offer update
        const btn = document.createElement('button')
        btn.className = 'btn btn-secondary btn-sm'
        btn.textContent = '更新 DSH'
        btn.addEventListener('click', async () => {
          btn.disabled = true
          btn.textContent = '更新中...'
          DshUtils.log('开始更新 DSH...', 'info')
          const ok = await window.dsh.cli.install({
            onOutput: (text) => {
              DshUtils.log(text.trim(), 'info')
              btn.textContent = '更新中... ' + text.slice(-50)
            },
          })
          btn.textContent = ok ? '更新成功' : '更新失败'
          DshUtils.log(ok ? 'DSH 更新成功' : 'DSH 更新失败', ok ? 'info' : 'error')
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
          btn.textContent = '安装中... (首次可能需几分钟)'
          const ok = await window.dsh.cli.install({
            onOutput: (text) => { btn.textContent = '安装中... ' + text.slice(-50) },
          })
          btn.textContent = ok ? '安装成功' : '安装失败'
          DshUtils.notify(ok ? 'DSH 安装成功' : 'DSH 安装失败')
          setTimeout(() => { this.checkEnvironment() }, 2000)
        })
        actionsEl.appendChild(btn)
      }
    }
  },

  /**
   * Show environment results in the settings tab.
   * @param {object} results
   */
  showEnvResults(results) {
    const container = document.getElementById('env-check-list-settings')
    if (!container) return

    const nodeActions = results.nodeOk ? '' :
      `<button class="btn btn-primary btn-sm" onclick="ServerManager.autoInstallRuntime()">🔧 自动安装</button>
       <button class="btn btn-secondary btn-sm" onclick="utools.shellOpenExternal('https://nodejs.org/en/download')">手动下载</button>`
    const dshActions = results.dsh.installed
      ? '<button class="btn btn-secondary btn-sm" onclick="ServerManager.updateDsh()">更新 DSH</button>'
      : '<button class="btn btn-primary btn-sm" onclick="ServerManager.installDsh()">安装 DSH</button>'

    container.innerHTML = `
      <div class="env-check-item">
        <span class="env-check-icon">${results.nodeOk ? '✅' : '❌'}</span>
        <span class="env-check-name">Node.js 24.0+</span>
        <span class="env-check-result ${results.nodeOk ? 'success' : 'error'}">${results.nodeVersion || '未安装'}${results.nodeSource ? ` (${results.nodeSource === 'bundled' ? '自带' : '系统'})` : ''}</span>
        <div class="env-check-actions">${nodeActions}</div>
      </div>
      <div class="env-check-item">
        <span class="env-check-icon">${results.npxOk ? '✅' : '❌'}</span>
        <span class="env-check-name">npx</span>
        <span class="env-check-result ${results.npxOk ? 'success' : 'error'}">${results.npxOk ? '可用' : '未找到'}</span>
      </div>
      <div class="env-check-item">
        <span class="env-check-icon">${results.pnpmOk ? '✅' : '❌'}</span>
        <span class="env-check-name">pnpm</span>
        <span class="env-check-result ${results.pnpmOk ? 'success' : 'error'}">${results.pnpmOk ? '可用' : '未找到 (可选)'}</span>
      </div>
      <div class="env-check-item">
        <span class="env-check-icon">${results.dsh.installed ? '✅' : '⚠️'}</span>
        <span class="env-check-name">DSH</span>
        <span class="env-check-result ${results.dsh.installed ? 'success' : 'warning'}">${results.dsh.installed ? `${results.dsh.version} (${results.dsh.method})` : '未安装 (首次运行自动安装)'}</span>
        <div class="env-check-actions">${dshActions}</div>
      </div>
    `
  },

  /**
   * Auto-install the bundled Node.js runtime (callable from settings).
   */
  async autoInstallRuntime() {
    DshUtils.notify('正在下载 Node.js 运行时...')
    try {
      const result = await window.dsh.env.runtime.download({
        onProgress: (msg) => DshUtils.notify(msg),
      })
      if (result.success) {
        DshUtils.notify('Node.js 运行时安装完成')
      } else {
        DshUtils.notify('安装失败: ' + (result.error || '未知'))
      }
    } catch (err) {
      DshUtils.notify('安装失败: ' + err.message)
    }
  },

  /**
   * Install DSH (callable from settings env tab).
   */
  async installDsh() {
    const btn = document.getElementById('btn-install-dsh')
    if (btn) { btn.disabled = true; btn.textContent = '安装中...' }
    DshUtils.log('开始安装/更新 DSH...', 'info')
    const ok = await window.dsh.cli.install({
      onOutput: (text) => { DshUtils.log(text.trim(), 'info') },
    })
    if (btn) { btn.disabled = false; btn.textContent = '安装/更新 DSH' }
    DshUtils.log(ok ? 'DSH 安装/更新成功' : 'DSH 安装/更新失败', ok ? 'info' : 'error')
    DshUtils.notify(ok ? 'DSH 安装成功' : 'DSH 安装失败')
  },

  /**
   * Update DSH (callable from settings env tab).
   */
  async updateDsh() {
    return this.installDsh()
  },
  /**
   * Show the server configuration panel (main view).
   */
  showConfigPanel() {
    document.getElementById('server-config-panel').style.display = 'block'
    DshUtils.hideError()

    // Hide server info section (not running)
    document.getElementById('server-info-section').style.display = 'none'

    // Show start button, hide stop/webui/restart
    document.getElementById('btn-start-server').style.display = 'block'
    document.getElementById('btn-stop-server').style.display = 'none'
    document.getElementById('btn-open-webui').style.display = 'none'
    document.getElementById('btn-restart-server').style.display = 'none'

    DshUtils.setStatusBadge('stopped', '未运行')
  },

  /**
   * Show server running info (inline in config panel).
   */
  showServerInfo() {
    document.getElementById('server-config-panel').style.display = 'block'
    DshUtils.hideError()

    const status = window.dsh.server.getStatus()
    const isRunning = status.running

    // Show server info section
    const infoSection = document.getElementById('server-info-section')
    if (infoSection) {
      infoSection.style.display = 'block'
      document.getElementById('info-status').textContent = isRunning ? '运行中' : '已停止'
      document.getElementById('info-status').style.color = isRunning ? 'var(--color-success)' : 'var(--color-danger)'
      document.getElementById('info-url').textContent = window.dsh.server.getServerUrl()
      document.getElementById('info-pid').textContent = status.pid || '-'
      document.getElementById('info-uptime').textContent = DshUtils.formatUptime(status.uptime)
    }

    // Show/hide buttons based on running state
    document.getElementById('btn-start-server').style.display = isRunning ? 'none' : 'block'
    document.getElementById('btn-stop-server').style.display = isRunning ? 'block' : 'none'
    document.getElementById('btn-open-webui').style.display = isRunning ? 'block' : 'none'
    document.getElementById('btn-restart-server').style.display = isRunning ? 'block' : 'none'

    DshUtils.setStatusBadge(isRunning ? 'running' : 'stopped', isRunning ? '运行中' : '已停止')

    if (isRunning) {
      App.startUptimeDisplay()
    } else {
      App.stopUptimeDisplay()
    }
  },

  /**
   * Start the DSH server.
   * @param {{ workspace?: string, port?: number, profile?: string }} options
   */
  async startServer(options = {}) {
    try {
      // Workspace is managed by DSH Web UI itself; we only set cwd for the
      // server process. Use saved workspace or process.cwd() as fallback.
      const workspace = options.workspace || window.dsh.workspace.getCurrent() || process.cwd()
      const port = options.port || App.getSetting('port', 3080)
      const profile = 'web'

      App.setSetting('port', port)
      App.setSetting('profile', profile)

      // Show loading state
      DshUtils.setStatusBadge('unknown', '启动中...')
      document.getElementById('server-config-panel').style.display = 'none'

      // Show loading view
      DshUtils.showView('view-loading')
      document.getElementById('loading-text').textContent = '正在启动 DeepSeek Harness 服务器...\n首次启动可能需要安装依赖，请耐心等待。'
      this.showStartupProgress()
      this.setStartupStep('env', 'active')

      // Yield to let the browser render the loading view before blocking calls
      await new Promise(r => setTimeout(r, 50))

      // Env check step — quick prerequisites (bundled node present?)
      try {
        const prereq = window.dsh.env.checkPrerequisites({ skipDshCheck: true })
        this.setStartupStep('env', 'done',
          prereq.nodeOk ? `检查环境依赖 ✔ (${prereq.nodeVersion}${prereq.nodeSource === 'bundled' ? ' 自带运行时' : ''})` : `检查环境依赖 ✔ (${prereq.nodeVersion || 'Node 缺失'})`)
      } catch {
        this.setStartupStep('env', 'done', '检查环境依赖 ✔')
      }

      // Spawn step — start the server process
      this.setStartupStep('spawn', 'active', '启动 DSH 进程 (首次可能需要安装依赖)')
      this.startStartupLogPolling()

      DshUtils.log(`启动 DSH 服务器 (workspace=${workspace}, port=${port})`, 'info')
      // Start the server (this internally uses spawn + async polling)
      const result = await window.dsh.server.start({ workspace, port, profile })
      this.stopStartupLogPolling()

      if (result.success) {
        DshUtils.log('DSH 服务器启动成功', 'info')
        this.serverReady = true
        this.setStartupStep('spawn', 'done')
        this.setStartupStep('ready', 'done')
        this.setStartupStep('open', 'done')
        DshUtils.showView('view-server-manager')
        this.showServerInfo()

        App.addDynamicFeature(
          'dsh-quick-session',
          '快速打开 DSH 当前会话',
          ['dsh session', 'DSH 会话'],
        )

        // Auto-open Web UI
        if (typeof utools !== 'undefined' && utools.setExpendHeight) {
          utools.setExpendHeight(800)
        }
        WebUI.open()
      } else {
        this.setStartupStep('spawn', 'failed')
        this.setStartupStep('ready', 'failed')
        DshUtils.log('DSH 服务器启动失败: ' + (result.error || '未知错误'), 'error')
        DshUtils.showView('view-server-manager')
        DshUtils.setStatusBadge('stopped', '启动失败')

        const suggestions = []
        const combinedOutput = (result.stderr || '') + (result.stdout || '')
        if (combinedOutput.includes('EADDRINUSE')) {
          suggestions.push('端口被占用，请更换端口或关闭占用该端口的程序')
        }
        if (combinedOutput.includes('EACCES')) {
          const isWin = window.dsh.env.getPlatform() === 'win32'
          suggestions.push('端口访问被拒绝 — 请尝试在设置中更换端口 (如 3081)')
          if (isWin) {
            suggestions.push('检查 Windows 防火墙是否拦截了 Node.js')
            suggestions.push('尝试以管理员身份运行 uTools')
          } else {
            suggestions.push('Unix 系统下低端口需要权限，请更换为高端口')
          }
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
      }
    } catch (err) {
      DshUtils.showView('view-server-manager')
      DshUtils.setStatusBadge('stopped', '启动失败')
      DshUtils.showError('服务器启动异常', err.message || String(err), [
        '请检查环境配置后重试',
        '如持续失败，请尝试手动运行: npx @deepseek-ai/dsh web',
      ])
    }
  },

  /**
   * Stop the DSH server.
   */
  async stopServer() {
    DshUtils.setStatusBadge('unknown', '正在停止...')
    App.removeDynamicFeature('dsh-quick-session')
    await window.dsh.server.stop()
    App.stopUptimeDisplay()
    this.showConfigPanel()
  },

  /**
   * Restart the DSH server.
   */
  async restartServer() {
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
    } else {
      DshUtils.showError('重启失败', result.error || '未知错误')
    }
  },

  /**
   * Initialize event listeners.
   */
  init() {
    // Start server button
    const btnStart = document.getElementById('btn-start-server')
    if (btnStart) {
      btnStart.addEventListener('click', () => this.startServer())
    }

    // Stop server button
    const btnStop = document.getElementById('btn-stop-server')
    if (btnStop) {
      btnStop.addEventListener('click', () => this.stopServer())
    }

    // Restart server button
    const btnRestart = document.getElementById('btn-restart-server')
    if (btnRestart) {
      btnRestart.addEventListener('click', () => this.restartServer())
    }

    // Open Web UI button
    const btnOpenWebUI = document.getElementById('btn-open-webui')
    if (btnOpenWebUI) {
      btnOpenWebUI.addEventListener('click', () => WebUI.open())
    }

    // Toggle log panel
    const btnToggleLog = document.getElementById('btn-toggle-log')
    if (btnToggleLog) {
      btnToggleLog.addEventListener('click', () => DshUtils.toggleLogPanel())
    }

    // DSH skill market
    const btnMarket = document.getElementById('btn-dsh-market')
    if (btnMarket) {
      btnMarket.addEventListener('click', () => {
        if (typeof utools !== 'undefined' && utools.shellOpenExternal) {
          utools.shellOpenExternal('https://dsh-market.com/')
        }
      })
    }

    // Clear logs
    const btnClearLogs = document.getElementById('btn-clear-logs')
    if (btnClearLogs) {
      btnClearLogs.addEventListener('click', () => DshUtils.clearLogs())
    }

    // Close log panel
    const btnCloseLogs = document.getElementById('btn-close-logs')
    if (btnCloseLogs) {
      btnCloseLogs.addEventListener('click', () => DshUtils.toggleLogPanel())
    }

    // Retry button
    const btnRetry = document.getElementById('btn-retry')
    if (btnRetry) {
      btnRetry.addEventListener('click', () => {
        DshUtils.hideError()
        this.showConfigPanel()
      })
    }
  },
}

// Initialize on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  ServerManager.init()
})
