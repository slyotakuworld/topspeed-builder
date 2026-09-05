# 1. 项目背景

## 1.1 背景说明

2D 游戏开发中，大量时间消耗在基础素材制作、切图、动画帧整理、图集打包、格式转换和引擎导入上。

常见 2D 游戏素材包括：

- 角色 Sprite
- 怪物 Sprite
- 道具图标
- UI 元素
- TileSet 地图块
- 背景图
- 特效序列帧
- Sprite Sheet
- Texture Atlas
- TileMap 资源

目前常规 AI 生图工具虽然可以生成图片，但往往无法直接用于游戏开发流程，主要问题包括：

1. 生成结果只是单张图片，不是工程化素材包。
2. 透明背景、尺寸、切片、命名、图集等仍需人工处理。
3. 批量生成时风格不统一。
4. 角色动作帧不连续，难以形成可用动画。
5. TileSet 无法无缝拼接。
6. 无法直接导出 Unity、Godot、Tiled 等工具可用格式。
7. 对非美术人员不友好，Prompt 成本较高。

因此，本项目希望开发一款面向 2D 游戏开发流程的 AI 素材生成工具，让用户通过文本或简单参数快速生成可直接进入游戏工程的素材包。

---

# 2. 产品定位

## 2.1 产品名称

**topspeed-builder

## 2.2 产品一句话描述

本项目是一款本地桌面端 AI 2D 游戏素材生成工具，用户可以通过文本描述或简单参数生成角色、道具、图标、UI、TileSet、动画帧等素材，并自动完成透明背景处理、尺寸规范化、Sprite Sheet 合成、Atlas 打包、metadata 生成和 Unity / Godot / Tiled 等主流 2D 游戏开发流程的导出适配。

## 2.3 产品不是

本产品不是普通 AI 生图网站。

它不是：

- 单纯输入 Prompt 输出图片
- 只生成一张美术图
- 在线图库网站
- Photoshop 替代品
- Aseprite 替代品
- Unity 或 Godot 编辑器替代品

## 2.4 产品是

它应该是：

- AI 2D 游戏素材生成工具
- 本地游戏素材管理工具
- Sprite Sheet 自动生成工具
- Texture Atlas 自动打包工具
- TileSet 辅助生成工具
- Unity / Godot / Tiled 导出工具
- 游戏原型开发提效工具

---

# 3. 本地桌面应用

## 3.1 产品形态结论

最终产品形态应为：

```text
本地桌面应用
+ AI 图像生成 API
+ 本地图像处理
+ 本地项目管理
+ Sprite Sheet / Atlas / TileSet 自动导出
+ Unity / Godot / Tiled 工作流适配
```

---

# 4. 目标用户

## 4.1 主要用户

| 用户类型 | 需求 |
|---|---|
| 独立游戏开发者 | 快速生成原型素材，降低美术成本 |
| 小型游戏团队 | 批量生成统一风格的 2D 素材 |
| 游戏策划 | 快速验证角色、道具、关卡视觉方案 |
| 游戏美术 | 用 AI 快速出草稿，再进行二次编辑 |
| 学生 / 比赛团队 | 在有限时间内完成可演示游戏素材 |
| Game Jam 参赛者 | 快速生成可用素材并导出到游戏引擎 |

## 4.2 用户痛点

1. 不会画图，但需要大量游戏素材。
2. AI 生图结果不能直接用于游戏。
3. 角色动画帧制作成本高。
4. TileSet 制作难度高。
5. 素材命名、切图、打包流程繁琐。
6. Unity / Godot / Tiled 导入仍需大量手动操作。
7. 不同批次生成的素材风格不统一。
8. 游戏原型开发阶段不希望投入大量美术成本。

---

# 5. 产品目标

## 5.1 总体目标

开发一款本地运行的 AI 2D 游戏素材生成工具，使用户能够通过简单描述或参数配置，快速生成可直接用于游戏开发的素材包。

## 5.2 核心目标

1. 降低 2D 游戏素材制作门槛。
2. 提高游戏原型开发速度。
3. 支持常见 2D 游戏素材类型。
4. 自动完成素材工程化处理。
5. 保证同一项目内素材风格一致。
6. 支持主流游戏开发工具导出。
7. 使 AI 生成结果真正可用于游戏工程。

