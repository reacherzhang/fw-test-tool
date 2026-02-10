# IoT Nexus Core

IoT Nexus Core 是专为 Meross IoT 设备设计的桌面端高级调试与测试工具。作为 QA Center 的本地执行引擎，它负责处理复杂的设备通信、长连接维护及自动化测试任务。

![Version](https://img.shields.io/badge/version-1.0.0-blue) ![Electron](https://img.shields.io/badge/Electron-28.x-green) ![React](https://img.shields.io/badge/React-18.x-blue)

## 🌟 核心功能

### 1. 多协议支持
- **Wi-Fi/HTTP**: 支持局域网设备自动发现、HTTP 直连控制及抓包日志。
- **MQTT**: 内置 MQTT 客户端，支持长连接维护、消息订阅/发布、实时日志监控。
- **Matter**: 集成 Matter 协议控制器，支持设备 Commissioning、Cluster 读写及交互测试。

### 2. 智能协议审计
- **AI 辅助生成**: 基于大模型分析 Confluence 协议文档，自动生成测试用例。
- **自动化测试**: 支持批量执行协议测试用例，自动校验响应结果与 Schema 的一致性。
- **可视化报告**: 实时生成测试报告，支持导出及上传至 QA Center。

### 3. QA Center 集成
- **URL Scheme 唤起**: 支持通过 `meross-qa://` 协议从网页端一键唤起，自动同步用户 Token 及测试任务。
- **数据回流**: 测试结果可自动同步回 QA Center 数据库进行归档。

## 🚀 快速开始

### 安装
从 [GitHub Releases](https://github.com/reacherzhang/fw-test-tool/releases) 下载最新版本的安装包并运行安装。

### 使用方式
1. **通过 QA Center 启动 (推荐)**:
   - 登录 [Meross QA Center](http://qa-center.internal)。
   - 进入 "固件协议测试" 模块。
   - 点击 **[启动测试客户端]** 按钮，应用将自动启动并登录。

2. **独立运行**:
   - 启动应用。
   - 手动输入 Meross 账号或 QA Center Token 进行登录。
   - 在左侧菜单选择对应的测试模块。

## 🛠️ 开发指南

### 环境依赖
- Node.js >= 18.0.0
- Python 3.x (用于部分脚本)
- MySQL (用于本地数据存储)

### 本地运行
```bash
# 1. 克隆仓库
git clone https://github.com/reacherzhang/fw-test-tool.git

# 2. 安装依赖
npm install

# 3. 启动开发模式
npm run dev
```

### 构建打包
```bash
# 构建 Windows 安装包
npm run build:win

# 构建 macOS 安装包
npm run build:mac
```

## 🔗 关联项目
- **Backend**: `meross_qa_center` (Django)
- **Frontend**: `meross_test_task_management` (Vue)

## 📄 License
[MIT](LICENSE)
