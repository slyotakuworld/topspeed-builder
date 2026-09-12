# Topspeed Builder

本地桌面端 AI 2D 游戏素材生成工具。按网格批量生成素材大图，自动（或手动自由）切分为单张素材并入库管理，产出可直接拖进 Unity、Godot 等引擎使用的 PNG 素材。

面向独立游戏开发者、美术原型师和小型游戏团队。所有项目文件、历史记录、参考图和 API Key 都保存在本机，没有必须依赖的云端服务；需要联网的部分仅是你配置的图片生成接口。

## 核心能力

| 模块 | 能力 |
|---|---|
| 项目管理 | 创建 / 打开本地项目目录（`project.json`），维护最近项目 |
| 网格批量生成 | 一次生成一张含多个格子的网格大图（按素材类型与名称列表批量出图），支持参考图辅助 |
| 参考图 | 导入参考图到项目（自动生成缩略图），生成时作为风格 / 主体参照，双击放大查看 |
| 智能切图 | 自动检测网格间距并切分整图；也可用自由切图手动框选 |
| 素材库 | 与生成历史同一份台账：生成即自动入库；草稿 / 整图 / 已切图三态展示，支持重命名、删除、放大预览、拷贝 PNG 到默认导出目录 |
| 提示词助手 | 独立的 LLM 配置，根据一句自然语言批量生成描述、细节提示词、格子名称与风格 |
| 生成历史 | 保存提示词、参数、输出文件和生成时间，可切回历史配置重新编辑 |
| 本地草稿模式 | `local-draft` 不调用外部 API，生成本地占位 PNG，零成本验证完整链路 |
| CLI 与 MCP | 打包产物自带命令行出图工具与 HTTP MCP 服务，供 IDE / Agent 客户端调用 |

## 典型使用流程

1. 新建或打开一个本地素材项目。
2. 在设置页配置图片生成接口（支持 `OpenAI 图片格式` / `OpenAI Chat 格式` 两种协议），可先「检测连接」验证配置。
3. 选择素材类型，填写名称列表、描述、参考图；也可让提示词助手根据一句自然语言代填这些字段。
4. 生成网格大图 → 自动检测网格并切分入库（或自由切图手动框选）。
5. 在素材库查看、重命名、放大检查切图结果，需要时拷贝 PNG 到默认导出目录。

## 快速开始

Windows 可直接双击 `start.cmd`，进入中文菜单选择启动开发模式 / 安装依赖 / 构建 / 打包。

命令行方式（建议使用 Node.js 22）：

```bash
npm install
npm run dev       # 开发模式启动 Electron 应用
npm run typecheck # TypeScript 类型检查
npm run build     # 构建到 build/out/
```

打包 Windows 版（应用图标位于 `assets/`；同时产出免安装目录和 NSIS 安装器）：

```bash
npm run pack:win      # Windows：绿色版目录 build/release/win-unpacked/ + 安装包 Topspeed Builder Setup <版本>.exe
npm run dist:mac      # macOS
npm run dist:linux    # Linux AppImage / deb
```

`build/release/win-unpacked/` 整个目录即可直接分发，无需安装；安装包 exe 则适合双击安装、自动创建桌面 / 开始菜单快捷方式的场景。

## CLI 与 MCP

打包时，win-unpacked 与安装后的 `tool/` 子目录都会自动带上 CLI 与 MCP（`scripts/before-pack.cjs` 在打包前构建）：

| 启动器 | 作用 |
|---|---|
| `tool\topspeed-cli.cmd` | 命令行出图（生成网格大图 + 智能切分入库），双击显示帮助 |
| `tool\topspeed-mcp.cmd` | 启动 HTTP MCP 服务（默认 `http://127.0.0.1:3000/mcp`），供 IDE / Agent 客户端连接 |

两者复用应用自带的 Electron 运行时（`ELECTRON_RUN_AS_NODE=1`），目标机器**无需安装 Node.js**；依赖从 `resources/app.asar` 内解析（含 sharp）。接口配置与 GUI 共用 `%APPDATA%\topspeed-builder\settings.json`，修改 GUI 设置后重跑 CLI / 重启 MCP 即生效（也可用环境变量 `TOPSPEED_USER_DATA` 指向独立配置目录）。

### CLI 用法

双击 `tool\topspeed-cli.cmd` 可查看完整参数帮助（等同于 `--help`）。常用示例：

