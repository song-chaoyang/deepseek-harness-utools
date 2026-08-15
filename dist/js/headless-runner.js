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

  /**
   * Load available models from the DSH server.
   */
  async loadModels() {
    const select = document.getElementById('headless-model')
    if (!select) return

    // Try to get models from the API
    try {
      const models = await window.dsh.api.getModels()
      select.innerHTML = '<option value="">默认</option>'
      if (Array.isArray(models)) {
        for (const model of models) {
          const id = model.id || model.name || model
          const label = model.label || model.name || id
          const option = document.createElement('option')
          option.value = id
          option.textContent = label
          select.appendChild(option)
        }
      }
    } catch {
      // Server not running or API unavailable
      select.innerHTML = '<option value="">默认 (服务器未运行)</option>'
    }
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

    // Show initial message
    contentEl.textContent = '正在启动 Headless 任务...\n\n'

    // Run the headless task
    const result = await window.dsh.cli.runHeadless(task, {
      workspace,
      model: model || undefined,
      onOutput: (text) => {
        this.output += text
        contentEl.textContent = this.output
        contentEl.scrollTop = contentEl.scrollHeight
      },
      onError: (text) => {
        // stderr often contains progress info for dsh
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
      // Show final output
      if (result.output) {
        contentEl.textContent = result.output
        this.output = result.output
      }

      // Notify
      DshUtils.notify('DSH Headless 任务完成')

      // Auto-copy result
      if (result.output) {
        DshUtils.copyToClipboard(result.output)
      }
    } else {
      // Show error
      contentEl.textContent = `任务失败:\n\n${result.error || result.output || '未知错误'}`
      DshUtils.notify('DSH Headless 任务失败')
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
   * Initialize event listeners.
   */
  init() {
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
