# 更新日志

## v1.1.0 (2026-10-13)

### 新功能
- 🔒 **DSH 完全沙盒化运行**
  - DSH_HOME 独立重定向至插件私有目录（`utools.getPluginLocalDataPath()/dsh-sandbox/home`），不再读写系统 `~/.dsh`，彻底杜绝外部插件引起的环境污染与崩溃
  - 私有 npm/npx 缓存（`dsh-sandbox/npm-cache`），与系统共享缓存完全隔离
  - DSH 运行时沙盒化安装（`npm install --prefix`），废弃对用户系统全局 node_modules 的写入
  - 启动端口智能自愈：自动识别并清理插件自身残留的历史孤儿进程；端口被外部服务占用时自动探测可用空闲端口启动，彻底解决 `EADDRINUSE` 启动崩溃
- ✨ **深度整合 6 项 uTools 原生交互能力**
  - 🖱️ **选中文本即处理 (`over` 匹配指令)**：在任意应用内选中文字呼出 uTools 即可一键交由 DSH Headless 执行
  - 📁 **文件夹拖拽工作区 (`files` 匹配指令)**：将文件夹拖入 uTools 自动绑定为工作区、拉起沙盒服务并进入 Web UI
  - 📄 **多文件拖拽分析 (`files` 匹配指令)**：支持批量拖入文件生成分析任务，自动继承所在目录作为工作区
  - 🕘 **Headless 任务历史**：使用 `dbStorage` 持久化最近 20 次任务记录，支持一键表单回填、重跑与输出复制
  - 🔔 **任务完成系统通知**：Headless 任务完成后发送系统原生通知，点击通知可直接跳回插件继续操作
  - ⌨️ **全局快捷键直达**：在设置页面一键配置 `autocopy` 全局快捷键，任意软件中按键即刻提取选区送入 DSH
- 🧩 **全流程快捷入口**：Web UI 工具栏与服务器管理面板常驻插件中心入口，并为所有二级视图（插件管理/会话历史/任务/设置）全量补齐返回按钮，智能记忆来路

### 修复与优化
- 彻底解决新版 DSH Web UI 的 401（authentication required）空白页：bridge 反向代理服务端自持 Cookie Jar，突破 iframe 跨站 `SameSite=Strict` 限制，并闭环启动 URL 捕获的时序竞态
- 修复启动 Web UI 时系统默认浏览器自动弹出的问题：强制下发 `--no-open`，确保 Web UI 稳定内嵌展示
- 修复原有文件夹拖拽匹配时 `action.type === 'file'` 的类型误判 bug（遵循官方 `files` 规范）
- 窗口高度 API 严格遵循 uTools 8.0 `setExpandHeight` 规范，并保留旧版本拼写回退，移除可能导致窗口闪退的 `0` 特殊值
- 优化右键菜单交互：引入透明遮罩层，点击任意空白区域均可可靠关闭上下文菜单

## v1.0.3 (2026-09-09)

本版本为 uTools 插件市场发布版本，整合 v1.1.0 与 v1.2.0 的全部功能与修复（详见下方历史条目），并包含：

### 修复
- 修复 DSH RPC 端点格式：DSH 使用点分隔端点（`/api/session.list`），此前斜杠式端点导致所有 API 调用 404、服务器无法启动/接管
- `plugin.json` 新增 `version` 字段，与发布版本号对齐

## v1.2.0 (2026-08-27)

### 新功能
- 🖱️ **会话浏览器右键菜单** — 在会话列表任意条目上右键即可：在 Web UI 中打开、Fork 会话、取消 Agent、截图发送、导出会话、复制会话 ID
  - 菜单操作均锚定到右键点击的会话（此前会误操作最近打开的会话）
- 🛡️ **AbortSignal.any polyfill 注入** — 启动 DSH 服务器时自动注入 polyfill，兼容未实现 `AbortSignal.any()` 的旧版 Node 运行时
- ⏱️ 服务器就绪等待超时延长，覆盖 npx 首次安装下载的耗时场景

### 优化
- Node.js 自动发现增强：探测常见安装位置（nvm、Homebrew 等），不再仅依赖 GUI PATH
- 全局错误处理器：未捕获异常会在 UI 中直接呈现，便于排查
- 服务器管理/Web UI/路由逻辑重构，代码结构更清晰
- 端口探针收紧：仅当端口上确认是真实 DSH 服务（校验 RPC 响应格式）时才接管，避免误认其他 HTTP 服务
- 日志面板裁剪逻辑修正：按实际裁剪量同步滚动游标，日志达到上限后不再重复追加整个缓冲区

