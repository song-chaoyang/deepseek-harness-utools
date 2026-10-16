/**
 * session-watcher.js — Web UI 会话完成通知。
 *
 * 插件窗口打开期间每 10s 轮询一次 DSH 服务器会话列表。某会话从
 * running → 非 running（Agent 任务完成）时发送系统通知，点击通知
 * 跳回插件的会话历史视图。
 *
 * 设计约束：
 * - 只依赖 window.dsh.api.listSessions()（RPC 失败时静默跳过本轮）
 * - 首次轮询仅建立基线（_lastRunning 为空 → 天然不会误报历史会话）
 * - 同一会话 5 分钟内不重复通知
 * - 服务器未运行时清空基线，避免重启后误报
 */

const SessionWatcher = {
  _timer: null,
  _lastRunning: new Map(),   // sessionId -> 会话标题（上一次轮询时处于 running）
  _lastNotified: new Map(),  // sessionId -> 上次通知时间戳
  _intervalMs: 10000,
  _dedupeWindowMs: 5 * 60 * 1000,

  start() {
    if (this._timer) return
    this._timer = setInterval(() => {
      this.poll().catch((err) => {
        console.warn('[dsh] session watcher poll failed:', err.message)
      })
    }, this._intervalMs)
  },

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  },

  async poll() {
    const status = window.dsh.server.getStatus()
    if (!status.running) {
      this._lastRunning.clear()
      return
    }

    let sessions
    try {
      sessions = await window.dsh.api.listSessions()
    } catch {
      return // 服务器暂不可达，下一轮再试
    }
    if (!Array.isArray(sessions)) return

    const now = Date.now()
    for (const s of sessions) {
      const id = s.sessionId || s.id
      if (!id) continue

      if (s.running === true) {
        this._lastRunning.set(id, s.title || '')
        continue
      }

      const wasTitle = this._lastRunning.get(id)
      if (wasTitle === undefined) continue

      // running → 非 running：Agent 任务完成
      this._lastRunning.delete(id)

      const last = this._lastNotified.get(id) || 0
      if (now - last < this._dedupeWindowMs) continue
      this._lastNotified.set(id, now)

      if (typeof utools !== 'undefined' && utools.showNotification) {
        try {
          utools.showNotification(
            `DSH 会话完成：${wasTitle || id}`,
            'dsh-sessions',
          )
        } catch (err) {
          console.warn('[dsh] showNotification failed:', err.message)
        }
      }
    }
  },
}