```bash
# 生成 6 个赛博朋克角色并自动切分入库
tool\topspeed-cli.cmd --project D:\games\my-project --name heroes --type character --count 6 ^
  --description "赛博朋克英雄" --size 1024x1024 --quality low ^
  --cell-names 剑士,法师,弓手,盗贼,牧师,骑士

# 带参考图（role=subject/style/composition/palette，可重复）
tool\topspeed-cli.cmd --project D:\games\my-project --name items --type item --count 4 ^
  --description "森林药水道具" --reference D:\refs\tree.png:style

# 关闭透明背景 / 手动指定网格
tool\topspeed-cli.cmd ... --no-transparent --slice-cols 3 --slice-rows 2
```

说明：`--project` 指向的项目需先用 GUI 创建；`--print-json` 把结果 JSON 输出到 stdout（日志走 stderr），便于脚本管道处理；复杂参数可写进 `--json input.json`（字段与 GUI 的生成输入一致，可带 `slice` 覆盖项）。

### MCP 配置（IDE / Agent 客户端）

双击 `tool\topspeed-mcp.cmd` 启动 HTTP MCP 服务：

- 端点：`http://127.0.0.1:3000/mcp`（健康检查 `/healthz`），Ctrl+C 停止；
- 端口 / 监听地址可在启动前用环境变量覆盖：`set MCP_PORT=4000`、`set MCP_HOST=0.0.0.0`（对局域网开放，注意防火墙与鉴权风险）；
- 对外暴露一个工具 `generate_sprites`（参数与 CLI 的 `--json` 结构一致），客户端用它生成网格大图并自动切分入库。

在 IDE / Agent 客户端的 MCP 配置中添加（以流式 HTTP 传输为例）：

```json
{
  "mcpServers": {
    "topspeed-builder": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

保存后先运行 `tool\topspeed-mcp.cmd` 保持服务在线，客户端即可发现并调用 `generate_sprites`。

macOS 公开发布需使用 Developer ID 证书签名并通过 Apple 公证：配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 后，运行 `npm run dist:mac:signed:*` 即可。

## 生成接口配置

在设置页配置图片生成服务：

| 配置项 | 说明 |
|---|---|
| 服务商 | `openai`、`custom` 或 `local-draft` |
| API 格式 | 自定义接口时可选 `OpenAI 图片格式`（默认）或 `OpenAI Chat 格式`，匹配不同中转站后端 |
| 接口密钥 | 图片生成服务的 API Key，仅保存在本机 |
| 接口基础地址 | OpenAI 兼容图片生成或图片编辑接口地址 |
| 模型 | 通过「拉取模型」从接口获取列表后选择 |

设置页提供 **检测连接** 按钮，可发送一条极小请求验证 DNS 解析、SSL 证书、API Key 鉴权和网络连通性，无需等待正式生成就能确认配置是否正常。

OpenAI 兼容图片生成最小请求体：

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

参考图模式会在本地项目中保存参考图副本，并通过 OpenAI 图片编辑兼容接口发送分段表单请求。

`local-draft` 模式不会调用外部 API，会生成本地占位 PNG，适合在没有密钥、没有网络或不想消耗额度时验证完整生成链路。

## 提示词助手

提示词助手是独立于出图接口的第二套 LLM 配置（接口地址、Key、模型均单独设置，持久化在 `settings.json` 的 `promptAssistant` 子键）。在生成页弹窗中输入一句自然语言（如"一批像素风的森林怪物"），助手会一次性生成：

- 整体描述（description）
- 对象细节提示词（detailPrompt）
- 每个格子的名称（cellNames，数量与网格一致）
- 美术风格（style）

四类字段可在助手设置中单独开关是否生成，勾选结果应用后即填入表单。

## 本地项目结构

```text
project.json        # 项目配置
history.json        # 生成历史台账（素材库数据源）
generated/
  raw/<runId>/grid.png   # 网格原始大图
  thumbs/<runId>.png     # 台账缩略图缓存
sprites/<素材>/     # 切分后的单张素材 PNG（素材库主体）
references/
  images/            # 参考图
  thumbnails/        # 参考图缩略图
```

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面壳 | Electron 33 |
| 前端 | React 18、TypeScript、Lucide React |
| 国际化 | i18next、react-i18next |
| 构建 | Vite 5、electron-vite、electron-builder |
| 图像处理 | Sharp |
| 本地存储 | JSON 文件、项目目录、Electron userData |

## License

MIT
