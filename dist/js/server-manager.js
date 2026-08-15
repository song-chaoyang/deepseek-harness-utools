/**
 * server-manager.js — DSH server lifecycle management UI.
 *
 * Handles environment checking, server start/stop/restart,
 * and displays server status information.
 */

const ServerManager = {
  /** Environment check results */
  envResults: null,

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
              ❌ Node.js 22.19+ 未安装
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

    // Async DSH check (non-blocking — hasDshInstalled uses execSync with 30s timeout)
    setTimeout(() => {
      try {
        const dshResult = window.dsh.env.hasDshInstalled()
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
              const { execSync } = require('child_process')
              execSync('npm install -g pnpm', { stdio: 'pipe', timeout: 60000 })
              btn.textContent = '安装成功'
              DshUtils.notify('pnpm 安装成功，请重新检测环境')
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
          const ok = await window.dsh.cli.install({
            onOutput: (text) => { btn.textContent = '更新中... ' + text.slice(-50) },
          })
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
        <span class="env-check-name">Node.js 22.19+</span>
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
    const ok = await window.dsh.cli.install({})
    if (btn) { btn.disabled = false; btn.textContent = '安装/更新 DSH' }
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

    // Populate workspace dropdown
    this.refreshWorkspaceSelect()

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
   * Refresh the workspace dropdown from saved workspaces.
   */
  refreshWorkspaceSelect() {
    const select = document.getElementById('config-workspace-select')
    if (!select) return

    const workspaces = window.dsh.workspace.list()
    const current = window.dsh.workspace.getCurrent()

    if (workspaces.length === 0) {
      select.innerHTML = '<option value="">请选择工作区...</option>'
      return
    }

    // Sort by last used
    workspaces.sort((a, b) => b.lastUsed - a.lastUsed)

    select.innerHTML = workspaces.map(ws =>
      `<option value="${DshUtils.escapeHtml(ws.path)}"${ws.path === current ? ' selected' : ''}>${DshUtils.escapeHtml(ws.name)} — ${DshUtils.escapeHtml(ws.path)}</option>`
    ).join('')
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
      const workspace = options.workspace || document.getElementById('config-workspace-select')?.value || window.dsh.workspace.getCurrent() || process.cwd()
      const port = options.port || App.getSetting('port', 3080)
      const profile = 'web'

      // Validate workspace
      if (!window.dsh.workspace.validate(workspace)) {
        DshUtils.showError('工作区无效', `路径不存在或不是目录: ${workspace}`, [
          '请选择一个有效的工作区目录',
          '点击"浏览"按钮选择目录',
        ])
        return
      }

      // Save workspace
      window.dsh.workspace.add(workspace)
      window.dsh.workspace.setCurrent(workspace)
      App.setSetting('port', port)
      App.setSetting('profile', profile)

      // Show loading state
      DshUtils.setStatusBadge('unknown', '启动中...')
      document.getElementById('server-config-panel').style.display = 'none'

      // Show loading view
      DshUtils.showView('view-loading')
      document.getElementById('loading-text').textContent = '正在启动 DeepSeek Harness 服务器...\n首次启动可能需要安装依赖，请耐心等待。'

      // Yield to let the browser render the loading view before blocking calls
      await new Promise(r => setTimeout(r, 50))

      // Start the server (this internally uses spawn + async polling)
      const result = await window.dsh.server.start({ workspace, port, profile })

      if (result.success) {
        this.serverReady = true
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
        DshUtils.showView('view-server-manager')
        DshUtils.setStatusBadge('stopped', '启动失败')

        const suggestions = []
        const combinedOutput = (result.stderr || '') + (result.stdout || '')
        if (combinedOutput.includes('EADDRINUSE')) {
          suggestions.push('端口被占用，请更换端口或关闭占用该端口的程序')
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

    // Select workspace button (browse for new folder)
    const btnSelectWs = document.getElementById('btn-select-workspace')
    if (btnSelectWs) {
      btnSelectWs.addEventListener('click', () => {
        const folder = DshUtils.selectFolder()
        if (folder) {
          window.dsh.workspace.add(folder)
          window.dsh.workspace.setCurrent(folder)
          this.refreshWorkspaceSelect()
        }
      })
    }

    // Workspace select change
    const wsSelect = document.getElementById('config-workspace-select')
    if (wsSelect) {
      wsSelect.addEventListener('change', () => {
        const selected = wsSelect.value
        if (selected) {
          window.dsh.workspace.setCurrent(selected)
        }
      })
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
