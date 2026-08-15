# 更新日志

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
