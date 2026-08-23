# 更新日志

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
