/**
 * plugin-manager.js — DSH plugin management UI.
 *
 * Lists installed DSH plugins, allows installing/uninstalling,
 * and managing profiles.
 */

const PluginManager = {
  /** Current profile */
  currentProfile: 'web',

  /** Installed plugins */
  plugins: [],

  /** Filtered plugins for display */
  filteredPlugins: [],

  /**
   * Initialize the plugin manager.
   */
  async load() {
    // Get current profile from select
    const select = document.getElementById('pm-profile')
    if (select) {
      this.currentProfile = select.value
      select.addEventListener('change', () => {
        this.currentProfile = select.value
        this.loadPlugins()
      })
    }

    await this.loadPlugins()

    // Initialize actions
    const btnInstall = document.getElementById('btn-install-plugin')
    if (btnInstall) {
      btnInstall.addEventListener('click', () => this.installPlugin())
    }

    // Enter key in install input
    const installInput = document.getElementById('pm-install-input')
    if (installInput) {
      installInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.installPlugin()
        }
      })
    }
  },

  /**
   * Load the list of installed plugins for the current profile.
   */
  async loadPlugins() {
    const listEl = document.getElementById('plugin-list')
    if (!listEl) return

    listEl.innerHTML = `
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载插件列表...</div>
      </div>
    `

    try {
      // Run `dsh plugin --profile <name> list` to get installed plugins
      const result = await window.dsh.cli.runPlugin(this.currentProfile, ['list'], {
        onOutput: () => {},
        onError: () => {},
      })

      if (result.success) {
        this.plugins = this.parsePluginList(result.output)
        this.render()
      } else {
        // If list command fails, try `pnpm list` format
        this.plugins = this.parsePluginList(result.output || result.error || '')
        this.render()
      }
    } catch (err) {
      listEl.innerHTML = `
        <div class="workspace-empty">
          无法加载插件列表: ${DshUtils.escapeHtml(err.message)}
          <br><br>
          请确保 DSH 已安装且 Profile "${this.currentProfile}" 已初始化。
          <br>
          首次使用某个 Profile 时，DSH 会自动初始化。
        </div>
      `
    }
  },

  /**
   * Parse the output of `pnpm list` or `dsh plugin list`.
   * @param {string} output
   * @returns {Array<{ name: string, version: string, description?: string }>}
   */
  parsePluginList(output) {
    const plugins = []
    const lines = output.split('\n')

    for (const line of lines) {
      // Match pnpm list output patterns:
      // @deepseek-ai/dsh-tool-bash 1.0.0
      // → @deepseek-ai/dsh-tool-bash 1.0.0
      const match = line.match(/[@\w][\w@/.-]+\s+\d+\.\d+\.\d+/)
      if (match) {
        const parts = match[0].split(/\s+/)
        const name = parts[0]
        const version = parts[1]

        // Skip non-dsh packages
        if (name.includes('dsh') || name.includes('deepseek') || name.includes('cordis')) {
          plugins.push({
            name,
            version,
            description: '',
          })
        }
      }
    }

    return plugins
  },

  /**
   * Filter plugins by search query (called from uTools setSubInput).
   * @param {string} query
   */
  filterPlugins(query) {
    if (!query) {
      this.filteredPlugins = [...this.plugins]
    } else {
      const q = query.toLowerCase()
      this.filteredPlugins = this.plugins.filter((p) => {
        const name = (p.name || '').toLowerCase()
        const desc = (p.description || '').toLowerCase()
        return name.includes(q) || desc.includes(q)
      })
    }
    this.render()
  },

  /**
   * Render the plugin list.
   */
  render() {
    const listEl = document.getElementById('plugin-list')
    const plugins = this.filteredPlugins.length > 0 ? this.filteredPlugins : this.plugins

    if (plugins.length === 0) {
      listEl.innerHTML = `
        <div class="workspace-empty">
          Profile "${this.currentProfile}" 暂无已安装的 DSH 插件。
          <br>
          使用上方输入框安装新插件（例如: @deepseek-ai/dsh-tool-web）。
        </div>
      `
      return
    }

    let html = ''
    for (const plugin of plugins) {
      html += `
        <div class="plugin-item">
          <div class="plugin-item-info">
            <div class="plugin-item-name">${DshUtils.escapeHtml(plugin.name)}</div>
            <div class="plugin-item-desc">${DshUtils.escapeHtml(plugin.description || 'DSH 插件')}</div>
          </div>
          <span class="plugin-item-version">${DshUtils.escapeHtml(plugin.version)}</span>
          <button class="btn btn-sm btn-danger" data-uninstall="${DshUtils.escapeHtml(plugin.name)}">卸载</button>
        </div>
      `
    }
    listEl.innerHTML = html

    // Attach uninstall handlers
    listEl.querySelectorAll('[data-uninstall]').forEach((btn) => {
      btn.addEventListener('click', () => this.uninstallPlugin(btn.dataset.uninstall))
    })
  },

  /**
   * Install a plugin.
   */
  async installPlugin() {
    const input = document.getElementById('pm-install-input')
    const packageName = input.value.trim()

    if (!packageName) {
      alert('请输入插件包名')
      return
    }

    const btn = document.getElementById('btn-install-plugin')
    btn.disabled = true
    btn.textContent = '安装中...'

    const listEl = document.getElementById('plugin-list')
    listEl.innerHTML = `
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <div class="loading-text" id="install-progress">正在安装 ${DshUtils.escapeHtml(packageName)}...</div>
      </div>
    `

    const result = await window.dsh.cli.runPlugin(
      this.currentProfile,
      ['add', packageName],
      {
        onOutput: (text) => {
          const progress = document.getElementById('install-progress')
          if (progress) {
            progress.textContent = `正在安装 ${packageName}...\n${text.slice(-300)}`
          }
        },
        onError: (text) => {
          const progress = document.getElementById('install-progress')
          if (progress) {
            progress.textContent = `正在安装 ${packageName}...\n${text.slice(-300)}`
          }
        },
      },
    )

    btn.disabled = false
    btn.textContent = '安装'

    if (result.success) {
      DshUtils.notify(`插件 "${packageName}" 安装成功`)
      input.value = ''
      await this.loadPlugins()
    } else {
      DshUtils.notify(`安装失败: ${result.error || '未知错误'}`)
      listEl.innerHTML = `
        <div class="workspace-empty">
          安装失败: ${DshUtils.escapeHtml(result.error || '未知错误')}
          <br>
          <button class="btn btn-secondary btn-sm" onclick="PluginManager.loadPlugins()">返回列表</button>
        </div>
      `
    }
  },

  /**
   * Uninstall a plugin.
   * @param {string} packageName
   */
  async uninstallPlugin(packageName) {
    if (!confirm(`确定要卸载插件 "${packageName}" 吗？`)) return

    const btn = document.querySelector(`[data-uninstall="${packageName}"]`)
    if (btn) {
      btn.disabled = true
      btn.textContent = '卸载中...'
    }

    const result = await window.dsh.cli.runPlugin(
      this.currentProfile,
      ['remove', packageName],
      {},
    )

    if (result.success) {
      DshUtils.notify(`插件 "${packageName}" 已卸载`)
      await this.loadPlugins()
    } else {
      DshUtils.notify(`卸载失败: ${result.error || '未知错误'}`)
      if (btn) {
        btn.disabled = false
        btn.textContent = '卸载'
      }
    }
  },
}