---

# 6. 核心用户流程

## 6.1 完整用户流程

```text
启动软件
↓
创建或打开本地项目
↓
设置游戏类型、美术风格、默认尺寸、导出目标
↓
选择素材类型
↓
输入文本描述或填写简单参数
↓
调用 AI 生成素材
↓
系统自动进行透明背景、裁切、尺寸统一等处理
↓
用户预览并选择是否重新生成局部素材
↓
系统生成 Sprite Sheet / Atlas / TileSet / metadata
↓
用户选择导出目标
↓
导出 Unity / Godot / Tiled / 通用资源包
```

## 6.2 典型使用场景

### 场景一：批量生成 RPG 道具图标

用户输入：

```text
生成 30 个中世纪 RPG 道具图标，包括药水、金币、钥匙、短剑、盾牌、卷轴、魔法石。
风格为 32x32 像素风，透明背景，统一色调。
```

系统输出：

```text
30 个 PNG 图标
icons_atlas.png
icons_atlas.json
```

### 场景二：生成角色 Sprite Sheet

用户输入：

```text
生成一个 64x64 横版像素风骑士角色。
动作包括 idle、walk、attack、hurt、death。
每个动作 4 帧。
透明背景。
导出 Unity 和 Godot 可用 Sprite Sheet。
```

系统输出：

```text
角色序列帧
角色 sprite sheet
动作 metadata
Unity 导入说明
Godot 导入说明
```

### 场景三：生成地牢 TileSet

用户输入：

```text
生成一个 32x32 地牢 TileSet。
包含地板、墙体、内角、外角、门、水池、裂缝、宝箱。
要求 tile 之间可以无缝拼接。
导出 Tiled 和 Unity Tilemap 可用资源。
```

系统输出：

```text
tileset.png
tileset.json
tileset.tmx
tile preview image
Unity Tilemap 导入说明
```

---

# 7. 功能范围

## 7.1 必须实现的功能

| 模块 | 功能 |
|---|---|
| 项目管理 | 创建项目、打开项目、保存项目配置 |
| 风格设置 | 设置游戏类型、美术风格、默认尺寸 |
| 素材生成 | 根据文本和参数生成素材 |
| 图标生成 | 批量生成道具 / 技能 / UI 图标 |
| 角色生成 | 生成角色基础帧和动作帧 |
| Sprite Sheet | 自动合成角色 Sprite Sheet |
| TileSet 生成 | 生成基础地图块素材 |
| 后处理 | 去背景、透明通道、裁切、尺寸统一 |
| Atlas 打包 | 将多张 PNG 打包为图集 |
| metadata 生成 | 生成 JSON 描述文件 |
| 导出 | 支持 Unity / Godot / Tiled / 通用 PNG + JSON |
| 下载 / 保存 | 导出完整资源包或写入本地目录 |
| 历史记录 | 保存生成记录、Prompt、参数和输出文件 |

## 7.2 可选功能

| 功能 | 说明 |
|---|---|
| 局部重绘 | 对某一帧或某一区域重新生成 |
| 参考图上传 | 根据参考图保持风格一致 |
| 色板提取 | 从参考图中提取主色板 |
| 风格模板 | 保存常用风格配置 |
| Seed 固定 | 保持生成结果稳定 |
| 动画预览 | 在软件中播放 Sprite 动画 |
| Unity 插件 | 更进一步实现一键导入 Unity |
| Godot 插件 | 更进一步实现一键导入 Godot |
| Aseprite 导出 | 输出 Aseprite 兼容文件或 JSON |

## 7.3 暂不实现的功能

第一版不建议实现以下功能：

1. 不做多人协作。
2. 不做素材交易市场。
3. 不做复杂图片编辑器。
4. 不做完整 Photoshop 功能。
5. 不做 3D 素材生成。
6. 不做骨骼动画系统。
7. 不做自训练大模型平台。
8. 不做复杂账号系统。
9. 不做云端项目管理。
10. 不做在线社区。

---

# 8. 页面设计

## 8.1 页面结构

本地应用建议包含以下页面：

1. 项目首页
2. 项目配置页
3. 素材生成页
4. 素材预览与编辑页
5. 风格管理页
6. 导出页面
7. 历史记录页
8. 设置页面

---

