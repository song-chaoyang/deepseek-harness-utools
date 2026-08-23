/**
 * headless-runner.js — DSH headless task runner UI.
 *
 * Allows users to input a task description, select workspace and model,
 * run the task via `dsh --profile headless`, and display streaming output.
 */

const HeadlessRunner = {
  /** Whether a task is currently running */
  running: false,

  /** Current task output */
  output: '',

  /** Predefined quick command templates */
  templates: [
    { id: 'review',   label: '🔍 代码审查', task: '请审查以下代码，关注安全性、性能和可读性：\n\n' },
    { id: 'test',     label: '🧪 生成测试', task: '请为以下文件生成单元测试：\n\n' },
    { id: 'refactor', label: '🔧 重构代码', task: '请重构以下代码，改善其结构而不改变行为：\n\n' },
    { id: 'explain',  label: '📖 解释代码', task: '请解释以下代码的功能和设计意图：\n\n' },
    { id: 'fix-lint', label: '🐛 修复 Lint', task: '请修复以下 lint 错误：\n\n' },
    { id: 'doc',      label: '📝 生成文档', task: '请为以下代码生成 API 文档：\n\n' },
  ],

  /**
   * Load available models from the DSH server and uTools AI.
   */
  async loadModels() {
    const select = document.getElementById('headless-model')
    if (!select) return

    let html = '<option value="">默认 (DSH 配置)</option>'

    // 1. DSH server models
    try {
      const models = await window.dsh.api.getModels()
      if (Array.isArray(models) && models.length > 0) {
        html += '<optgroup label="DSH 模型">'
        for (const model of models) {
          const id = model.id || model.name || model
          const label = model.label || model.name || id
          html += `<option value="dsh:${DshUtils.escapeHtml(id)}">${DshUtils.escapeHtml(label)}</option>`
        }
        html += '</optgroup>'
      }
    } catch { /* server not running */ }

    // 2. uTools AI models (no API key needed)
    if (window.dsh.utoolsAi && window.dsh.utoolsAi.isAvailable()) {
      try {
        const models = await window.dsh.utoolsAi.getModels()
        if (models.length > 0) {
          html += '<optgroup label="⚡ uTools AI (无需 API Key)">'
          for (const m of models) {
            html += `<option value="utools:${DshUtils.escapeHtml(m.id)}">${DshUtils.escapeHtml(m.label)} 💰${m.cost}</option>`
          }
          html += '</optgroup>'
        }
      } catch { /* ignore */ }
    }

    select.innerHTML = html
  },

  /**
   * Run a headless task.
   */
  async run() {
    if (this.running) return

    const task = document.getElementById('headless-task').value.trim()
    if (!task) return

    const workspace = document.getElementById('headless-workspace').value.trim() || window.dsh.workspace.getCurrent()
    const model = document.getElementById('headless-model').value

    if (!workspace) {
      alert('请选择工作区')
      return
    }

    // Validate workspace
    if (!window.dsh.workspace.validate(workspace)) {
      alert('工作区路径无效')
      return
    }

    // Route based on model prefix
    if (model.startsWith('utools:')) {
      return this.runWithUtoolsAi(model.replace('utools:', ''), task, workspace)
    }

    return this.runWithDsh(model.replace('dsh:', '') || undefined, task, workspace)
  },

  /**
   * Run task using DSH headless mode.
   * @param {string|undefined} model
   * @param {string} task
   * @param {string} workspace
   */
  async runWithDsh(model, task, workspace) {
    // Save workspace
    window.dsh.workspace.add(workspace)
    window.dsh.workspace.setCurrent(workspace)

    // Show output area
    const outputEl = document.getElementById('hr-output')
    const contentEl = document.getElementById('hr-output-content')
    const btnRun = document.getElementById('btn-run-headless')
    const btnClear = document.getElementById('btn-headless-clear')

    outputEl.style.display = 'block'
    btnClear.style.display = 'inline-flex'
    btnRun.disabled = true
    btnRun.textContent = '运行中...'

    contentEl.innerHTML = ''
    contentEl.classList.add('streaming')
    this.running = true
    this.output = ''

    contentEl.textContent = '正在启动 Headless 任务...\n\n'

    const result = await window.dsh.cli.runHeadless(task, {
      workspace,
      model: model || undefined,
      onOutput: (text) => {
        this.output += text
        contentEl.textContent = this.output
        contentEl.scrollTop = contentEl.scrollHeight
      },
      onError: (text) => {
        this.output += text
        contentEl.textContent = this.output
        contentEl.scrollTop = contentEl.scrollHeight
      },
    })

    this.running = false
    contentEl.classList.remove('streaming')
    btnRun.disabled = false
    btnRun.textContent = '运行任务'

    if (result.success) {
      if (result.output) {
        contentEl.textContent = result.output
        this.output = result.output
      }
      DshUtils.notify('DSH Headless 任务完成')
      if (result.output) {
        DshUtils.copyToClipboard(result.output)
      }
    } else {
      contentEl.textContent = `任务失败:\n\n${result.error || result.output || '未知错误'}`
      DshUtils.notify('DSH Headless 任务失败')
    }
  },

  /**
   * Run task using uTools AI (no API key needed).
   * @param {string} modelId - uTools AI model ID
   * @param {string} task
   * @param {string} workspace
   */
  async runWithUtoolsAi(modelId, task, workspace) {
    // Save workspace for consistency
    window.dsh.workspace.add(workspace)
    window.dsh.workspace.setCurrent(workspace)

    const outputEl = document.getElementById('hr-output')
    const contentEl = document.getElementById('hr-output-content')
    const btnRun = document.getElementById('btn-run-headless')
    const btnClear = document.getElementById('btn-headless-clear')

    outputEl.style.display = 'block'
    btnClear.style.display = 'inline-flex'
    btnRun.disabled = true
    btnRun.textContent = '运行中...'
    contentEl.innerHTML = ''
    contentEl.classList.add('streaming')
    this.running = true
    this.output = ''

    const messages = [
      { role: 'system', content: `你是一个 AI 编程助手。当前工作区: ${workspace}` },
      { role: 'user', content: task },
    ]

    try {
      await window.dsh.utoolsAi.chat(messages, modelId, null, (chunk) => {
        this.output += chunk
        contentEl.textContent = this.output
        contentEl.scrollTop = contentEl.scrollHeight
      })

      this.running = false
      contentEl.classList.remove('streaming')
      btnRun.disabled = false
      btnRun.textContent = '运行任务'

      DshUtils.notify('uTools AI 任务完成')
      if (this.output) {
        DshUtils.copyToClipboard(this.output)
      }
    } catch (err) {
      this.running = false
      contentEl.classList.remove('streaming')
      btnRun.disabled = false
      btnRun.textContent = '运行任务'
      contentEl.textContent = `任务失败:\n\n${err.message || '未知错误'}`
      DshUtils.notify('uTools AI 任务失败')
    }
  },

  /**
   * Clear the output.
   */
  clear() {
    document.getElementById('hr-output').style.display = 'none'
    document.getElementById('hr-output-content').textContent = ''
    document.getElementById('btn-headless-clear').style.display = 'none'
    this.output = ''
  },

  /**
   * Copy the result to clipboard.
   */
  copyResult() {
    if (this.output) {
      DshUtils.copyToClipboard(this.output)
      DshUtils.notify('结果已复制到剪贴板')
    }
  },

  /**
   * Paste the result to the previously active window (uTools hideMainWindowPasteText).
   */
  pasteToPreviousWindow() {
    if (this.output) {
      if (typeof utools !== 'undefined' && utools.hideMainWindowPasteText) {
        utools.hideMainWindowPasteText(this.output)
      } else {
        DshUtils.copyToClipboard(this.output)
        DshUtils.notify('结果已复制到剪贴板（请手动粘贴）')
      }
    }
  },

  /**
   * Open the current task in the Web UI.
   */
  async openInWebUI() {
    const task = document.getElementById('headless-task').value.trim()
    if (!task) return

    // Ensure server is running
    const status = window.dsh.server.getStatus()
    if (!status.running) {
      const workspace = document.getElementById('headless-workspace').value.trim()
      const port = App.getSetting('port', 3080)
      const result = await window.dsh.server.start({ workspace, port, profile: 'web' })
      if (!result.success) {
        DshUtils.showError('无法启动服务器', result.error || '未知错误')
        return
      }
    }

    // Open Web UI
    WebUI.open()

    // Optionally create a session and send the message
    try {
      const session = await window.dsh.api.createSession({ workspace: document.getElementById('headless-workspace').value })
      if (session && session.id) {
        await window.dsh.api.sendMessage(session.id, task)
      }
    } catch {
      // API might not be available, user can manually send in Web UI
    }
  },

  /**
   * Render the quick command template bar.
   */
  renderTemplates() {
    const barEl = document.getElementById('template-bar')
    if (!barEl) return
    barEl.innerHTML = this.templates.map(t =>
      `<button class="template-btn" data-template="${t.id}">${t.label}</button>`
    ).join('')
    barEl.querySelectorAll('.template-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tpl = this.templates.find(t => t.id === btn.dataset.template)
        if (tpl) {
          const taskEl = document.getElementById('headless-task')
          if (taskEl) {
            taskEl.value = tpl.task
            taskEl.focus()
            // Place cursor at end
            taskEl.setSelectionRange(tpl.task.length, tpl.task.length)
          }
        }
      })
    })
  },

  /**
   * Initialize event listeners.
   */
  init() {
    // Render templates
    this.renderTemplates()

    const btnRun = document.getElementById('btn-run-headless')
    if (btnRun) {
      btnRun.addEventListener('click', () => this.run())
    }

    const btnClear = document.getElementById('btn-headless-clear')
    if (btnClear) {
      btnClear.addEventListener('click', () => this.clear())
    }

    const btnCopy = document.getElementById('btn-copy-result')
    if (btnCopy) {
      btnCopy.addEventListener('click', () => this.copyResult())
    }

    const btnOpenWebUI = document.getElementById('btn-open-in-webui')
    if (btnOpenWebUI) {
      btnOpenWebUI.addEventListener('click', () => this.openInWebUI())
    }

    const btnPaste = document.getElementById('btn-paste-result')
    if (btnPaste) {
      btnPaste.addEventListener('click', () => this.pasteToPreviousWindow())
    }

    const btnSelectWs = document.getElementById('btn-headless-select-workspace')
    if (btnSelectWs) {
      btnSelectWs.addEventListener('click', async () => {
        const folder = DshUtils.selectFolder()
        if (folder) {
          document.getElementById('headless-workspace').value = folder
        }
      })
    }
  },
}

document.addEventListener('DOMContentLoaded', () => {
  HeadlessRunner.init()
})
