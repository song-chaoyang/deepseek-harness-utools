/**
 * app.js — Main application router and event handler.
 */

// Global error handler — catches ALL uncaught errors and shows them in UI
window.addEventListener('error', (e) => {
  console.error('[dsh] Uncaught error:', e.error || e.message)
  const panel = document.getElementById('error-panel')
  if (panel && e.message) {
    const title = document.getElementById('error-title')
    const msg = document.getElementById('error-message')
    if (title) title.textContent = '发生错误'
    if (msg) msg.textContent = e.message + (e.error && e.error.stack ? '\n' + e.error.stack : '')
    panel.style.display = 'block'
  }
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[dsh] Unhandled rejection:', e.reason)
})

window.App = {
  currentCode: null,
  enterAction: null,
  uptimeInterval: null,
  /** When true, suppress dsh-server-exited from switching views (intentional stop/restart) */
  suppressExitView: false,

  async onEnter(action) {
    this.currentCode = action.code
    this.enterAction = action

    DshUtils.applyTheme()
    this.removeSubInput()
    SessionWatcher.start()

    switch (action.code) {
      case 'dsh-main':
        await this.showMain(action)
        break
      case 'dsh-webui':
        await this.showWebUIEntry(action)
        break
      case 'dsh-headless':
        await this.showHeadless(action)
        break
      case 'dsh-quick-task':
        await this.showQuickTask(action)
        break
      case 'dsh-file-task':
        await this.showFileTask(action)
        break
      case 'dsh-sessions':
        await this.showSessions(action)
        break
      case 'dsh-plugin-mgr':
        await this.showPluginManager(action)
        break
      case 'dsh-workspace':
        await this.showWorkspace(action)
        break
      case 'dsh-goals':
        await this.showGoals(action)
        break
      default:
        if (action.code.startsWith('dsh-session-')) {
          await this.openSessionByCode(action.code, action)
        } else {
          await this.showMain(action)
        }
    }
  },

  /**
   * Main view — server manager with env check + start button.
   * If a server is already running, adopts it and opens Web UI.
   */
  async showMain(action) {
    DshUtils.showView('view-server-manager')
    DshUtils.hideError()
    this.setExpendHeight(600)

    // Ensure button listeners are attached (in case DOMContentLoaded already fired)
    ServerManager.init()
    WebUI.init()

    // Yield to let the view render
    await new Promise(r => setTimeout(r, 30))

    // Check if server is already running (managed by us)
    const status = window.dsh.server.getStatus()
    if (status.running) {
      ServerManager.showServerInfo()
      const autoOpen = this.getSetting('autoOpenWebUI', true)
      if (autoOpen) {
        this.setExpendHeight(800)
        WebUI.open()
      }
      return
    }

    // SANDBOX MODE: never adopt foreign DSH servers (VS Code panel, CLI,
    // leftovers on the configured port). start() cleans OUR OWN orphans
    // and otherwise picks a free port — external resources stay untouched
    // and the plugin instance stays fully isolated.

    // Auto-start on plugin entry (设置 → 服务器设置 → "进入插件时自动启动
    // 服务器"，默认开)：省掉手动点"启动服务器"；失败则回落到配置面板。
    if (this.getSetting('autoStart', true)) {
      const port = this.getSetting('port', 3080)
      const workspace = window.dsh.workspace.getCurrent()
      DshUtils.setStatusBadge('starting', '自动启动服务器中…')
      // Render the manager view (env card + config panel) BEFORE awaiting
      // start — startup can take tens of seconds and an empty view looks
      // like a broken/blank plugin.
      const envReady = ServerManager.checkEnvironment()
      ServerManager.showConfigPanel()
      try {
        const res = await window.dsh.server.start({ workspace, port, profile: 'web' })
        if (res && res.success === false) throw new Error(res.error)
        if (window.dsh.server.getStatus().running) {
          ServerManager.showServerInfo()
          if (this.getSetting('autoOpenWebUI', true)) {
            this.setExpendHeight(800)
            WebUI.open()
          }
          return
        }
      } catch (err) {
        console.warn('[dsh] auto-start failed:', err.message)
        // Bounded recovery: the preload may auto-restart a crashed process,
        // or a slow process may bind the port after a false-negative start.
        // Adopt the server when it comes up instead of reporting failure.
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          if (window.dsh.server.getStatus().running) {
            DshUtils.hideError()
            ServerManager.showServerInfo()
            if (this.getSetting('autoOpenWebUI', true)) {
              this.setExpendHeight(800)
              WebUI.open()
            }
            return
          }
        }
        DshUtils.showError('服务器启动失败', err.message || '未知错误')
        await envReady
        ServerManager.showConfigPanel()
        return
      }
    }

    // Show full server manager: env check + config panel
    await ServerManager.checkEnvironment()
    ServerManager.showConfigPanel()
  },

  /**
   * dsh-webui — 启动服务器（如未运行）并直接打开 Web UI。
   * 供全局快捷键（设置 → 服务器设置 → "设置『打开 DSH Web UI』快捷键"）
   * 与 "dsh web" 功能指令使用。
   */
  async showWebUIEntry(action) {
    const status = window.dsh.server.getStatus()
    if (!status.running) {
      const port = this.getSetting('port', 3080)
      const workspace = window.dsh.workspace.getCurrent()
      DshUtils.showView('view-server-manager')
      DshUtils.setStatusBadge('starting', '正在启动服务器…')
      // Content while waiting — empty view looks broken during startup
      ServerManager.checkEnvironment()
      ServerManager.showConfigPanel()
      try {
        const res = await window.dsh.server.start({ workspace, port, profile: 'web' })
        if (res && res.success === false) throw new Error(res.error)
      } catch (err) {
        console.error('[dsh] dsh-webui start failed:', err.message)
        DshUtils.setStatusBadge('stopped', '启动失败')
        DshUtils.showError('服务器启动失败', err.message || '未知错误')
        return
      }
    }
    ServerManager.showServerInfo()
    this.setExpendHeight(800)
    WebUI.open()
  },

  async showHeadless(action) {
    DshUtils.showView('view-headless')
    this.setExpendHeight(500)

    if (action.type === 'text' && action.payload) {
      const taskEl = document.getElementById('headless-task')
      if (taskEl) taskEl.value = action.payload
    }

    const workspace = window.dsh.workspace.getCurrent()
    if (workspace) {
      document.getElementById('headless-workspace').value = workspace
    }

    await HeadlessRunner.loadModels()
    HeadlessRunner.renderHistory()
  },

  /**
   * Open the headless view with a prefilled task (and optional workspace).
   * Used by the matched-cmd entries: 选中文本 (over) / 拖入文件 (files) /
   * history re-run. Shows the view, fills the form, loads models + history.
   * @param {string} task
   * @param {string|null} workspace
   */
  async prefillHeadless(task, workspace) {
    DshUtils.showView('view-headless')
    this.setExpendHeight(500)

    const taskEl = document.getElementById('headless-task')
    if (taskEl && task) {
      taskEl.value = task
      // Put the caret at the end so the user can append their own ask
      setTimeout(() => {
        taskEl.focus()
        const len = taskEl.value.length
        taskEl.setSelectionRange(len, len)
      }, 50)
    }
    const wsEl = document.getElementById('headless-workspace')
    const ws = workspace || window.dsh.workspace.getCurrent()
    if (wsEl && ws) wsEl.value = ws

    await HeadlessRunner.loadModels()
    HeadlessRunner.renderHistory()
  },

  /**
   * dsh-quick-task — 选中文本交给 DSH 处理（over 匹配指令 / 全局快捷键
   * autocopy / 功能指令手动进入）。
   */
  async showQuickTask(action) {
    if ((action.type === 'over' || action.type === 'regex') && action.payload) {
      const text = String(action.payload).trim()
      await this.prefillHeadless(
        text + '\n\n（请处理以上内容：分析 / 重构 / 解释 / 翻译…）',
        null,
      )
      return
    }
    // 功能指令（"dsh 处理"）— 空表单进入
    await this.showHeadless(action)
  },

  /**
   * dsh-file-task — 拖入/选中文件交给 DSH 分析（files 匹配指令）。
   */
  async showFileTask(action) {
    if (action.type === 'files' && Array.isArray(action.payload) && action.payload.length) {
      const list = action.payload.map((f) => '- ' + f.path).join('\n')
      const first = action.payload[0]
      // Workspace = first file's directory, so relative reads resolve
      const wsPath = (first.path.replace(/\\/g, '/').match(/^(.*)\/[^/]+$/) || [])[1] || null
      await this.prefillHeadless(
        '请分析以下文件（可读取其内容）：\n' + list + '\n\n（补充你的具体要求）',
        wsPath,
      )
      return
    }
    await this.showHeadless(action)
  },

  async showSessions(action) {
    DshUtils.showView('view-sessions')
    this.setExpendHeight(600)
    this.setSubInput((value) => {
      SessionBrowser.search(value)
    }, '搜索会话...')
    await SessionBrowser.load()
  },

  async showPluginManager(action) {
    DshUtils.showView('view-plugin-mgr')
    this.setExpendHeight(600)
    this.setSubInput((value) => {
      PluginManager.filterPlugins(value)
    }, '搜索插件...')
    await PluginManager.load()
  },

  /**
   * Plugin center entry — invoked from the WebUI toolbar 🧩 button and the
   * server-manager panel button. Same view as the "dsh plugins" keyword.
   */
  async openPluginCenter() {
    this.rememberReturnView()
    await this.showPluginManager({ code: 'dsh-plugin-mgr' })
  },

  /**
   * Remember the active view before switching to a secondary view, so the
   * secondary view's back button returns the user where they came from.
   */
  rememberReturnView() {
    const cur = document.querySelector('.view.active')
    this._returnView = cur && cur.id ? cur.id : 'view-server-manager'
  },

  /**
   * Back from a secondary view (plugin manager / sessions / headless /
   * settings). Returns to the remembered view, or the server manager when
   * the secondary view was entered directly via a uTools keyword.
   */
  backFromSubView() {
    const target = this._returnView && document.getElementById(this._returnView)
      ? this._returnView
      : 'view-server-manager'
    const finalTarget = target === 'view-web-ui' && !window.dsh.server.getStatus().running
      ? 'view-server-manager'
      : target
    this._returnView = null
    this.removeSubInput()

    if (finalTarget === 'view-web-ui') {
      WebUI.open()
      return
    }

    DshUtils.showView(finalTarget)
    this.setExpendHeight(600)
    ServerManager.showServerInfo()
  },

  /**
   * Back to the server-manager view from the WebUI toolbar.
   */
  backToManager() {
    DshUtils.showView('view-server-manager')
    this.setExpendHeight(600)
    ServerManager.showServerInfo()
  },

  async showWorkspace(action) {
    // Official MatchFile payload arrives with type 'files' (plural) — see
    // api-reference/events.md PluginEnterAction. Accepts the directory drop.
    if ((action.type === 'files' || action.type === 'file') && action.payload) {
      const files = Array.isArray(action.payload) ? action.payload : [action.payload]
      const dir = files.find((f) => f.isDirectory)
      if (dir) {
        window.dsh.workspace.setCurrent(dir.path)
        // Directory dropped → make it live immediately: start (sandboxed)
        // server on it and open the Web UI, instead of just parking the path.
        const status = window.dsh.server.getStatus()
        if (!status.running) {
          const port = this.getSetting('port', 3080)
          try {
            await window.dsh.server.start({ workspace: dir.path, port, profile: 'web' })
          } catch { /* fall through to the manager view */ }
        }
        const nowRunning = window.dsh.server.getStatus().running
        if (nowRunning) {
          ServerManager.showServerInfo()
          WebUI.open()
          return
        }
      }
    }

    DshUtils.showView('view-server-manager')
    this.setExpendHeight(600)
    await ServerManager.checkEnvironment()
    ServerManager.showConfigPanel()
  },

  async showGoals(action) {
    DshUtils.showView('view-sessions')
    this.setExpendHeight(600)
    await GoalManager.load()
  },

  async openSessionByCode(code, action) {
    const sessionId = code.replace('dsh-session-', '')
    const status = window.dsh.server.getStatus()
    if (!status.running) {
      const port = this.getSetting('port', 3080)
      const workspace = window.dsh.workspace.getCurrent()
      await window.dsh.server.start({ workspace, port, profile: 'web' })
    }
    WebUI.open()
  },

  // ============================================================
  //  uTools API wrappers
  // ============================================================

  setSubInput(callback, placeholder = '搜索...') {
    if (typeof utools !== 'undefined' && utools.setSubInput) {
      utools.setSubInput(({ text }) => {
        callback(text)
      }, placeholder)
    }
  },

  removeSubInput() {
    if (typeof utools !== 'undefined' && utools.removeSubInput) {
      utools.removeSubInput()
    }
  },

  setExpendHeight(height) {
    // 官方 API 为 utools.setExpandHeight（uTools 8.0 文档 api-reference/window.md，
    // 返回 boolean：主窗口场景成功、非主窗口返回 false）；旧版本 uTools 拼作
    // setExpendHeight。优先调用文档定义的 API，旧版运行环境回退到旧拼写。
    // height 为 DIP 数值；历史版本曾用 0 表示"最大化"，实测 0 会把窗口塌缩为
    // 不可见，已移除该特殊值，只接受数字。
    if (typeof utools === 'undefined') return
    const fn = utools.setExpandHeight || utools.setExpendHeight
    if (typeof fn !== 'function') return
    fn.call(utools, height)
  },

  redirect(code, payload) {
    if (typeof utools !== 'undefined' && utools.redirect) {
      utools.redirect(code, payload)
    }
  },

  addDynamicFeature(code, explain, cmds) {
    if (typeof utools !== 'undefined' && utools.setFeature) {
      utools.setFeature({ code, explain, cmds })
    }
  },

  removeDynamicFeature(code) {
    if (typeof utools !== 'undefined' && utools.removeFeature) {
      utools.removeFeature(code)
    }
  },

  async screenCapture() {
    return new Promise((resolve) => {
      if (typeof utools !== 'undefined' && utools.screenCapture) {
        utools.screenCapture((image) => {
          resolve(image || null)
        })
      } else {
        resolve(null)
      }
    })
  },

  pasteToPreviousWindow(text) {
    if (typeof utools !== 'undefined' && utools.hideMainWindowPasteText) {
      utools.hideMainWindowPasteText(text)
    }
  },

  getSetting(key, defaultValue) {
    if (typeof utools !== 'undefined' && utools.dbStorage) {
      const val = utools.dbStorage.getItem(`dsh-setting-${key}`)
      return val !== null && val !== undefined ? val : defaultValue
    }
    return defaultValue
  },

  setSetting(key, value) {
    if (typeof utools !== 'undefined' && utools.dbStorage) {
      utools.dbStorage.setItem(`dsh-setting-${key}`, value)
    }
  },

  startUptimeDisplay() {
    this.stopUptimeDisplay()
    this.uptimeInterval = setInterval(() => {
      const status = window.dsh.server.getStatus()
      const uptimeEl = document.getElementById('info-uptime')
      if (uptimeEl && status.running) {
        uptimeEl.textContent = DshUtils.formatUptime(status.uptime)
      }
    }, 1000)
  },

  stopUptimeDisplay() {
    if (this.uptimeInterval) {
      clearInterval(this.uptimeInterval)
      this.uptimeInterval = null
    }
  },
}