## 8.2 项目首页

### 功能

- 新建项目
- 打开已有项目
- 最近项目列表
- 选择本地项目目录
- 进入项目工作区

### 字段

```text
项目名称
项目路径
游戏类型
默认美术风格
默认素材尺寸
默认导出目标
```

### 项目目录示例

```text
MyGameAssets/
  project.json
  generated/
  sprites/
  icons/
  tilesets/
  atlas/
  exports/
  history/
```

---

## 8.3 项目配置页

### 功能

设置当前项目的基础信息。

### 字段

```text
项目名称
游戏类型：平台跳跃 / RPG / 俯视角 / 卡牌 / 塔防 / 横版动作 / 或其他
美术风格：像素风 / 手绘风 / Q版 / 暗黑 / 科幻 / 中世纪 / 或其他
默认分辨率：16x16 / 32x32 / 64x64 / 128x128 / 或其他
默认背景：透明 / 纯色 / 自定义
默认导出目标：Unity / Godot / Tiled / Phaser / 通用 PNG
```

---

## 8.4 素材生成页

### 功能

用户通过简单参数生成素材。

### 素材类型

```text
角色 Character
怪物 Enemy
道具 Item
图标 Icon
UI 元素 UI
地图块 TileSet
背景 Background
特效 Effect
```

### 通用参数

```text
素材名称
素材描述
素材类型
美术风格
尺寸
数量
背景类型
是否透明背景
导出目标
```

### 角色参数

```text
角色名称
角色描述
视角：横版 / 俯视角 / 四方向 / 八方向
尺寸：32x32 / 64x64 / 128x128
动作：idle / walk / run / jump / attack / hurt / death
每个动作帧数
是否循环动画
是否生成 Sprite Sheet
```

### 图标参数

```text
图标主题
图标数量
图标列表
尺寸
风格
透明背景
是否生成 atlas
```

### TileSet 参数

```text
TileSet 名称
主题：草地 / 地牢 / 沙漠 / 雪地 / 科幻基地
Tile 尺寸：16x16 / 32x32 / 64x64
Tile 类型：地板 / 墙体 / 水 / 路 / 门 / 装饰
是否需要边缘拼接
是否导出 Tiled
是否导出 Unity Tilemap
```

---

## 8.5 素材预览与编辑页

### 功能

生成后展示素材，并允许用户进行轻量编辑。

### 预览能力

```text
单张 PNG 预览
序列帧预览
Sprite Sheet 预览
动画播放预览
TileSet 拼接预览
Atlas 预览
```

### 编辑能力

```text
删除素材
重新生成素材
重新生成某一帧
修改素材名称
调整帧顺序
调整帧率
设置是否循环
裁切透明边缘
统一画布尺寸
设置 pivot 锚点
```

---

## 8.6 风格管理页

### 功能

用于保持项目内素材风格一致。

### 功能点

```text
上传参考图
保存风格描述
提取主色板
保存风格模板
固定生成 seed
统一线条粗细
统一光照方向
统一角色比例
统一视角
```

### 风格模板示例

```text
16-bit 像素风
低饱和中世纪幻想
Q版二头身角色
赛博朋克霓虹风
黑暗地牢风
卡通手绘风
```

---

## 8.7 导出页面

### 功能

将当前项目素材导出为目标游戏开发工具可用格式。

### 导出目标

```text
Unity
Godot
Tiled
Phaser
Cocos
通用 PNG + JSON
ZIP 资源包
```

### 导出内容

```text
PNG 单帧
PNG 序列帧
Sprite Sheet
Atlas 图集
JSON metadata
TMX / TSX 文件
导入说明 README
完整 ZIP 包
```

---

## 8.8 历史记录页

### 功能

保存每次生成记录，方便追溯和重新生成。

### 记录内容

```text
生成时间
素材类型
Prompt
参数
使用风格
输出文件路径
导出目标
是否收藏
是否已导出
```

---

## 8.9 设置页面

### 功能

配置 API Key、模型、默认路径和软件参数。

### 字段

```text
AI API Provider
API Key
默认模型
默认导出目录
默认图像尺寸
默认生成数量
是否保存 Prompt 历史
是否自动生成透明背景
是否自动裁切
是否自动打包 atlas
```

---

# 9. 核心模块详细需求

