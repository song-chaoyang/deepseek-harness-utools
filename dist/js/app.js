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

    switch (action.code) {
      case 'dsh-main':
        await this.showMain(action)
        break
      case 'dsh-headless':
        await this.showHeadless(action)
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

    // Check if a DSH server is already listening (external or from previous session)
    let existing
    try {
      existing = await window.dsh.server.healthCheck()
    } catch {
      existing = { healthy: false }
    }

    if (existing.healthy) {
      const port = this.getSetting('port', 3080)
      window.dsh.server.adoptExternal(port)
      ServerManager.showServerInfo()
      this.setExpendHeight(800)
      WebUI.open()
      return
    }

    // Show full server manager: env check + config panel
    await ServerManager.checkEnvironment()
    ServerManager.showConfigPanel()
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

  async showWorkspace(action) {
    if (action.type === 'file' && action.payload) {
      const files = Array.isArray(action.payload) ? action.payload : [action.payload]
      const dir = files.find((f) => f.isDirectory)
      if (dir) {
        window.dsh.workspace.setCurrent(dir.path)
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
    if (typeof utools !== 'undefined' && utools.setExpendHeight) {
      if (height === 'max') {
        utools.setExpendHeight(0)
      } else {
        utools.setExpendHeight(height)
      }
    }
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

    // Unexpected crash — unload and show config panel
    WebUI.unload()
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