// ============================================================
//  uTools Event Registration
// ============================================================

if (typeof utools !== 'undefined') {
  utools.onPluginEnter((action) => {
    App.onEnter(action)
  })

  utools.onPluginOut((isKill) => {
    App.stopUptimeDisplay()
    App.removeSubInput()
    SessionWatcher.stop()
    // Unload iframe to stop background requests
    WebUI.unload()
    if (isKill) {
      const keepRunning = App.getSetting('backgroundRun', false)
      if (!keepRunning) {
        App.suppressExitView = true
        window.dsh.server.stop()
      }
    }
  })

  // Listen for DSH server process exit
  window.addEventListener('dsh-server-exited', (e) => {
    App.stopUptimeDisplay()

    // If this is an intentional stop/restart, don't switch views
    if (App.suppressExitView) {
      App.suppressExitView = false
      return
    }

    WebUI.unload()
    const auto = e.detail && e.detail.autoRestart

    // Crash detected — the preload already scheduled an auto-restart
    // (设置 → 服务器设置 → "服务器崩溃后自动重启"). Show progress and
    // re-check once the backoff + a start should have completed.
    if (auto) {
      const { attempt, max, delay } = auto
      DshUtils.setStatusBadge('starting', `检测到崩溃，自动重启中 (${attempt}/${max})…`)
      DshUtils.notify(`DSH 服务器已崩溃，${Math.round(delay / 1000)} 秒后自动重启（第 ${attempt}/${max} 次）`)
      setTimeout(() => {
        if (window.dsh.server.getStatus().running) {
          DshUtils.showView('view-server-manager')
          ServerManager.showServerInfo()
          if (App.getSetting('autoOpenWebUI', true)) {
            App.setExpendHeight(800)
            WebUI.open()
          }
        } else {
          DshUtils.setStatusBadge('stopped', '已停止')
          ServerManager.showConfigPanel()
        }
      }, delay + 8000)
      return
    }

    // Unexpected crash without auto-restart (disabled or retries exhausted)
    DshUtils.showView('view-server-manager')
    DshUtils.setStatusBadge('stopped', '已停止')
    ServerManager.showConfigPanel()
  })

  if (utools.onPluginDetach) {
    utools.onPluginDetach(() => {
      App.setSetting('backgroundRun', true)
    })
  }

  if (utools.onThemeChange) {
    utools.onThemeChange(() => {
      DshUtils.applyTheme()
    })
  }
}
