# DeepSeek Harness — AI Agent 工作台

> DeepSeek AI 开源的 Agent 工作台，完整迁移到 uTools。自带 Node.js 运行时，零系统依赖。

## 简介

DeepSeek Harness（DSH）是 DeepSeek AI 开源的 AI Agent 框架，架构理念"一切皆插件"。本插件将 DSH 的全部能力迁移到 uTools 中，让你在 uTools 里直接使用完整的 AI 编程助手。

**无需安装 Node.js** — 插件自带 Node.js v24 LTS 运行时，下载即用。

## 功能指令

| 关键词 | 功能 |
|---|---|
| `dsh` / `AI Agent` | 启动服务器并打开 Web UI 工作台 |
| `dsh headless` | 输入任务描述，一键执行并获取结果 |
| `dsh settings` | 模型配置 / 工作区 / Agent 预设 / 技能 / 服务器设置 |
| `dsh sessions` | 会话历史浏览（搜索、Fork、取消、截图发送） |
| `dsh plugins` | DSH 插件安装/卸载/搜索 |
| `dsh workspace` | 选择文件夹直接作为工作区打开 |
| `dsh goals` | 会话目标管理（创建/暂停/恢复/完成） |

## 核心特性

- 🔧 **自带运行时** — 内置 Node.js v24.11.0 LTS，不依赖系统环境
- 🎯 **完整能力** — DSH 全部 52 个 RPC API + 22 个工具完整覆盖
- 🤖 **多模型支持** — DeepSeek / Anthropic / OpenAI / 自定义 Provider
- 📋 **Headless 模式** — 输入任务描述，流式输出结果，支持粘贴到其他应用
- 📁 **会话管理** — 搜索 / Fork / 取消 / 截图发送 / 导出
- 🎛️ **插件系统** — 安装/卸载 DSH 插件，管理 Profile
- 🌙 **深色模式** — 自动同步 uTools 主题
- 🔒 **安全存储** — API Key 加密存储

## 截图

| 界面 | 说明 |
|---|---|
| ![主界面](screenshots/01-main-environment.png) | 环境检测 + 服务器状态 |
| ![Web UI](screenshots/02-web-ui-conversation.png) | DSH Web UI 对话界面 |
| ![Headless](screenshots/03-headless-task.png) | Headless 任务运行器 |
| ![设置](screenshots/04-settings-models.png) | 模型配置页面 |
| ![会话](screenshots/05-sessions-list.png) | 会话历史浏览器 |

## 快速开始

1. 在 uTools 中输入 `dsh`
2. 环境检测自动通过（自带 Node.js 运行时）
3. 选择工作区目录
4. 点击"启动服务器"
5. Web UI 自动打开，开始使用

## 配置模型

1. 输入 `dsh settings`
2. 在"模型配置"Tab 中输入 DeepSeek API Key
3. 或添加 Anthropic/OpenAI/自定义 Provider
4. 支持"获取模型"自动发现可用模型

## 技术架构

插件采用**进程管理 + iframe 嵌入**方案：
- `preload.js` 通过 `child_process` 管理 DSH 服务器进程
- uTools 窗口通过 iframe 加载 DSH Web UI
- `preload.js` 暴露完整 52 个 DSH RPC API 方法
- uTools API 深度集成（setSubInput / screenCapture / 动态指令 / 加密存储等）

## 文件结构

```
├── plugin.json          # 插件配置（7 个功能指令）
├── preload.js           # Node.js 桥接层（52 RPC + 服务器管理 + 运行时）
├── index.html           # 主入口页面
├── logo.png             # 插件图标
├── runtime/node/        # 自带 Node.js v24.11.0 LTS
├── css/                 # 样式文件
├── js/                  # 9 个 JS 模块
├── screenshots/         # 插件截图
├── CHANGELOG.md         # 更新日志
└── LICENSE              # MIT 许可证
```

## 许可证

MIT — 与 DeepSeek Harness 保持一致

## 相关链接

- [DeepSeek Harness GitHub](https://github.com/deepseek-ai/deepseek-harness)
- [uTools 开发者文档](https://www.u-tools.cn/docs/developer/basic/getting-started.html)
