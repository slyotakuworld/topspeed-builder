# Topspeed Builder

本地桌面端 AI 2D 游戏素材工程化生成工具。把 AI 生成结果从"好看的图片"整理成可直接导入 Unity、Godot、Tiled、Phaser 和 Cocos 的素材包。

面向独立游戏开发者、美术原型师和小型游戏团队：创建本地项目、统一风格、批量生成图标、道具、角色、怪物、背景、特效和瓦片集，再通过本地后处理、精灵表、纹理图集和导出模板完成交付。

所有项目文件、历史记录、参考图和 API Key 都保存在本机，没有必须依赖的云端服务；需要联网的部分仅是你配置的图片生成接口。

## 核心能力

| 模块 | 能力 |
|---|---|
| 项目管理 | 创建本地项目目录、写入 `project.json`、维护最近项目 |
| 生成模式 | 文本生成、参考图生成、自定义接口、本地草稿模式 |
| 参考图工作流 | 导入主体、风格、构图、色板参考图，支持蒙版局部替换 |
| 批量生产 | 按名称列表生成图标、道具、界面素材等批量资源 |
| 角色动画 | 按动作帧配置生成角色序列，并合成 Sprite Sheet |
| 瓦片集 | 生成瓦片 PNG、预览图、元数据和 Tiled 地图文件 |
| 本地后处理 | 使用 Sharp 完成透明背景、裁切、尺寸统一和 PNG 输出 |
| 图集打包 | 合成 Texture Atlas，并输出 JSON 帧坐标 |
| 导出打包 | 生成 Unity / Godot / Tiled / Phaser / Cocos / 通用目录和 ZIP 包 |
| 历史记录 | 保存提示词、参数、输出文件和生成时间，便于回溯 |

## 典型使用流程

1. 新建或打开一个本地素材项目。
2. 配置游戏类型、美术风格、默认尺寸和导出目标。
3. 选择素材类型，填写名称、描述、参考图、动作帧或瓦片主题。
4. 使用 `local-draft` 离线验证流程，或切换到 OpenAI 兼容接口执行真实生成。使用中转站 API 时可在设置中选择 `OpenAI 图片格式` 或 `OpenAI Chat 格式` 来匹配不同后端协议。
5. 在预览页检查素材包、精灵表、图集和元数据。
6. 选择目标引擎并导出目录，可同时生成完整 ZIP 资源包。

## 快速开始

建议使用 Node.js 22。

```bash
npm install
npm run dev       # 开发模式启动 Electron 应用
npm run typecheck # TypeScript 类型检查
npm run build     # 构建到 build/out/
```

打包安装包（应用图标位于 `assets/`，可用 `npm run generate:icon` 重新生成）：

```bash
npm run dist:win       # Windows NSIS 安装包，输出到 build/release/
npm run dist:mac:arm64 # Apple Silicon DMG/ZIP
npm run dist:mac:x64   # Intel Mac DMG/ZIP
npm run dist:linux     # AppImage / deb
```

macOS 公开发布需使用 Developer ID 证书签名并通过 Apple 公证：配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 后，运行 `npm run dist:mac:signed:*` 即可。

## 智能生成接口

在设置页配置图片生成服务：

| 配置项 | 说明 |
|---|---|
| 服务商 | `openai`、`custom` 或 `local-draft` |
| API 格式 | 自定义接口时可选 `OpenAI 图片格式`（默认）或 `OpenAI Chat 格式`，匹配不同中转站后端 |
| 接口密钥 | 图片生成服务的 API Key，仅保存在本机 |
| 接口基础地址 | OpenAI 兼容图片生成或图片编辑接口地址 |
| 模型 | 例如 `gpt-image-1.5`、`gpt-image-1`、`gpt-image-1-mini` |

设置页提供 **检测连接** 按钮，可发送一条极小请求验证 DNS 解析、SSL 证书、API Key 鉴权和网络连通性，无需等待正式生成就能确认配置是否正常。

OpenAI 兼容文本生成最小请求体：

```json
{
  "model": "gpt-image-1.5",
  "prompt": "提示词文本",
  "n": 1,
  "size": "1024x1024"
}
```

Chat 格式请求体（选择 `OpenAI Chat 格式` 时发送）：

```json
{
  "model": "gpt-image-1.5",
  "messages": [
    { "role": "system", "content": "You are an image generation AI..." },
    { "role": "user", "content": "提示词文本" }
  ],
  "max_tokens": 4096
}
```

图生图模式会在本地项目中保存参考图副本，并通过 OpenAI 图片编辑兼容接口发送分段表单请求。

`local-draft` 模式不会调用外部 API，会生成本地占位 PNG，适合在没有密钥、没有网络或不想消耗额度时验证完整生成链路。

## 本地项目结构

```text
project.json
generated/
  raw/
  processed/
sprites/
icons/
tilesets/
sheets/
atlas/
exports/
history/
references/
  images/
  masks/
  thumbnails/
```

## 导出目标

| 目标 | 输出内容 |
|---|---|
| Unity | PNG、Sprite Sheet、Atlas、JSON 元数据、导入说明 |
| Godot | PNG、Sprite Sheet、SpriteFrames 说明、JSON 元数据、导入说明 |
| Tiled | TileSet PNG、TileSet JSON、TMX 地图文件、导入说明 |
| Phaser / Cocos | PNG、Sprite Sheet、Atlas、JSON 帧数据 |
| 通用 | 通用 PNG + JSON 元数据 |
| ZIP | 完整导出资源包 |

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面壳 | Electron 33 |
| 前端 | React 18、TypeScript、Lucide React |
| 国际化 | i18next、react-i18next |
| 构建 | Vite 5、electron-vite、electron-builder |
| 图像处理 | Sharp |
| 归档导出 | JSZip |
| 本地存储 | JSON 文件、项目目录、Electron userData |

## License

MIT
