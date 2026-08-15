/**
 * session-browser.js — DSH session history browser.
 *
 * Lists sessions from the DSH server API or filesystem,
 * allows searching, viewing details, forking, canceling,
 * sending screenshots, and resuming in Web UI.
 */

const SessionBrowser = {
  /** All loaded sessions */
  sessions: [],

  /** Filtered sessions for display */
  filtered: [],

  /** Current session being viewed */
  currentSessionId: null,

  /**
   * Load sessions from the DSH server.
   */
  async load() {
    const listEl = document.getElementById('session-list')
    if (!listEl) return

    listEl.innerHTML = `
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载会话列表...</div>
      </div>
    `

    try {
      this.sessions = await window.dsh.api.listSessions()
      this.filtered = [...this.sessions]
      this.render()
    } catch (err) {
      listEl.innerHTML = `
        <div class="workspace-empty">
          无法加载会话列表: ${DshUtils.escapeHtml(err.message)}
          <br><br>
          请确保 DSH 服务器正在运行。
        </div>
      `
    }

    // Initialize search
    const searchEl = document.getElementById('session-search')
    if (searchEl) {
      searchEl.addEventListener('input', DshUtils.debounce((e) => {
        this.search(e.target.value)
      }, 200))
    }

    // Back button
    const btnBack = document.getElementById('btn-back-to-list')
    if (btnBack) {
      btnBack.addEventListener('click', () => {
        document.getElementById('session-detail').style.display = 'none'
        document.getElementById('session-list').style.display = 'block'
      })
    }

    // Resume button
    const btnResume = document.getElementById('btn-resume-session')
    if (btnResume) {
      btnResume.addEventListener('click', () => this.resumeCurrent())
    }

    // Export button
    const btnExport = document.getElementById('btn-export-session')
    if (btnExport) {
      btnExport.addEventListener('click', () => this.exportCurrent())
    }

    // Fork button
    const btnFork = document.getElementById('btn-fork-session')
    if (btnFork) {
      btnFork.addEventListener('click', () => this.forkCurrent())
    }

    // Cancel button
    const btnCancel = document.getElementById('btn-cancel-session')
    if (btnCancel) {
      btnCancel.addEventListener('click', () => this.cancelCurrent())
    }

    // Screenshot button
    const btnScreenshot = document.getElementById('btn-screenshot-session')
    if (btnScreenshot) {
      btnScreenshot.addEventListener('click', () => this.sendScreenshot())
    }
  },

  /**
   * Render the session list.
   */
  render() {
    const listEl = document.getElementById('session-list')

    if (this.filtered.length === 0) {
      listEl.innerHTML = '<div class="workspace-empty">暂无会话记录</div>'
      return
    }

    let html = ''
    for (const session of this.filtered) {
      const title = session.title || session.id || session.path || '未命名会话'
      const modified = session.updatedAt ? new Date(session.updatedAt).toISOString() : (session.modified || '')
      const workspace = session.cwd || ''
      const messageCount = session.messageCount || 0
      const isRunning = session.running === true
      const isBlank = session.blank === true

      html += `
        <div class="session-item" data-session-id="${DshUtils.escapeHtml(session.sessionId || session.id || '')}">
          <div class="session-item-title">
            ${isRunning ? '<span style="color:var(--color-success)">●</span> ' : ''}
            ${isBlank ? '<span style="color:var(--color-text-secondary)">○</span> ' : ''}
            ${DshUtils.escapeHtml(title)}
          </div>
          <div class="session-item-meta">
            ${modified ? `<span>📅 ${DshUtils.formatDate(modified)}</span>` : ''}
            ${workspace ? `<span>📁 ${DshUtils.escapeHtml(workspace)}</span>` : ''}
            ${session.agentPreset ? `<span>⚙️ ${DshUtils.escapeHtml(session.agentPreset)}</span>` : ''}
          </div>
        </div>
      `
    }
    listEl.innerHTML = html

    listEl.querySelectorAll('.session-item').forEach((item) => {
      item.addEventListener('click', () => {
        const sessionId = item.dataset.sessionId
        if (sessionId) this.showDetail(sessionId)
      })
    })
  },

  /**
   * Search sessions. Uses DSH session.search API if available,
   * otherwise filters locally.
   * @param {string} query
   */
  async search(query) {
    if (!query) {
      this.filtered = [...this.sessions]
    } else {
      // Try DSH session.search API first
      try {
        const results = await window.dsh.api.session.search(query)
        if (results && Array.isArray(results.items)) {
          this.filtered = results.items
        } else if (Array.isArray(results)) {
          this.filtered = results
        } else {
          // Fallback to local filter
          this.filtered = this.sessions.filter((s) => {
            const title = (s.title || s.sessionId || s.id || '').toLowerCase()
            const cwd = (s.cwd || '').toLowerCase()
            return title.includes(query.toLowerCase()) || cwd.includes(query.toLowerCase())
          })
        }
      } catch {
        // Fallback to local filter
        this.filtered = this.sessions.filter((s) => {
          const title = (s.title || s.sessionId || s.id || '').toLowerCase()
          const cwd = (s.cwd || '').toLowerCase()
          return title.includes(query.toLowerCase()) || cwd.includes(query.toLowerCase())
        })
      }
    }
    this.render()
  },

  /**
   * Show session detail.
   * @param {string} sessionId
   */
  async showDetail(sessionId) {
    this.currentSessionId = sessionId

    const listEl = document.getElementById('session-list')
    const detailEl = document.getElementById('session-detail')
    const contentEl = document.getElementById('session-detail-content')
    const titleEl = document.getElementById('session-detail-title')

    listEl.style.display = 'none'
    detailEl.style.display = 'flex'

    contentEl.innerHTML = `
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载会话详情...</div>
      </div>
    `

    try {
      const result = await window.dsh.api.session.history(sessionId)
      const title = result.session?.title || sessionId
      titleEl.textContent = title

      const events = result.events || result.messages || []
      if (events.length === 0) {
        contentEl.innerHTML = '<div class="workspace-empty">该会话没有消息记录</div>'
        return
      }

      let html = ''
      for (const item of events) {
        const event = item.event || item
        const role = event.type?.startsWith('user/') ? 'user' :
                     event.type?.startsWith('assistant/') ? 'assistant' : 'system'
        const content = event.data?.content || event.data?.message?.content ||
                        event.content || event.text || JSON.stringify(event.data || event, null, 2)
        const roleClass = role === 'user' ? 'user' : (role === 'assistant' ? 'assistant' : '')
        const roleLabel = role === 'user' ? '用户' : (role === 'assistant' ? 'AI' : '系统')

        html += `
          <div class="session-message ${roleClass}">
            <div class="msg-role">${DshUtils.escapeHtml(roleLabel)}</div>
            <div class="msg-content">${DshUtils.escapeHtml(typeof content === 'string' ? content : JSON.stringify(content, null, 2))}</div>
          </div>
        `
      }
      contentEl.innerHTML = html
    } catch (err) {
      contentEl.innerHTML = `<div class="workspace-empty">加载失败: ${DshUtils.escapeHtml(err.message)}</div>`
    }
  },

  /**
   * Resume the current session in Web UI.
   */
  async resumeCurrent() {
    if (!this.currentSessionId) return

    const status = window.dsh.server.getStatus()
    if (!status.running) {
      const port = App.getSetting('port', 3080)
      const workspace = window.dsh.workspace.getCurrent()
      const result = await window.dsh.server.start({ workspace, port, profile: 'web' })
      if (!result.success) {
        DshUtils.showError('无法启动服务器', result.error || '未知错误')
        return
      }
    }

    WebUI.open()
  },

  /**
   * Fork the current session.
   */
  async forkCurrent() {
    if (!this.currentSessionId) return
    try {
      const result = await window.dsh.api.session.fork(this.currentSessionId)
      DshUtils.notify(`会话已 Fork: ${result.sessionId || '新会话'}`)
    } catch (err) {
      DshUtils.notify('Fork 失败: ' + err.message)
    }
  },

  /**
   * Cancel the current session's running agent.
   */
  async cancelCurrent() {
    if (!this.currentSessionId) return
    if (!confirm('确定要取消当前正在运行的 Agent 吗？')) return
    try {
      await window.dsh.api.session.cancel(this.currentSessionId)
      DshUtils.notify('已取消')
    } catch (err) {
      DshUtils.notify('取消失败: ' + err.message)
    }
  },

  /**
   * Take a screenshot and send it to the current session.
   */
  async sendScreenshot() {
    if (!this.currentSessionId) return

    const image = await App.screenCapture()
    if (!image) {
      DshUtils.notify('截图失败')
      return
    }

    try {
      await window.dsh.api.session.attachment(this.currentSessionId, {
        type: 'image',
        data: image,
      })
      DshUtils.notify('截图已发送到会话')
    } catch (err) {
      DshUtils.notify('发送截图失败: ' + err.message)
    }
  },

  /**
   * Export the current session.
   */
  async exportCurrent() {
    if (!this.currentSessionId) return

    try {
      const session = await window.dsh.api.session.history(this.currentSessionId)
      const json = JSON.stringify(session, null, 2)
      DshUtils.copyToClipboard(json)
      DshUtils.notify('会话数据已复制到剪贴板')
    } catch (err) {
      DshUtils.notify('导出失败: ' + err.message)
    }
  },
}
