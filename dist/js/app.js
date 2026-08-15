/**
 * app.js — Main application router and event handler.
 *
 * Handles uTools plugin entry events and routes to the appropriate view
 * based on the feature code. Integrates uTools APIs: setSubInput,
 * setExpendHeight, onPluginDetach, dynamic features, redirect.
 */

const App = {
  /** Current feature code */
  currentCode: null,

  /** Enter action data */
  enterAction: null,

  /** Uptime timer interval */
  uptimeInterval: null,

  /**
   * Initialize the app on plugin enter.
   * Called by utools.onPluginEnter.
   * @param {object} action - PluginEnterAction
   */
  async onEnter(action) {
    this.currentCode = action.code
    this.enterAction = action

    // Apply theme
    DshUtils.applyTheme()

    // Remove any existing sub-input
    this.removeSubInput()

    // Route to the appropriate view
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
        // Dynamic feature codes (e.g., dsh-session-xxx)
        if (action.code.startsWith('dsh-session-')) {
          await this.openSessionByCode(action.code, action)
        } else {
          await this.showMain(action)
        }
    }
  },

  /**
   * Main view — server management + Web UI.
   */
  async showMain(action) {
    DshUtils.showView('view-server-manager')
    DshUtils.hideError()
    this.setExpendHeight(600)

    // Check environment first (fast check, non-blocking)
    await ServerManager.checkEnvironment()

    // Check if server is already running
    const status = window.dsh.server.getStatus()
    if (status.running) {
      ServerManager.showServerInfo()
      const autoOpen = this.getSetting('autoOpenWebUI', true)
      if (autoOpen) {
        WebUI.open()
      }
    } else {
      // Show config panel — user clicks "启动服务器" manually
      // (auto-start removed: it blocks UI for 120s via waitForReady)
      ServerManager.showConfigPanel()
    }
  },

  /**
   * Headless task runner view.
   */
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

  /**
   * Settings view.
   */
  async showSettings(action) {
    DshUtils.showView('view-settings')
    this.setExpendHeight(600)
    await Settings.init()
  },

  /**
   * Sessions browser view.
   */
  async showSessions(action) {
    DshUtils.showView('view-sessions')
    this.setExpendHeight(600)
    // Set up sub-input for search
    this.setSubInput((value) => {
      SessionBrowser.search(value)
    }, '搜索会话...')
    await SessionBrowser.load()
  },

  /**
   * Plugin manager view.
   */
  async showPluginManager(action) {
    DshUtils.showView('view-plugin-mgr')
    this.setExpendHeight(600)
    this.setSubInput((value) => {
      PluginManager.filterPlugins(value)
    }, '搜索插件...')
    await PluginManager.load()
  },

  /**
   * Workspace selector view.
   */
  async showWorkspace(action) {
    if (action.type === 'file' && action.payload) {
      const files = Array.isArray(action.payload) ? action.payload : [action.payload]
      const dir = files.find((f) => f.isDirectory)
      if (dir) {
        window.dsh.workspace.add(dir.path)
        window.dsh.workspace.setCurrent(dir.path)
        DshUtils.showView('view-server-manager')
        this.setExpendHeight(600)
        await ServerManager.checkEnvironment()
        const port = this.getSetting('port', 3080)
        await ServerManager.startServer({ workspace: dir.path, port, profile: 'web' })
        return
      }
    }

    DshUtils.showView('view-server-manager')
    this.setExpendHeight(600)
    await ServerManager.checkEnvironment()
    ServerManager.showConfigPanel()
  },

  /**
   * Goals view.
   */
  async showGoals(action) {
    DshUtils.showView('view-sessions')
    this.setExpendHeight(600)
    await GoalManager.load()
  },

  /**
   * Open a session by dynamic feature code.
   */
  async openSessionByCode(code, action) {
    const sessionId = code.replace('dsh-session-', '')
    // Ensure server is running
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

  /**
   * Set sub-input for search/filtering.
   * @param {Function} callback
   * @param {string} placeholder
   */
  setSubInput(callback, placeholder = '搜索...') {
    if (typeof utools !== 'undefined' && utools.setSubInput) {
      utools.setSubInput(({ text }) => {
        callback(text)
      }, placeholder)
    }
  },

  /**
   * Remove sub-input.
   */
  removeSubInput() {
    if (typeof utools !== 'undefined' && utools.removeSubInput) {
      utools.removeSubInput()
    }
  },

  /**
   * Set the plugin window height.
   * @param {number} height - pixels, or 'max' for full height
   */
  setExpendHeight(height) {
    if (typeof utools !== 'undefined' && utools.setExpendHeight) {
      if (height === 'max') {
        utools.setExpendHeight(0) // 0 = auto/max in some uTools versions
      } else {
        utools.setExpendHeight(height)
      }
    }
  },

  /**
   * Redirect to another feature.
   * @param {string} code - feature code
   * @param {*} payload - payload to pass
   */
  redirect(code, payload) {
    if (typeof utools !== 'undefined' && utools.redirect) {
      utools.redirect(code, payload)
    }
  },

  /**
   * Add a dynamic feature (e.g., quick-access to current session).
   * @param {string} code
   * @param {string} explain
   * @param {string[]} cmds
   */
  addDynamicFeature(code, explain, cmds) {
    if (typeof utools !== 'undefined' && utools.setFeature) {
      utools.setFeature({ code, explain, cmds })
    }
  },

  /**
   * Remove a dynamic feature.
   * @param {string} code
   */
  removeDynamicFeature(code) {
    if (typeof utools !== 'undefined' && utools.removeFeature) {
      utools.removeFeature(code)
    }
  },

  /**
   * Take a screenshot and get the base64 image.
   * @returns {Promise<string|null>}
   */
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

  /**
   * Paste text to the previously active window.
   * @param {string} text
   */
  pasteToPreviousWindow(text) {
    if (typeof utools !== 'undefined' && utools.hideMainWindowPasteText) {
      utools.hideMainWindowPasteText(text)
    }
  },

  /**
   * Get a setting from uTools dbStorage.
   * @param {string} key
   * @param {*} defaultValue
   * @returns {*}
   */
  getSetting(key, defaultValue) {
    if (typeof utools !== 'undefined' && utools.dbStorage) {
      const val = utools.dbStorage.getItem(`dsh-setting-${key}`)
      return val !== null && val !== undefined ? val : defaultValue
    }
    return defaultValue
  },

  /**
   * Save a setting to uTools dbStorage.
   * @param {string} key
   * @param {*} value
   */
  setSetting(key, value) {
    if (typeof utools !== 'undefined' && utools.dbStorage) {
      utools.dbStorage.setItem(`dsh-setting-${key}`, value)
    }
  },

  /**
   * Start the uptime display interval.
   */
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

  /**
   * Stop the uptime display interval.
   */
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
    if (isKill) {
      const keepRunning = App.getSetting('backgroundRun', false)
      if (!keepRunning) {
        window.dsh.server.stop()
      }
    }
  })

  // Listen for DSH server process exit — update UI immediately
  window.addEventListener('dsh-server-exited', (e) => {
    App.stopUptimeDisplay()
    DshUtils.setStatusBadge('stopped', '已停止')
    // If currently showing Web UI, switch back to server manager
    const webUIView = document.getElementById('view-web-ui')
    if (webUIView && webUIView.classList.contains('active')) {
      DshUtils.showView('view-server-manager')
      ServerManager.showConfigPanel()
    }
  })

  // Handle detach (separate window)
  if (utools.onPluginDetach) {
    utools.onPluginDetach(() => {
      // Keep server running when detached
      App.setSetting('backgroundRun', true)
    })
  }

  // Listen for dark mode changes
  if (utools.onThemeChange) {
    utools.onThemeChange(() => {
      DshUtils.applyTheme()
    })
  }
}
