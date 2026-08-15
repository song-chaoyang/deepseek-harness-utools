/**
 * settings.js — Settings page for DSH configuration.
 *
 * Manages model providers, API keys, workspaces, server settings,
 * environment checks, and advanced Cordis configuration.
 */

const Settings = {
  /** Current active tab */
  activeTab: 'models',

  /**
   * Initialize the settings page.
   */
  async init() {
    this.initTabs()
    await this.loadModelsTab()
    await this.loadWorkspaceTab()
    await this.loadDshWorkspaces()
    await this.loadPresetsTab()
    await this.loadSkillsTab()
    this.loadServerTab()
    await this.loadEnvTab()
    await this.loadAdvancedTab()
    this.initActions()
  },

  /**
   * Initialize tab switching.
   */
  initTabs() {
    const tabs = document.querySelectorAll('.settings-tabs .tab')
    const contents = document.querySelectorAll('.tab-content')

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab

        tabs.forEach((t) => t.classList.remove('active'))
        contents.forEach((c) => c.classList.remove('active'))

        tab.classList.add('active')
        const content = document.querySelector(`.tab-content[data-tab="${target}"]`)
        if (content) content.classList.add('active')

        this.activeTab = target
      })
    })
  },

  // ============================================================
  //  Models Tab
  // ============================================================

  /**
   * Load the models configuration tab.
   */
  async loadModelsTab() {
    // Check if DeepSeek API key is configured
    const creds = window.dsh.config.getCredentials()
    const hasDeepSeekKey = creds.deepseek && creds.deepseek.apiKey

    const statusEl = document.querySelector('#provider-deepseek .provider-status')
    if (hasDeepSeekKey) {
      statusEl.textContent = '已配置'
      statusEl.classList.add('configured')
    } else {
      statusEl.textContent = '未配置'
      statusEl.classList.remove('configured')
    }

    // Load custom providers from settings
    const settings = window.dsh.config.getSettings()
    const providers = settings['llm-pi-ai']?.providers || {}
    const listEl = document.getElementById('custom-provider-list')

    const providerNames = Object.keys(providers).filter((name) => name !== 'deepseek')
    if (providerNames.length === 0) {
      listEl.innerHTML = '<h3>已添加的 Provider</h3><div class="provider-empty">暂无自定义 Provider</div>'
    } else {
      let html = '<h3>已添加的 Provider</h3>'
      for (const name of providerNames) {
        const provider = providers[name]
        html += `
          <div class="provider-card">
            <div class="provider-header">
              <h3>${DshUtils.escapeHtml(name)}</h3>
              <span class="provider-status configured">${provider.api || 'unknown'}</span>
            </div>
            <div class="provider-body">
              <div style="font-size:12px;color:var(--color-text-secondary)">
                Base URL: ${DshUtils.escapeHtml(provider.baseURL || 'N/A')}<br>
                API: ${DshUtils.escapeHtml(provider.api || 'N/A')}<br>
                Models: ${(provider.models || []).map((m) => DshUtils.escapeHtml(m.id || m)).join(', ') || 'N/A'}
              </div>
              <button class="btn btn-danger btn-sm" data-remove-provider="${DshUtils.escapeHtml(name)}">移除</button>
            </div>
          </div>
        `
      }
      listEl.innerHTML = html

      // Attach remove handlers
      listEl.querySelectorAll('[data-remove-provider]').forEach((btn) => {
        btn.addEventListener('click', () => this.removeProvider(btn.dataset.removeProvider))
      })
    }
  },

  /**
   * Save the DeepSeek API key.
   */
  async saveDeepSeekKey() {
    const input = document.getElementById('deepseek-api-key')
    const apiKey = input.value.trim()
    if (!apiKey) {
      alert('请输入 API Key')
      return
    }

    // Save to DSH credentials (encrypted file)
    const ok = window.dsh.config.saveDeepSeekApiKey(apiKey)

    // Also save a reference in uTools encrypted storage
    if (typeof utools !== 'undefined' && utools.dbCryptoStorage) {
      utools.dbCryptoStorage.setItem('dsh-deepseek-api-key', apiKey)
    }

    if (ok) {
      DshUtils.notify('DeepSeek API Key 已保存')
      input.value = ''
      this.loadModelsTab()
    } else {
      alert('保存失败，请检查 DSH Home 目录权限')
    }
  },

  /**
   * Add a custom provider.
   */
  addProvider() {
    // Simple inline form for adding a provider
    const listEl = document.getElementById('custom-provider-list')
    const formHtml = `
      <div class="provider-card" id="add-provider-form">
        <div class="provider-header">
          <h3>添加 Provider</h3>
          <button class="btn btn-sm btn-danger" id="btn-cancel-add-provider">取消</button>
        </div>
        <div class="provider-body">
          <div class="form-row">
            <label for="new-provider-id">Provider ID (小写)</label>
            <input type="text" id="new-provider-id" placeholder="my-gateway">
          </div>
          <div class="form-row">
            <label for="new-provider-name">显示名称</label>
            <input type="text" id="new-provider-name" placeholder="My Gateway">
          </div>
          <div class="form-row">
            <label for="new-provider-url">Base URL</label>
            <input type="text" id="new-provider-url" placeholder="https://api.example.com/v1">
          </div>
          <div class="form-row">
            <label for="new-provider-api">API 协议</label>
            <select id="new-provider-api">
              <option value="openai-completions">OpenAI Completions</option>
              <option value="anthropic">Anthropic</option>
              <option value="deepseek">DeepSeek</option>
            </select>
          </div>
          <div class="form-row">
            <label for="new-provider-key">API Key</label>
            <input type="password" id="new-provider-key" placeholder="sk-...">
          </div>
          <div class="form-row">
            <label for="new-provider-models">模型 ID (逗号分隔)</label>
            <div class="input-group">
              <input type="text" id="new-provider-models" placeholder="model-1, model-2">
              <button class="btn btn-secondary btn-sm" id="btn-discover-models" title="从 Provider 端点自动获取可用模型">获取模型</button>
            </div>
          </div>
          <button class="btn btn-primary btn-sm" id="btn-confirm-add-provider">添加</button>
        </div>
      </div>
    `
    listEl.insertAdjacentHTML('beforeend', formHtml)

    document.getElementById('btn-cancel-add-provider').addEventListener('click', () => {
      document.getElementById('add-provider-form').remove()
    })

    document.getElementById('btn-confirm-add-provider').addEventListener('click', () => {
      this.confirmAddProvider()
    })

    document.getElementById('btn-discover-models').addEventListener('click', () => {
      this.discoverModels()
    })
  },

  /**
   * Discover available models from a provider endpoint using DSH RPC.
   */
  async discoverModels() {
    const ns = document.getElementById('new-provider-id').value.trim().toLowerCase()
    const baseURL = document.getElementById('new-provider-url').value.trim()
    const apiKey = document.getElementById('new-provider-key').value.trim()
    const modelsInput = document.getElementById('new-provider-models')

    if (!ns || !baseURL) {
      alert('请先填写 Provider ID 和 Base URL')
      return
    }

    const btn = document.getElementById('btn-discover-models')
    btn.disabled = true
    btn.textContent = '获取中...'

    try {
      // Try the DSH RPC API for model discovery
      const result = await window.dsh.api.llm.discoverModels(ns, baseURL, apiKey)
      const models = result.models || result
      if (Array.isArray(models) && models.length > 0) {
        const modelIds = models.map((m) => m.id || m.name || m).join(', ')
        modelsInput.value = modelIds
        DshUtils.notify(`发现 ${models.length} 个模型`)
      } else {
        DshUtils.notify('未发现可用模型，请手动输入')
      }
    } catch (err) {
      DshUtils.notify('获取模型失败: ' + err.message)
    }

    btn.disabled = false
    btn.textContent = '获取模型'
  },

  /**
   * Confirm adding a custom provider.
   */
  confirmAddProvider() {
    const id = document.getElementById('new-provider-id').value.trim().toLowerCase()
    const name = document.getElementById('new-provider-name').value.trim()
    const url = document.getElementById('new-provider-url').value.trim()
    const api = document.getElementById('new-provider-api').value
    const key = document.getElementById('new-provider-key').value.trim()
    const modelsStr = document.getElementById('new-provider-models').value.trim()

    if (!id || !url) {
      alert('请填写 Provider ID 和 Base URL')
      return
    }

    // Read current settings
    const settings = window.dsh.config.getSettings()
    if (!settings['llm-pi-ai']) settings['llm-pi-ai'] = {}
    if (!settings['llm-pi-ai'].providers) settings['llm-pi-ai'].providers = {}

    const keyEnv = `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`

    settings['llm-pi-ai'].providers[id] = {
      apiKeyEnv: keyEnv,
      api,
      baseURL: url,
      ...(modelsStr ? {
        models: modelsStr.split(',').map((m) => ({ id: m.trim() })),
      } : {}),
    }

    // Save settings
    window.dsh.config.saveSettings(settings)

    // Save API key to credentials
    const creds = window.dsh.config.getCredentials()
    if (!creds[id]) creds[id] = {}
    creds[id].apiKey = key
    window.dsh.config.saveCredentials(creds)

    // Also store encrypted in uTools
    if (typeof utools !== 'undefined' && utools.dbCryptoStorage) {
      utools.dbCryptoStorage.setItem(`dsh-provider-key-${id}`, key)
    }

    // Reload UI
    document.getElementById('add-provider-form').remove()
    this.loadModelsTab()
    DshUtils.notify(`Provider "${id}" 已添加`)
  },

  /**
   * Remove a custom provider.
   * @param {string} name
   */
  removeProvider(name) {
    if (!confirm(`确定要移除 Provider "${name}" 吗？`)) return

    const settings = window.dsh.config.getSettings()
    if (settings['llm-pi-ai']?.providers?.[name]) {
      delete settings['llm-pi-ai'].providers[name]
      window.dsh.config.saveSettings(settings)
    }

    const creds = window.dsh.config.getCredentials()
    if (creds[name]) {
      delete creds[name]
      window.dsh.config.saveCredentials(creds)
    }

    this.loadModelsTab()
    DshUtils.notify(`Provider "${name}" 已移除`)
  },

  // ============================================================
  //  Workspace Tab
  // ============================================================

  /**
   * Load the workspace management tab.
   */
  async loadWorkspaceTab() {
    const listEl = document.getElementById('workspace-list')
    const workspaces = window.dsh.workspace.list()
    const current = window.dsh.workspace.getCurrent()

    if (workspaces.length === 0) {
      listEl.innerHTML = '<div class="workspace-empty">暂无工作区，点击下方按钮添加</div>'
      return
    }

    // Sort by last used
    workspaces.sort((a, b) => b.lastUsed - a.lastUsed)

    let html = ''
    for (const ws of workspaces) {
      const isCurrent = ws.path === current
      html += `
        <div class="workspace-item">
          <div>
            ${isCurrent ? '<span class="workspace-item-default">默认</span>' : ''}
            <span class="workspace-item-path">${DshUtils.escapeHtml(ws.path)}</span>
          </div>
          <div class="workspace-item-actions">
            ${!isCurrent ? `<button class="btn btn-sm btn-secondary" data-set-default="${DshUtils.escapeHtml(ws.path)}">设为默认</button>` : ''}
            <button class="btn btn-sm btn-danger" data-remove-ws="${DshUtils.escapeHtml(ws.path)}">移除</button>
          </div>
        </div>
      `
    }
    listEl.innerHTML = html

    // Attach handlers
    listEl.querySelectorAll('[data-set-default]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.dsh.workspace.setCurrent(btn.dataset.setDefault)
        this.loadWorkspaceTab()
      })
    })

    listEl.querySelectorAll('[data-remove-ws]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.dsh.workspace.remove(btn.dataset.removeWs)
        this.loadWorkspaceTab()
      })
    })
  },

  /**
   * Add a workspace.
   */
  async addWorkspace() {
    const folder = DshUtils.selectFolder()
    if (folder) {
      window.dsh.workspace.add(folder)
      this.loadWorkspaceTab()
      DshUtils.notify('工作区已添加')
    }
  },

  // ============================================================
  //  Server Tab
  // ============================================================

  /**
   * Load server configuration tab.
   */
  loadServerTab() {
    document.getElementById('setting-port').value = App.getSetting('port', 3080)
    document.getElementById('setting-auto-start').checked = App.getSetting('autoStart', true)
    document.getElementById('setting-background').checked = App.getSetting('backgroundRun', false)
    document.getElementById('setting-auto-restart').checked = App.getSetting('autoRestart', true)
  },

  /**
   * Save server settings.
   */
  saveServerSettings() {
    App.setSetting('port', parseInt(document.getElementById('setting-port').value))
    App.setSetting('autoStart', document.getElementById('setting-auto-start').checked)
    App.setSetting('backgroundRun', document.getElementById('setting-background').checked)
    App.setSetting('autoRestart', document.getElementById('setting-auto-restart').checked)
    DshUtils.notify('服务器设置已保存')
  },

  // ============================================================
  //  Environment Tab
  // ============================================================

  /**
   * Load environment check tab.
   */
  async loadEnvTab() {
    const results = window.dsh.env.checkPrerequisites()
    ServerManager.showEnvResults(results)
  },

  /**
   * Re-check environment.
   */
  async recheckEnv() {
    const listEl = document.getElementById('env-check-list-settings')
    if (listEl) {
      listEl.innerHTML = '<div class="loading-container"><div class="loading-spinner"></div><div class="loading-text">检测中...</div></div>'
    }
    await new Promise((r) => setTimeout(r, 100))
    await this.loadEnvTab()
  },

  /**
   * Install/update DSH.
   */
  async installDsh() {
    const btn = document.getElementById('btn-install-dsh')
    btn.disabled = true
    btn.textContent = '安装中...'

    const listEl = document.getElementById('env-check-list-settings')
    if (listEl) {
      listEl.innerHTML = '<div class="loading-container"><div class="loading-spinner"></div><div class="loading-text">正在安装/更新 DSH...\n首次安装可能需要几分钟</div></div>'
    }

    const ok = await window.dsh.cli.install({
      onOutput: (text) => {
        const existing = listEl.querySelector('.loading-text')
        if (existing) {
          existing.textContent = '正在安装/更新 DSH...\n' + text.slice(-500)
        }
      },
    })

    btn.disabled = false
    btn.textContent = '安装/更新 DSH'

    if (ok) {
      DshUtils.notify('DSH 安装/更新完成')
    } else {
      DshUtils.notify('DSH 安装失败')
    }

    await this.loadEnvTab()
  },

  // ============================================================
  //  Advanced Tab
  // ============================================================

  /**
   * Load advanced configuration tab.
   */
  async loadAdvancedTab() {
    // Load profiles
    const profiles = window.dsh.config.getProfiles()
    const profileListEl = document.getElementById('profile-list')
    if (profileListEl) {
      if (profiles.length === 0) {
        profileListEl.innerHTML = '<div class="profile-empty">无可用 Profile</div>'
      } else {
        profileListEl.innerHTML = profiles.map((p) => `
          <div class="profile-item">
            <span>${DshUtils.escapeHtml(p)}</span>
            <button class="btn btn-sm btn-secondary" data-dump-profile="${DshUtils.escapeHtml(p)}">查看配置</button>
          </div>
        `).join('')

        profileListEl.querySelectorAll('[data-dump-profile]').forEach((btn) => {
          btn.addEventListener('click', () => {
            document.getElementById('dump-profile').value = btn.dataset.dumpProfile
            this.dumpConfig()
          })
        })
      }
    }

    // Populate dump-profile select
    const dumpSelect = document.getElementById('dump-profile')
    if (dumpSelect) {
      dumpSelect.innerHTML = profiles.map((p) => `<option value="${p}">${p}</option>`).join('')
    }

    // Telemetry setting
    const telemetryOff = App.getSetting('telemetryDisabled', false)
    document.getElementById('setting-telemetry-off').checked = telemetryOff
  },

  /**
   * Dump the Cordis config tree.
   */
  async dumpConfig() {
    const profile = document.getElementById('dump-profile').value
    const defaultOnly = document.getElementById('dump-default-only').checked
    const outputEl = document.getElementById('config-output')

    outputEl.style.display = 'block'
    outputEl.textContent = '正在加载配置树...'

    try {
      const config = await window.dsh.config.dumpConfig(profile, defaultOnly)
      outputEl.textContent = config
    } catch (err) {
      outputEl.textContent = `错误: ${err.message}`
    }
  },

  /**
   * Initialize event listeners for settings actions.
   */
  initActions() {
    // Models tab
    document.getElementById('btn-save-deepseek')?.addEventListener('click', () => this.saveDeepSeekKey())
    document.getElementById('btn-add-provider')?.addEventListener('click', () => this.addProvider())

    // Workspace tab
    document.getElementById('btn-add-workspace')?.addEventListener('click', () => this.addWorkspace())

    // Server tab
    document.getElementById('btn-save-server-settings')?.addEventListener('click', () => this.saveServerSettings())

    // Env tab
    document.getElementById('btn-recheck-env')?.addEventListener('click', () => this.recheckEnv())
    document.getElementById('btn-install-dsh')?.addEventListener('click', () => this.installDsh())

    // Advanced tab
    document.getElementById('btn-dump-config')?.addEventListener('click', () => this.dumpConfig())

    // DSH workspace tab
    document.getElementById('btn-refresh-dsh-workspaces')?.addEventListener('click', () => this.loadDshWorkspaces())

    // Agent preset tab
    document.getElementById('btn-copy-preset')?.addEventListener('click', () => this.copyPreset())

    // Skills tab
    document.getElementById('btn-refresh-skills')?.addEventListener('click', () => this.loadSkillsTab())

    // Telemetry toggle
    document.getElementById('setting-telemetry-off')?.addEventListener('change', (e) => {
      App.setSetting('telemetryDisabled', e.target.checked)
      if (e.target.checked) {
        process.env.DSH_TELEMETRY_DISABLED = '1'
      } else {
        delete process.env.DSH_TELEMETRY_DISABLED
      }
    })
  },

  // ============================================================
  //  DSH Workspace management (via RPC API)
  // ============================================================

  /**
   * Load DSH server workspaces.
   */
  async loadDshWorkspaces() {
    const listEl = document.getElementById('dsh-workspace-list')
    if (!listEl) return

    listEl.innerHTML = '<div class="workspace-empty">正在加载...</div>'

    try {
      const result = await window.dsh.api.workspace.list()
      const workspaces = result.workspaces || result
      if (!Array.isArray(workspaces) || workspaces.length === 0) {
        listEl.innerHTML = '<div class="workspace-empty">暂无 DSH 服务器工作区</div>'
        return
      }

      let html = ''
      for (const ws of workspaces) {
        html += `
          <div class="workspace-item">
            <div>
              <span class="workspace-item-path">${DshUtils.escapeHtml(ws.path || ws.title || ws.workspaceId)}</span>
              <span style="font-size:11px;color:var(--color-text-secondary)"> ${ws.sessionIds?.length || 0} 个会话</span>
            </div>
            <div class="workspace-item-actions">
              <button class="btn btn-sm btn-secondary" data-ws-rename="${DshUtils.escapeHtml(ws.workspaceId)}">重命名</button>
              <button class="btn btn-sm btn-danger" data-ws-delete="${DshUtils.escapeHtml(ws.workspaceId)}">删除</button>
            </div>
          </div>
        `
      }
      listEl.innerHTML = html

      listEl.querySelectorAll('[data-ws-rename]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.wsRename
          const title = prompt('输入新名称:')
          if (title) {
            await window.dsh.api.workspace.rename(id, title)
            this.loadDshWorkspaces()
          }
        })
      })

      listEl.querySelectorAll('[data-ws-delete]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.wsDelete
          if (confirm('确定要删除此工作区吗？')) {
            await window.dsh.api.workspace.delete(id)
            this.loadDshWorkspaces()
          }
        })
      })
    } catch {
      listEl.innerHTML = '<div class="workspace-empty">无法加载（服务器未运行或 API 不可用）</div>'
    }
  },

  // ============================================================
  //  Agent Preset management (via RPC API)
  // ============================================================

  /**
   * Load the Agent Preset tab.
   */
  async loadPresetsTab() {
    const listEl = document.getElementById('agent-preset-list')
    if (!listEl) return

    listEl.innerHTML = '<div class="profile-empty">正在加载...</div>'

    try {
      const result = await window.dsh.api.agentPreset.list()
      const presets = result.presets || result
      if (!Array.isArray(presets) || presets.length === 0) {
        listEl.innerHTML = '<div class="profile-empty">暂无 Agent 预设</div>'
        return
      }

      let html = ''
      for (const preset of presets) {
        const id = preset.id || preset
        const name = preset.name || id
        const readOnly = preset.readOnly || preset.writable === false
        html += `
          <div class="profile-item">
            <div>
              <span style="font-weight:500">${DshUtils.escapeHtml(name)}</span>
              ${readOnly ? '<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:var(--color-bg-hover);color:var(--color-text-secondary);margin-left:8px">只读</span>' : ''}
            </div>
            <div style="display:flex;gap:4px">
              <button class="btn btn-sm btn-secondary" data-preset-read="${DshUtils.escapeHtml(id)}">查看</button>
              ${!readOnly ? `<button class="btn btn-sm btn-danger" data-preset-remove="${DshUtils.escapeHtml(id)}">删除</button>` : ''}
            </div>
          </div>
        `
      }
      listEl.innerHTML = html

      listEl.querySelectorAll('[data-preset-read]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.presetRead
          try {
            const config = await window.dsh.api.agentPreset.read(id)
            const text = typeof config === 'string' ? config : JSON.stringify(config, null, 2)
            alert(text.slice(0, 2000))
          } catch (err) {
            DshUtils.notify('查看失败: ' + err.message)
          }
        })
      })

      listEl.querySelectorAll('[data-preset-remove]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.presetRemove
          if (confirm(`确定要删除预设 "${id}" 吗？`)) {
            await window.dsh.api.agentPreset.remove(id)
            this.loadPresetsTab()
          }
        })
      })
    } catch {
      listEl.innerHTML = '<div class="profile-empty">无法加载（服务器未运行或 API 不可用）</div>'
    }
  },

  /**
   * Copy a preset.
   */
  async copyPreset() {
    const from = document.getElementById('preset-copy-from').value.trim()
    const to = document.getElementById('preset-copy-to').value.trim()
    if (!from || !to) {
      alert('请填写源预设 ID 和新预设 ID')
      return
    }
    try {
      await window.dsh.api.agentPreset.copy(from, to)
      DshUtils.notify('预设已复制')
      this.loadPresetsTab()
    } catch (err) {
      DshUtils.notify('复制失败: ' + err.message)
    }
  },

  // ============================================================
  //  Skills listing (via RPC API)
  // ============================================================

  /**
   * Load the Skills tab.
   */
  async loadSkillsTab() {
    const container = document.getElementById('skill-list-container')
    if (!container) return

    container.innerHTML = '<div class="workspace-empty">正在加载...</div>'

    try {
      const result = await window.dsh.api.skill.list()
      const skills = result.skills || result
      if (!Array.isArray(skills) || skills.length === 0) {
        container.innerHTML = '<div class="workspace-empty">暂无已安装技能</div>'
        return
      }

      let html = ''
      for (const skill of skills) {
        const id = skill.id || skill.name || skill
        const desc = skill.description || ''
        const invocable = skill.userInvocable !== false
        html += `
          <div class="plugin-item">
            <div class="plugin-item-info">
              <div class="plugin-item-name">${DshUtils.escapeHtml(id)}</div>
              <div class="plugin-item-desc">${DshUtils.escapeHtml(desc)}</div>
            </div>
            <span style="font-size:11px;color:${invocable ? 'var(--color-success)' : 'var(--color-text-secondary)'}">${invocable ? '可调用' : '系统'}</span>
          </div>
        `
      }
      container.innerHTML = html
    } catch {
      container.innerHTML = '<div class="workspace-empty">无法加载（服务器未运行或 API 不可用）</div>'
    }
  },
}