## 9.1 项目管理模块

### 需求

用户可以创建一个本地素材项目，项目中保存所有生成素材、配置和历史记录。

### 功能列表

| 功能 | 优先级 |
|---|---|
| 新建项目 | P0 |
| 打开项目 | P0 |
| 保存项目配置 | P0 |
| 最近项目列表 | P0 |
| 删除项目记录 | P0 |

### project.json 示例

```json
{
  "projectName": "Demo RPG Game",
  "gameType": "RPG",
  "style": "16-bit pixel art",
  "defaultResolution": "32x32",
  "exportTargets": ["unity", "godot", "tiled"],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

---

## 9.2 AI 素材生成模块

### 需求

用户通过自然语言或简单表单参数生成素材。

### 输入

```json
{
  "assetType": "character",
  "name": "knight",
  "description": "silver armor, short sword, side-view action game character",
  "style": "16-bit pixel art",
  "size": "64x64",
  "background": "transparent",
  "count": 1
}
```

### 输出

```json
{
  "assetId": "asset_001",
  "files": [
    "generated/knight/knight_idle_0.png",
    "generated/knight/knight_idle_1.png"
  ],
  "metadata": "generated/knight/metadata.json"
}
```

### 要求

1. 支持文本生成。
2. 支持表单参数生成。
3. 支持批量生成。
4. 支持生成失败重试。
5. 支持保存原始 Prompt 和生成参数。
6. 支持透明背景需求。
7. 支持固定风格描述。

---

## 9.3 图标 / 道具批量生成模块

### 需求

批量生成游戏道具、技能、UI 图标。

### 输入示例

```text
生成 20 个 32x32 中世纪 RPG 道具图标，包含药水、金币、钥匙、短剑、盾牌、卷轴、魔法石。
像素风，透明背景，统一色调。
```

### 输出

```text
icons/
  potion.png
  coin.png
  key.png
  sword.png
  shield.png

atlas/
  icons_atlas.png
  icons_atlas.json
```

### 要求

1. 每个图标单独保存。
2. 所有图标尺寸统一。
3. 背景透明。
4. 自动命名。
5. 支持批量生成 atlas。
6. 支持重新生成单个图标。

---

## 9.4 角色 Sprite Sheet 生成模块

### 需求

生成角色动作序列帧，并合成为 Sprite Sheet。

### 支持动作

```text
idle
walk
run
jump
fall
attack
hurt
death
cast
defend
```

### 输入示例

```json
{
  "characterName": "knight",
  "description": "silver armor knight with short sword",
  "view": "side-view",
  "size": "64x64",
  "style": "16-bit pixel art",
  "animations": [
    {
      "name": "idle",
      "frames": 4,
      "fps": 6,
      "loop": true
    },
    {
      "name": "walk",
      "frames": 4,
      "fps": 8,
      "loop": true
    },
    {
      "name": "attack",
      "frames": 4,
      "fps": 10,
      "loop": false
    }
  ]
}
```

### 输出

```text
sprites/
  knight/
    knight_idle_0.png
    knight_idle_1.png
    knight_idle_2.png
    knight_idle_3.png
    knight_walk_0.png
    knight_walk_1.png
    knight_walk_2.png
    knight_walk_3.png
    knight_attack_0.png
    knight_attack_1.png
    knight_attack_2.png
    knight_attack_3.png

sheets/
  knight_spritesheet.png
  knight_spritesheet.json
```

### metadata 示例

```json
{
  "character": "knight",
  "frameSize": {
    "width": 64,
    "height": 64
  },
  "sheet": "knight_spritesheet.png",
  "animations": {
    "idle": {
      "frames": [0, 1, 2, 3],
      "fps": 6,
      "loop": true
    },
    "walk": {
      "frames": [4, 5, 6, 7],
      "fps": 8,
      "loop": true
    },
    "attack": {
      "frames": [8, 9, 10, 11],
      "fps": 10,
      "loop": false
    }
  }
}
```

---

## 9.5 TileSet 生成模块

### 需求

生成可用于 2D 地图编辑器和游戏引擎的 TileSet。

### 支持主题

```text
草地
地牢
沙漠
雪地
森林
城镇
科幻基地
岩浆洞穴
海边
废墟
```

### 支持 Tile 类型

```text
地板
墙体
内角
外角
边缘
水体
道路
门
楼梯
裂缝
装饰物
宝箱
障碍物
```

### 输出

```text
tilesets/
  dungeon_tileset.png
  dungeon_tileset.json
  dungeon_tileset_preview.png
  dungeon_tileset.tmx
