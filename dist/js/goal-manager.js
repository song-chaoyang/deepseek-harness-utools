/**
 * goal-manager.js — DSH Goal management UI.
 *
 * Manages goals for sessions: create, edit, pause, resume, complete, clear.
 * Uses the DSH RPC API (goal.* methods).
 */

const GoalManager = {
  /** Current session ID for goal operations */
  currentSessionId: null,

  /** List of goals */
  goals: [],

  /**
   * Load the goal manager view.
   */
  async load() {
    const listEl = document.getElementById('session-list')
    if (!listEl) return

    // Check if server is running
    const status = window.dsh.server.getStatus()
    if (!status.running) {
      listEl.innerHTML = `
        <div class="workspace-empty">
          DSH 服务器未运行。请先启动服务器。
        </div>
      `
      return
    }

    listEl.innerHTML = `
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载会话列表...</div>
      </div>
    `

    try {
      // Get all sessions to let user pick which session's goals to manage
      const sessions = await window.dsh.api.session.list()
      this.renderSessionPicker(sessions)
    } catch (err) {
      listEl.innerHTML = `<div class="workspace-empty">加载失败: ${DshUtils.escapeHtml(err.message)}</div>`
    }
  },

  /**
   * Render session picker for goal management.
   * @param {Array} sessions
   */
  renderSessionPicker(sessions) {
    const listEl = document.getElementById('session-list')
    if (!sessions || sessions.length === 0) {
      listEl.innerHTML = '<div class="workspace-empty">暂无会话。请先在 Web UI 中创建会话。</div>'
      return
    }

    let html = '<div style="padding:12px 16px;font-size:13px;font-weight:600">选择会话以管理其目标</div>'
    for (const session of sessions) {
      const id = session.sessionId || session.id
      const title = session.title || id
      html += `
        <div class="session-item" data-session-id="${DshUtils.escapeHtml(id)}">
          <div class="session-item-title">${DshUtils.escapeHtml(title)}</div>
          <div class="session-item-meta">
            <span>📅 ${DshUtils.formatDate(new Date(session.updatedAt || Date.now()).toISOString())}</span>
          </div>
        </div>
      `
    }
    listEl.innerHTML = html

    listEl.querySelectorAll('.session-item').forEach((item) => {
      item.addEventListener('click', () => {
        const sessionId = item.dataset.sessionId
        if (sessionId) this.showGoalsForSession(sessionId)
      })
    })
  },

  /**
   * Show goals for a specific session.
   * @param {string} sessionId
   */
  async showGoalsForSession(sessionId) {
    this.currentSessionId = sessionId
    const detailEl = document.getElementById('session-detail')
    const contentEl = document.getElementById('session-detail-content')
    const titleEl = document.getElementById('session-detail-title')

    document.getElementById('session-list').style.display = 'none'
    detailEl.style.display = 'flex'
    titleEl.textContent = `目标管理 — ${sessionId}`

    contentEl.innerHTML = `
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载目标...</div>
      </div>
    `

    await this.refreshGoals()
  },

  /**
   * Refresh the goals list.
   */
  async refreshGoals() {
    if (!this.currentSessionId) return

    const contentEl = document.getElementById('session-detail-content')
    if (!contentEl) return

    try {
      // Goals are part of session projections; try to get them from history
      const history = await window.dsh.api.session.history(this.currentSessionId)
      const events = history.events || []
      // Extract goal events from session log
      this.goals = events
        .filter((item) => {
          const type = item.event?.type || item.type
          return type && type.startsWith('goal/')
        })
        .map((item) => ({
          id: item.event?.data?.id || item.data?.id,
          objective: item.event?.data?.objective || item.data?.objective,
          status: (item.event?.type || item.type)?.replace('goal/', ''),
        }))

      this.renderGoals()
    } catch (err) {
      contentEl.innerHTML = `<div class="workspace-empty">加载目标失败: ${DshUtils.escapeHtml(err.message)}</div>`
    }
  },

  /**
   * Render goals list and creation form.
   */
  renderGoals() {
    const contentEl = document.getElementById('session-detail-content')
    if (!contentEl) return

    let html = `
      <div class="goal-create-form" style="margin-bottom:20px">
        <div class="form-row">
          <label>创建新目标</label>
          <div class="input-group">
            <input type="text" id="goal-objective" placeholder="输入目标描述...">
            <button class="btn btn-primary btn-sm" id="btn-create-goal">创建</button>
          </div>
        </div>
      </div>
    `

    if (this.goals.length === 0) {
      html += '<div class="workspace-empty">暂无目标</div>'
    } else {
      html += '<div class="goal-list">'
      for (const goal of this.goals) {
        const status = goal.status || 'created'
        const statusColor = status === 'completed' ? 'var(--color-success)' :
                            status === 'paused' ? 'var(--color-warning)' :
                            'var(--color-info)'
        html += `
          <div class="goal-item" style="padding:12px;background:var(--color-bg-secondary);border:1px solid var(--color-border);border-radius:var(--radius-sm);margin-bottom:8px">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:13px">${DshUtils.escapeHtml(goal.objective || '未命名目标')}</span>
              <span style="font-size:11px;padding:2px 8px;border-radius:12px;background:${statusColor};color:white">${DshUtils.escapeHtml(status)}</span>
            </div>
            <div style="display:flex;gap:4px;margin-top:8px">
              ${status !== 'completed' ? `<button class="btn btn-sm btn-secondary" data-goal-pause="${DshUtils.escapeHtml(goal.id)}">${status === 'paused' ? '恢复' : '暂停'}</button>` : ''}
              ${status !== 'completed' ? `<button class="btn btn-sm btn-secondary" data-goal-edit="${DshUtils.escapeHtml(goal.id)}">编辑</button>` : ''}
              <button class="btn btn-sm btn-secondary" data-goal-complete="${DshUtils.escapeHtml(goal.id)}">完成</button>
            </div>
          </div>
        `
      }
      html += '</div>'
    }

    html += `
      <div style="margin-top:16px">
        <button class="btn btn-danger btn-sm" id="btn-clear-goals">清除所有目标</button>
      </div>
    `

    contentEl.innerHTML = html

    // Attach event listeners
    const btnCreate = document.getElementById('btn-create-goal')
    if (btnCreate) btnCreate.addEventListener('click', () => this.createGoal())

    const btnClear = document.getElementById('btn-clear-goals')
    if (btnClear) btnClear.addEventListener('click', () => this.clearGoals())

    contentEl.querySelectorAll('[data-goal-pause]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const goalId = btn.dataset.goalPause
        const goal = this.goals.find((g) => g.id === goalId)
        if (goal && goal.status === 'paused') {
          this.resumeGoal(goalId)
        } else {
          this.pauseGoal(goalId)
        }
      })
    })

    contentEl.querySelectorAll('[data-goal-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const goalId = btn.dataset.goalEdit
        const newObjective = prompt('输入新的目标描述:')
        if (newObjective) this.editGoal(goalId, newObjective)
      })
    })

    contentEl.querySelectorAll('[data-goal-complete]').forEach((btn) => {
      btn.addEventListener('click', () => this.completeGoal(btn.dataset.goalComplete))
    })
  },

  /**
   * Create a goal.
   */
  async createGoal() {
    if (!this.currentSessionId) return
    const objective = document.getElementById('goal-objective').value.trim()
    if (!objective) return

    try {
      await window.dsh.api.goal.create(this.currentSessionId, objective)
      DshUtils.notify('目标已创建')
      document.getElementById('goal-objective').value = ''
      await this.refreshGoals()
    } catch (err) {
      DshUtils.notify('创建失败: ' + err.message)
    }
  },

  /**
   * Edit a goal.
   */
  async editGoal(goalId, objective) {
    if (!this.currentSessionId) return
    try {
      await window.dsh.api.goal.edit(this.currentSessionId, goalId, objective)
      DshUtils.notify('目标已更新')
      await this.refreshGoals()
    } catch (err) {
      DshUtils.notify('更新失败: ' + err.message)
    }
  },

  /**
   * Pause a goal.
   */
  async pauseGoal(goalId) {
    if (!this.currentSessionId) return
    try {
      await window.dsh.api.goal.pause(this.currentSessionId, goalId)
      DshUtils.notify('目标已暂停')
      await this.refreshGoals()
    } catch (err) {
      DshUtils.notify('暂停失败: ' + err.message)
    }
  },

  /**
   * Resume a goal.
   */
  async resumeGoal(goalId) {
    if (!this.currentSessionId) return
    try {
      await window.dsh.api.goal.resume(this.currentSessionId, goalId)
      DshUtils.notify('目标已恢复')
      await this.refreshGoals()
    } catch (err) {
      DshUtils.notify('恢复失败: ' + err.message)
    }
  },

  /**
   * Complete a goal.
   */
  async completeGoal(goalId) {
    if (!this.currentSessionId) return
    try {
      await window.dsh.api.goal.complete(this.currentSessionId, goalId)
      DshUtils.notify('目标已完成')
      await this.refreshGoals()
    } catch (err) {
      DshUtils.notify('完成失败: ' + err.message)
    }
  },

  /**
   * Clear all goals.
   */
  async clearGoals() {
    if (!this.currentSessionId) return
    if (!confirm('确定要清除所有目标吗？')) return
    try {
      await window.dsh.api.goal.clear(this.currentSessionId)
      DshUtils.notify('已清除所有目标')
      await this.refreshGoals()
    } catch (err) {
      DshUtils.notify('清除失败: ' + err.message)
    }
  },
}
