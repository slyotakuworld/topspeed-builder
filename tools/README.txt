Topspeed Builder - 命令行工具（tool 目录）
=========================================

本目录随应用一起分发（绿色版目录与安装版安装后的 tool/ 均包含）。两个启动器都复用
同目录外的 Electron 运行时（通过 ELECTRON_RUN_AS_NODE），因此使用者不需要另外安装
Node.js。

目录内容
--------
  topspeed-cli.cmd   CLI：批量出图 + 自动切分入库
  topspeed-mcp.cmd   MCP：以 HTTP 方式对外提供出图 / 切图能力
  cli.cjs            CLI 实际代码（由 npm run build:extra 生成）
  mcp.cjs            MCP 实际代码（由 npm run build:extra 生成）

注意：请保持 tool 文件夹在解压后的应用目录内（与 "Topspeed Builder.exe"
位于同一层级的上下级关系），两个 .cmd 依赖 ..\Topspeed Builder.exe 启动。

CLI 用法
--------
双击 topspeed-cli.cmd 会打印完整帮助。命令行示例：

  topspeed-cli.cmd --project D:\proj --name heroes --type character ^
    --count 6 --size 1024x1024 ^
    --description "赛博朋克英雄图标" ^
    --cell-names 剑士,法师,弓手,盗贼,牧师,骑士

常用参数：
  --project <dir>        项目目录（必填）
  --name <text>          批次名 / 输出前缀（必填）
  --description <text>   整体描述（必填）
  --count <n>            素材数量 1-36（必填）
  --type <type>          character/enemy/icon/item/ui/background/effect/other
  --size <WxH>           画布尺寸，如 1024x1024
  --style <text>         美术风格描述
  --quality <q>          low/medium/high
  --detail <text>        细节提示词
  --cell-names <a,b,c>   素材名称清单（逗号分隔）
  --reference <path[:role]>  参考图，可重复；role=subject/style/composition/palette
  --no-transparent       关闭透明背景
  --no-trim              关闭边缘裁剪
  --slice-cols / --slice-rows / --slice-use-auto / --slice-shrink <n>
  --json <file>          从 JSON 文件读取全部参数
  --print-json           仅把结果 JSON 打到 stdout（日志走 stderr，便于管道消费）

MCP 用法
--------
双击 topspeed-mcp.cmd 即在本机 127.0.0.1:3000 启动 MCP HTTP 服务。
可用环境变量覆盖：

  set MCP_PORT=4000          监听端口，默认 3000
  set MCP_HOST=0.0.0.0       监听地址，默认 127.0.0.1（0.0.0.0 对局域网开放，风险自负）
  set MCP_SESSION_IDLE_MS=0  空闲会话回收阈值，默认 30 分钟

客户端接入地址：http://127.0.0.1:3000/mcp
健康检查：      http://127.0.0.1:3000/healthz

对外暴露一个工具 generate_sprites（参数结构与 cli.cjs 的 --json 一致），
在 IDE / Agent 客户端的 MCP 配置中这样接入（流式 HTTP 传输）：

  {
    "mcpServers": {
      "topspeed-builder": {
        "url": "http://127.0.0.1:3000/mcp"
      }
    }
  }

保存后保持 topspeed-mcp.cmd 在运行，客户端即可发现并调用该工具。

配置来源（重要）
----------------
CLI / MCP 与 GUI 共用同一份配置，默认读取：

  %APPDATA%\topspeed-builder\settings.json

也就是说：先在 GUI 的「设置」页里配置好出图 API（Base URL + API Key），
CLI / MCP 就能直接复用，无需重复配置。

如需指向别的配置目录，可在运行前设置：

  set TOPSPEED_USER_DATA=D:\some\dir