### 修复
- 修复 DSH RPC 端点格式：DSH 使用点分隔端点（`/api/session.list`）而非斜杠（`/api/session/list`），此前所有 API 调用返回 404、端口探测失败导致服务无法启动/接管
- 移除「删除会话」菜单项：DSH 0.1.1-rc.2 后端不存在 `session.delete` RPC，该功能此前必然失败
- 修复全屏切换：`setExpendHeight(0)` 会直接关闭 uTools 窗口，改为使用屏幕可用高度
- 修复键盘快捷键失效：`WebUI.init()` 幂等化，Ctrl+L / Ctrl+Shift+F 不再因重复注册而双触发（表现为无响应）
- 修复安装路径含空格时 DSH 启动失败：NODE_OPTIONS 中的 polyfill 路径加引号处理
- 修复 iframe 链接拦截：`hookIframeLinks` 由空实现改为遍历并挂钩所有子 webContents
- 移除无用代码（findFreePort、无意义的相同分支三元表达式）

## v1.1.0 (2026-08-23)

### 新功能
- ⚡ **uTools AI 模型桥接** — Headless 任务可直接使用 uTools 内置 AI 模型（deepseek-v3 等），无需配置 API Key
  - 设置页新增 uTools AI Provider 卡片，自动列出可用模型及费用
  - Headless 模型下拉框支持 DSH 模型与 uTools AI 模型分组选择
- 🔌 **MCP 工具注册** — 向 uTools AI Agent 暴露 5 个 DSH 能力工具
  - `dsh_run_headless`：执行 AI 编程任务
  - `dsh_list_sessions`：列出/搜索会话历史
  - `dsh_read_file`：读取本地文件
  - `dsh_search_sessions`：搜索会话内容
  - `dsh_get_server_status`：获取服务器状态
- 📋 **实时日志查看器** — Web UI 工具栏新增日志面板，实时显示服务器 stdout/stderr，支持 error/warn 高亮
- 🚀 **快捷命令模板** — Headless 页面新增 6 个预定义模板（代码审查/生成测试/重构代码/解释代码/修复 Lint/生成文档）

### 优化
- 全局 DSH CLI 优先：Headless、Plugin、Version 等命令优先使用全局安装的 DSH，避免 npx 网络往返
- 错误处理增强：新增 EACCES 端口权限错误的中文提示和修复建议
- 日志面板内存控制：内容超 50KB 自动裁剪，防止长时间运行内存膨胀

### 修复
- 修复 macOS/Linux 上 bundled npx-cli.js 路径查找失败的问题
- 修复 `runHeadless`/`runPlugin`/`getVersion`/`install` 未设置 PATH 导致 bundled node 不可用
- 修复 Windows 上 `process.env.PATH` 未 fallback 到 `process.env.Path` 的兼容性问题（7 处）
- 修复 Node.js 版本要求显示不一致（UI 显示 22.19+ 实际检查 24.0+）
- 修复 MCP 工具注册异常可能阻断 preload 加载的问题
- 移除插件端工作区选择器，工作区管理完全交给 DSH Web UI 原生界面

## v1.0.0 (2026-08-15)

### 新功能
- 完整迁移 DeepSeek Harness (DSH) 所有能力到 uTools 插件
- 自带 Node.js v24.11.0 LTS 运行时，零系统依赖
- 7 个 uTools 功能指令：主界面、Headless 任务、设置、会话历史、插件管理、工作区、目标管理
- 完整覆盖 DSH 52 个 RPC API 方法（10 个域）
- Web UI 通过 iframe 全屏加载，保留 DSH 全部原生能力
- 环境检测：自动检测 Node.js/npx/pnpm/DSH，一键自动安装运行时
- 模型配置：DeepSeek/Anthropic/OpenAI/自定义 Provider 管理 + 模型自动发现
- Agent 预设管理：查看/复制/删除
- 技能列表浏览
- 会话浏览器：搜索/Fork/取消 Agent/截图发送/导出
- Goal 管理：创建/编辑/暂停/恢复/完成/清除
- 插件管理：安装/卸载/搜索
- 设置页面 7 个 Tab（模型/工作区/预设/技能/服务器/环境/高级）
- uTools API 深度集成：setSubInput、setExpendHeight、screenCapture、hideMainWindowPasteText、动态指令、redirect、onPluginDetach
- API Key 加密存储（utools.dbCryptoStorage）
- 深色模式自动同步
- MCP 客户端集成（utools MCP 网关）
- Cordis 配置树查看（dsh --dump-config）
- 遥测开关
- 服务器自动重启/后台运行