```

### 要求

1. 支持 16x16、32x32、64x64 tile。
2. Tile 间边缘尽量可拼接。
3. 支持输出 tileset.png。
4. 支持输出 tile metadata。
5. 支持输出 Tiled 可用文件。
6. 支持导出 Unity Tilemap 使用说明。
7. 支持生成拼接预览图。

---

## 9.6 图片后处理模块

### 需求

对 AI 生成结果进行游戏开发所需的自动化处理。

### 功能

| 功能 | 描述 | 优先级 |
|---|---|---|
| 透明背景处理 | 去除纯色或背景区域，生成 alpha 通道 | P0 |
| 自动裁切 | 裁切透明边缘 | P0 |
| 统一尺寸 | 将图片放入固定画布 | P0 |
| 像素对齐 | 防止像素风素材边缘模糊 | P1 |
| 锚点设置 | 设置角色或物体 pivot | P1 |
| 文件命名 | 生成规范文件名 | P0 |
| 图像压缩 | 减小输出体积 | P2 |
| 预览图生成 | 生成素材预览图 | P1 |

### 输出要求

所有输出 PNG 应满足：

```text
背景透明
尺寸统一
命名规范
可独立使用
可被打包进 atlas
```

---

## 9.7 Sprite Sheet 合成模块

### 需求

将多个序列帧合成为一张 Sprite Sheet，并生成对应 metadata。

### 输入

```text
knight_idle_0.png
knight_idle_1.png
knight_idle_2.png
knight_idle_3.png
```

### 输出

```text
knight_spritesheet.png
knight_spritesheet.json
```

### 要求

1. 支持按行排列。
2. 支持按动作分行。
3. 支持固定 frame width / height。
4. 支持生成 frame 坐标。
5. 支持生成动画信息。
6. 支持 Unity / Godot 通用 metadata。

---

## 9.8 Atlas 打包模块

### 需求

将多个 PNG 素材合成为 Texture Atlas。

### 输入

```text
icons/*.png
items/*.png
ui/*.png
```

### 输出

```text
game_assets_atlas.png
game_assets_atlas.json
```

### JSON 示例

```json
{
  "meta": {
    "image": "game_assets_atlas.png",
    "size": {
      "w": 1024,
      "h": 1024
    }
  },
  "frames": {
    "potion.png": {
      "frame": {
        "x": 0,
        "y": 0,
        "w": 32,
        "h": 32
      }
    },
    "sword.png": {
      "frame": {
        "x": 32,
        "y": 0,
        "w": 32,
        "h": 32
      }
    }
  }
}
```

### 要求

1. 支持自动布局。
2. 支持 padding。
3. 支持生成 atlas.png。
4. 支持生成 atlas.json。
5. 支持 Phaser / PixiJS 风格 JSON。
6. 支持通用 JSON 格式。

---

## 9.9 导出模块

### 需求

将素材导出为主流 2D 游戏开发流程可用资源。

### 导出目录结构

```text
exports/
  unity/
    sprites/
    sheets/
    atlas/
    unity_import_guide.md
    sprites_metadata.json

  godot/
    sprites/
    sheets/
    atlas/
    godot_import_guide.md
    spriteframes.json

  tiled/
    tilesets/
    dungeon_tileset.png
    dungeon_tileset.json
    dungeon_tileset.tmx

  common/
    icons/
    sprites/
    atlas.png
    atlas.json
```

### Unity 导出

导出内容：

```text
PNG 文件
Sprite Sheet
Atlas
JSON metadata
Unity 导入说明
```

说明内容应包括：

```text
如何将 PNG 导入 Unity
如何设置 Sprite Mode
如何切分 Sprite Sheet
如何设置 Pixels Per Unit
如何使用 Sprite Atlas
如何使用 Tilemap
```

### Godot 导出

导出内容：

```text
PNG 文件
Sprite Sheet
SpriteFrames JSON
Godot 导入说明
```

说明内容应包括：

```text
如何导入 PNG
如何使用 AnimatedSprite2D
如何创建 SpriteFrames
如何配置 TileSet
如何使用 TileMapLayer
```

### Tiled 导出

导出内容：

```text
tileset.png
tileset.json
tileset.tmx
```

说明内容应包括：

```text
如何在 Tiled 中打开 tileset
如何创建 tile map
如何设置 tile size
如何导出地图
```

---

# 10. 非功能需求

## 10.1 性能要求

| 项目 | 要求 |
|---|---|
| 软件启动时间 | 小于 5 秒 |
| 单张图标后处理 | 小于 2 秒 |
| 30 个图标 atlas 打包 | 小于 10 秒 |
| Sprite Sheet 合成 | 小于 5 秒 |
| ZIP 打包 | 小于 10 秒 |
| 本地项目加载 | 小于 3 秒 |

AI 生成时间取决于外部 API，不作为本地性能硬指标，但需要显示进度状态。

## 10.2 易用性要求

1. 用户不需要懂复杂 Prompt。
2. 主要操作应通过表单完成。
3. 每个素材类型提供默认参数。
4. 支持一键生成。
5. 支持一键导出。
6. 错误提示应清晰。
7. 输出目录应可直接打开。

## 10.3 稳定性要求

1. 生成失败时不应导致软件崩溃。
2. 本地文件写入失败应提示原因。
3. API Key 错误应提示用户检查配置。
4. 批量生成中断后应保留已完成结果。
5. 导出失败应保留中间文件。

## 10.4 可维护性要求

1. 生成模块、后处理模块、导出模块应解耦。
2. 不同导出目标应使用独立 exporter。
3. 图片处理能力应封装为 service。
4. 生成历史应结构化保存。
5. 后续可扩展新模型和新引擎格式。

---

# 11. 技术方案

## 11.1 推荐技术栈

```text
Electron
React
TypeScript
TailwindCSS
shadcn/ui
Node.js
Sharp
JSZip
SQLite 或本地 JSON
```

## 11.2 技术架构

```text
Electron 主进程
  ├── 文件系统管理
  ├── 图片处理服务
  ├── 导出服务
  ├── ZIP 打包服务
  └── API Key 本地配置

React 渲染进程
  ├── 项目首页
  ├── 项目配置页
  ├── 素材生成页
  ├── 素材预览页
  ├── 风格管理页
  ├── 导出页
  └── 设置页

服务层
  ├── AIGenerationService
  ├── ImageProcessingService
  ├── SpriteSheetService
  ├── AtlasPackingService
  ├── TileSetService
  ├── ExportService
  └── HistoryService
```

## 11.3 模块划分

```text
src/
  main/
    main.ts
    preload.ts
    services/
      fileService.ts
      imageService.ts
      exportService.ts
      zipService.ts
      aiService.ts

  renderer/
    App.tsx
    pages/
      HomePage.tsx
      ProjectPage.tsx
      GeneratePage.tsx
      PreviewPage.tsx
      StylePage.tsx
      ExportPage.tsx
      SettingsPage.tsx

    components/
      AssetCard.tsx
      GenerationForm.tsx
      SpritePreview.tsx
      AtlasPreview.tsx
      TileSetPreview.tsx

    stores/
      projectStore.ts
      assetStore.ts
      settingsStore.ts

  shared/
    types/
      project.ts
      asset.ts
      export.ts
      generation.ts
```

---

# 12. 数据结构设计

## 12.1 Asset 数据结构

```ts
export interface Asset {
  id: string;
  name: string;
  type: "character" | "enemy" | "icon" | "item" | "ui" | "tileset" | "background" | "effect";
  description: string;
  style: string;
  size: {
    width: number;
    height: number;
  };
  files: string[];
  metadataPath?: string;
  createdAt: string;
  updatedAt: string;
}
```

## 12.2 Animation 数据结构

```ts
export interface AnimationConfig {
  name: string;
  frames: number;
  fps: number;
  loop: boolean;
}
```

## 12.3 Project 数据结构

```ts
export interface Project {
  id: string;
  name: string;
  path: string;
  gameType: string;
  style: string;
  defaultResolution: string;
  exportTargets: string[];
  assets: Asset[];
  createdAt: string;
  updatedAt: string;
}
```

## 12.4 ExportTarget 数据结构

```ts
export type ExportTarget = "unity" | "godot" | "tiled" | "phaser" | "cocos" | "common";
```

---

# 13. AI 生成策略

## 13.1 Prompt 生成原则

用户不需要自己写复杂 Prompt，系统根据表单自动拼接 Prompt。

### 用户输入

```text
角色名称：骑士
风格：像素风
尺寸：64x64
动作：walk
```

### 系统内部 Prompt

```text
Create a 64x64 side-view 16-bit pixel art game character sprite of a silver armor knight holding a short sword.
Transparent background.
Consistent proportions.
Clean silhouette.
Game-ready sprite.
Animation frame for walk cycle.
```

## 13.2 风格一致性策略

1. 项目级风格描述。
2. 固定 seed。
3. 参考图上传。
4. 色板提取。
5. 统一尺寸。
6. 统一视角。
7. 统一光照方向。
8. 保存每次生成 Prompt。
9. 对同一角色的不同动作复用角色描述。
10. 允许单帧重新生成。

## 13.3 成本控制策略

1. 默认低分辨率生成。
2. 支持草稿模式。
3. 支持只重新生成失败帧。
4. 批量任务分组执行。
5. 本地缓存生成结果。
6. 不重复生成已经确认的素材。
7. 支持用户手动选择需要导出的素材。

---

# 14. 输出文件规范

## 14.1 文件命名规范

```text
{assetType}_{assetName}_{action}_{index}.png
```

示例：

```text
character_knight_idle_00.png
character_knight_idle_01.png
character_knight_walk_00.png
item_potion_red.png
icon_fireball.png
tileset_dungeon_32.png
```

## 14.2 目录规范

```text
project_root/
  project.json

  generated/
    raw/
    processed/

  sprites/
    characters/
    enemies/

  icons/
    items/
    skills/
    ui/

  tilesets/

  sheets/

  atlas/

  exports/

  history/
```

## 14.3 metadata 规范

每个素材包应至少包含：

```json
{
  "name": "knight",
  "type": "character",
  "style": "16-bit pixel art",
  "size": {
    "width": 64,
    "height": 64
  },
  "files": [],
  "animations": {},
  "createdAt": "",
  "prompt": "",
  "exportTargets": []
}
```

---

# 15. 验收标准

## 15.1 基础验收

项目应满足以下条件：

1. 软件可以本地运行。
2. 用户可以创建本地项目。
3. 用户可以配置项目风格。
4. 用户可以输入文本或简单参数生成素材。
5. 用户可以生成至少一种图标 / 道具素材。
6. 用户可以生成角色 Sprite Sheet。
7. 用户可以生成基础 TileSet。
8. 系统可以自动处理透明背景。
9. 系统可以自动统一尺寸。
10. 系统可以自动合成 Sprite Sheet。
11. 系统可以自动生成 Atlas。
12. 系统可以生成 JSON metadata。
13. 系统可以导出完整资源包。
14. 系统可以生成 Unity / Godot / Tiled 导入说明。
15. 系统可以保存历史生成记录。

## 15.2 演示验收

最终演示建议包含三个场景：

### 演示一：批量图标生成

输入一句话，批量生成 20 个 RPG 道具图标，并导出 atlas。

验收结果：

```text
生成 20 个图标 PNG
生成 icons_atlas.png
生成 icons_atlas.json
可以打开导出目录
```

### 演示二：角色 Sprite Sheet 生成

输入角色描述，生成 idle / walk / attack 动作帧。

验收结果：

```text
生成角色序列帧
生成 knight_spritesheet.png
生成 knight_spritesheet.json
可以播放动画预览
```

### 演示三：TileSet 生成

输入地牢风格，生成 32x32 TileSet。

验收结果：

```text
生成 dungeon_tileset.png
生成 dungeon_tileset.json
生成 dungeon_tileset.tmx
可以查看拼接预览
```

---

# 16. 优先级规划

## 16.1 P0 必须完成

```text
本地项目创建
项目配置保存
素材生成表单
AI API 调用
PNG 文件保存
透明背景处理
统一尺寸
图标批量生成
角色序列帧生成
Sprite Sheet 合成
JSON metadata 生成
导出 ZIP
通用 PNG + JSON 导出
基础历史记录
```

## 16.2 P1 推荐完成

```text
Atlas 打包
TileSet 生成
Tiled 导出
Unity 导入说明
Godot 导入说明
动画预览
风格模板
单帧重新生成
最近项目列表
```

## 16.3 P2 后续增强

```text
参考图上传
色板提取
Unity 插件
Godot 插件
Aseprite 导出
Tile 边缘自动检测
局部重绘
高级风格一致性评分
素材质量自动评分
```

---

# 17. 里程碑计划

## 第一阶段：基础桌面应用

目标：

```text
完成 Electron 应用框架
完成项目创建和配置
完成设置页面
完成本地文件读写
```

交付：

```text
可启动桌面应用
可创建本地项目
可保存 project.json
```

## 第二阶段：AI 生成与图片保存

目标：

```text
接入 AI 图像生成 API
完成图标 / 道具生成
完成生成结果保存
```

交付：

```text
可输入文本生成 PNG
可保存生成历史
```

## 第三阶段：图片后处理

目标：

```text
完成透明背景
完成裁切
完成统一尺寸
完成命名规范
```

交付：

```text
生成结果可用于游戏工程
```

## 第四阶段：Sprite Sheet 与 Atlas

目标：

```text
完成角色序列帧生成
完成 Sprite Sheet 合成
完成 Atlas 打包
完成 JSON metadata
```

交付：

```text
可生成角色动画资源包
可生成图标图集资源包
```

## 第五阶段：TileSet 与导出

目标：

```text
完成 TileSet 生成
完成 Tiled 导出
完成 Unity / Godot 导入说明
完成 ZIP 导出
```

交付：

```text
完整游戏素材资源包
```

---

# 18. 风险与解决方案

## 18.1 AI 生成风格不一致

风险：

```text
同一项目内多次生成结果风格差异较大。
```

解决方案：

```text
使用项目级风格描述
保存风格模板
固定 seed
支持参考图
支持色板提取
同一角色动作复用基础描述
允许单帧重新生成
```

## 18.2 角色动作帧不连续

风险：

```text
AI 生成的不同动作帧可能角色比例变化较大。
```

解决方案：

```text
先生成基础角色图
再基于基础角色生成动作
限制动作数量和帧数
允许用户替换不满意帧
提供动画预览
```

## 18.3 TileSet 无法无缝拼接

风险：

```text
AI 生成 tile 边缘不连续。
```

解决方案：

```text
第一版只生成基础可用 TileSet
提供拼接预览
增加边缘重复检测
后续支持规则 Tile 模板
```

## 18.4 API 成本高

风险：

```text
批量生成素材时 API 调用成本较高。
```

解决方案：

```text
默认草稿模式
只重新生成失败素材
缓存已生成结果
允许用户控制生成数量
支持本地后处理复用
```

## 18.5 导出格式复杂

风险：

```text
不同引擎格式差异较大。
```

解决方案：

```text
第一版优先输出通用 PNG + JSON
Unity / Godot / Tiled 先提供导入说明
后续再增强原生插件或工程文件
```

---

# 19. 最终交付物

项目最终应提交：

```text
1. 一个可运行的本地桌面应用
2. 源代码
3. README.md
4. PRD 文档
5. 技术设计文档
6. 示例素材项目
7. 示例导出资源包
8. 演示截图
9. 演示视频
10. 使用说明
```

---

# 20. README 建议结构

```text
# Topspeed Builder

## 项目简介

## 功能特性

## 技术栈

## 安装方式

## 开发运行

## 打包应用

## 使用流程

## 导出格式说明

## 示例素材

## 常见问题
```

---


# 21. 一句话结论

本项目最终应做成：

```text
本地桌面端 AI 2D 游戏素材工程化生成工具
```

而不是普通 AI 生图网站。

最小但完整的最终版本应包含：

```text
Electron 桌面应用
+ 文本 / 参数输入
+ 图标批量生成
+ 角色 Sprite Sheet 生成
+ TileSet 生成
+ 本地透明背景 / 裁切 / 尺寸统一
+ Atlas / JSON metadata 生成
+ Unity / Godot / Tiled 导出
+ ZIP 下载
```

核心价值在于：

```text
把 AI 生成结果从“好看的图片”变成“游戏开发者能直接使用的工程素材包”。
```
