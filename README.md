# Map Card

基于 [Leaflet](https://leafletjs.com/) 的 Home Assistant 地图卡片，支持实体位置、轨迹历史、WMS/GeoJSON 图层、自定义瓦片等，默认底图为 CARTO Voyager（亮）/ dark_all（暗）并自动跟随 HA 主题切换。

---

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [YAML 配置参考](#yaml-配置参考)
  - [顶层配置](#1-顶层配置)
  - [底图配置](#2-底图配置)
  - [实体配置 entities](#3-实体配置-entities)
  - [圆 circle](#4-圆-circle)
  - [GeoJSON geojson](#5-geojson-geojson)
  - [WMS 图层 wms](#6-wms-图层-wms)
  - [GeoJSON 图层 geojson](#7-geojson-图层-geojson)
  - [额外瓦片 tile_layers](#8-额外瓦片-tile_layers)
  - [插件 plugins](#9-插件-plugins)
- [可视化编辑面板](#可视化编辑面板)
- [修改说明](#修改说明)

---

## 安装

1. 把 `map-card.js` 放到 HA 的 `www/community/map-card/` 目录（HACS 安装）或 `www/map-card.js`（手动）。
2. 在 Lovelace 资源里添加：

```yaml
url: /community/map-card/map-card.js
type: module
```

3. 刷新 Lovelace。

---

## 快速开始

最简配置（必须至少有一个定位实体）：

```yaml
type: custom:map-card
title: 我的位置
carto_api_key: "你的CARTO_API_KEY"
entities:
  - device_tracker.my_phone
```

指定坐标 + 缩放 + 主题：

```yaml
type: custom:map-card
title: 家
x: 31.2304
y: 121.4737
zoom: 15
theme_mode: auto
carto_api_key: "你的CARTO_API_KEY"
```

显示历史轨迹：

```yaml
type: custom:map-card
title: 车辆轨迹
carto_api_key: "你的CARTO_API_KEY"
history_start: "24 hours ago"
entities:
  - entity: device_tracker.car_tracker
    history_line_color: "#ff0000"
```

---

## YAML 配置参考

### 1. 顶层配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `title` | string | - | 卡片标题 |
| `focus_entity` | string | - | 卡片加载后自动聚焦到该实体（`device_tracker.xxx` 或 `zone.xxx`） |
| `x` | number | - | 地图初始中心纬度。未设时由实体位置自动计算 |
| `y` | number | - | 地图初始中心经度 |
| `zoom` | number | `12` | 初始缩放级别（1–19） |
| `card_size` | number | `5` | 卡片高度（5 = 约 270px，每单位 +50px） |
| `theme_mode` | `auto` / `light` / `dark` | `auto` | 底图主题。`auto` 跟随 HA 主题（`hass.themes.darkMode`） |
| `cluster_markers` | boolean | `false` | 是否聚合标记 |
| `history_start` | string | - | 全局历史起点，如 `"24 hours ago"`、`"-7d"`、`"now - 2 hours"` |
| `history_end` | string | `"now"` | 全局历史终点 |
| `history_date_selection` | boolean | `false` | 启用日期范围选择器（覆盖 history_start/end） |
| `focus_follow` | `refocus` / `contains` / `none` | `none` | 平移地图后自动重新聚焦方式 |
| `focus_follow_pause` | number | `0` | 暂停秒数（`focus_follow` 生效） |
| `debug` | boolean | `false` | 开启控制台调试日志 |
| `map_options` | object | `{}` | Leaflet [Map options](https://leafletjs.com/reference.html#map-option)，如 `{ crs: simple }` |

---

### 2. 底图配置

默认底图是 CARTO Voyager（亮）和 CARTO dark_all（暗），`theme_mode: auto` 时自动切换。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `carto_api_key` | string | - | **通用 CARTO API Key**，亮/暗底图共用（推荐只配这一项） |
| `carto_api_key_light` | string | `carto_api_key` | 亮色底图专用 key，覆盖通用 key |
| `carto_api_key_dark` | string | `carto_api_key` | 暗色底图专用 key，覆盖通用 key |
| `tile_layer_url` | string | CARTO Voyager | **亮色底图完整 URL**，配置后覆盖 CARTO 默认 |
| `tile_layer_url_dark` | string | CARTO dark_all | **暗色底图完整 URL**。设为 `null` 禁用暗色底图 |
| `tile_layer_options` | object | `{}` | 传给 Leaflet TileLayer 的 options（如 `subdomains`、`minZoom`） |
| `tile_layer_attribution` | string | `OpenStreetMap contributors © CARTO` | 右下角 attribution 文本 |

**CARTO 申请 key**：<https://carto.com/> — 新建 account 后在 "Your API keys" 页面获取。同一账号的 key 可同时用于亮/暗底图。

```yaml
type: custom:map-card
carto_api_key: "carto_public_key_xxxxx"
```

完全自定义底图：

```yaml
tile_layer_url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
tile_layer_url_dark: null     # 禁用暗色底图，始终用亮色
```

---

### 3. 实体配置 `entities`

可以是简单字符串，也可以是完整对象。

```yaml
entities:
  - device_tracker.phone         # 简写
  - zone.home                     # zone 实体
  - person.alice                  # person 实体
  - entity: device_tracker.car    # 完整对象
    display: pill
    color: "#ff0000"
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `entity` | string | - | 实体 ID（简写时不需要这个 key） |
| `display` | `marker` / `pill` / `attribute` | `marker` | 标记样式 |
| `attribute` | string | - | 当 `display: attribute` 时显示的属性名 |
| `prefix` | string | - | attribute 显示前缀 |
| `suffix` | string | - | attribute 显示后缀 |
| `label` | string | - | 自定义 tooltip 标签 |
| `size` | number | `48` | 标记像素大小 |
| `color` | string | 自动生成 | 标记颜色，如 `"#ff0000"` 或 `hsl(200,95%,35%)` |
| `picture` | string | - | 用户头像 URL（person 实体可自动取 `entity_picture`） |
| `icon` | string | - | 自定义图标（`mdi:car` 等） |
| `css` | string | `"text-align:center;font-size:60%"` | 自定义 pill/attribute 样式 |
| `gradual_opacity` | boolean | `false` | 历史轨迹渐隐 |
| `history_start` | string | 继承顶层 | 该实体的历史起点，覆盖全局 |
| `history_end` | string | 继承顶层 | 该实体的历史终点 |
| `history_line_color` | string | 同 `color` | 轨迹线颜色 |
| `history_show_dots` | boolean | `true` | 显示轨迹点 |
| `history_show_lines` | boolean | `true` | 显示轨迹线 |
| `fixed_x` / `fixed_y` | number | - | 固定坐标（忽略实体真实位置） |
| `fallback_x` / `fallback_y` | number | - | 实体位置缺失时的备用坐标 |
| `tap_action` | object | `more-info` | 点击标记行为，支持 `more-info`、`none`、`navigate`、`url`、`call-service`（同 HA card 通用格式） |
| `focus_on_fit` | boolean | `true` | fit bounds 时是否包含此实体 |
| `z_index_offset` | number | `1` | z-index 偏移 |
| `use_base_entity_only` | boolean | `false` | 历史查询只取 base entity |
| `position_update_threshold` | number | `10` | 位置更新阈值（米） |
| `pill_callout_min_zoom` | number | `15` | pill 标记显示偏移标注线的最小缩放 |
| `circle` | `"auto"` 或 object | - | 见 [圆 circle](#4-圆-circle) |
| `geojson` | string / object | - | 见 [GeoJSON geojson](#5-geojson-geojson) |
| `distance_entity` | string | - | 用于 tooltip 显示距离的实体 ID |
| `distance_unit` | `auto` / `km` / `mi` | `auto` | 距离单位 |

---

### 4. 圆 `circle`

在实体标记外画一个圆（常用来显示 GPS 精度）。

```yaml
circle: auto                       # 自动读取 device_tracker 的 gps_accuracy
circle:
  source: attribute
  attribute: gps_accuracy
circle:
  radius: 100                      # 固定半径（米）
  color: "#3388ff"
  fill_opacity: 0.2
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `radius` | number | `0` | 圆半径（米）。`0` 表示不画圆 |
| `source` | `auto` / `config` / `attribute` | - | 半径来源，`auto` = 自动识别 |
| `attribute` | string | - | 从实体属性读半径 |
| `color` | string | 同实体 color | 圆描边颜色 |
| `fill_opacity` | number | `0.1` | 填充透明度（0–1） |

---

### 5. GeoJSON `geojson`

从实体属性读取 GeoJSON 数据，在地图上渲染（常用于区域覆盖、路径线）。

```yaml
geojson: geo_location              # 简写：只指定属性名
geojson:
  attribute: geo_location
  color: "#ff0000"
  weight: 3
  opacity: 1.0
  fill_opacity: 0.2
  hide_marker: false               # 是否隐藏位置标记，只显示 GeoJSON
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `attribute` | string | `geo_location` | 包含 GeoJSON 的实体属性路径（支持点号和数组访问） |
| `color` | string | 同实体 color | 线/边颜色 |
| `weight` | number | `3` | 线宽 |
| `opacity` | number | `1.0` | 线透明度（0–1） |
| `fill_opacity` | number | `0.2` | 填充透明度（0–1） |
| `hide_marker` | boolean | `false` | 隐藏该实体的位置标记，只显示 GeoJSON |

---

### 6. WMS 图层 `wms`

叠加 WMS 服务图层。

```yaml
wms:
  - url: https://example.com/geoserver/wms
    options:
      layers: your_layer
      format: image/png
      transparent: true
      attribution: "© Example"
    history: dateTime   # 或对象格式
```

`wms` 下的每个元素继承 [LayerConfig](#layerconfig-字段) 的所有字段。

---

### 7. GeoJSON 图层 `geojson`

注意：这是**顶层** `geojson` 字段，渲染独立 GeoJSON 图层（区别于实体级别的 `geojson`）。

```yaml
geojson:
  - entity: sensor.my_area
    attribute: zones
    color: "#3388ff"
    width: 3
    fill_color: "#3388ff"
    fill_opacity: 0.2
    opacity: 1.0
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `entity` | string | **必填** | 包含 GeoJSON 的实体 ID |
| `attribute` | string | `null` | 从实体哪个属性读 GeoJSON；不填读实体 state |
| `color` | string | `#3388ff` | 线/边颜色 |
| `width` | number | `3` | 线宽 |
| `fill_color` | string | 同 `color` | 多边形填充颜色 |
| `fill_opacity` | number | `0.2` | 填充透明度 |
| `opacity` | number | `1.0` | 整体透明度 |

---

### 8. 额外瓦片 `tile_layers`

叠加额外的瓦片图层（在底图之上）。

```yaml
tile_layers:
  - url: https://tile.example.com/{z}/{x}/{y}.png
    options:
      attribution: "© Example"
      minZoom: 0
      maxZoom: 19
    history: now
```

---

### 9. 插件 `plugins`

通过 HACS 或 URL 加载自定义插件。

```yaml
plugins:
  - hacs:
      module: map-card-extra
      file: dist/map-card-extra.js
    name: "extra-plugin"
    options:
      foo: bar
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `hacs` | object | - | HACS 集成信息，`{ module, file }` |
| `url` | string | - | 直接 URL |
| `name` | string | - | 插件名 |
| `options` | object | `{}` | 传给插件的选项 |

---

### LayerConfig 字段（wms / tile_layers 共用）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | string | **必填** | WMS/TMS URL |
| `options` | object | `{}` | Leaflet TileLayer/TileLayer.WMS options，含 `attribution`、`subdomains`、`minZoom`、`maxZoom`、`referrerPolicy` 等 |
| `history` | string / object | - | 历史图层时间点。字符串如 `"dateTime"`；对象见下表 |

`history` 对象格式：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `property` | string | - | 要替换到 URL 里的属性名 |
| `source` | string | `auto` | 从哪个实体读时间值 |
| `suffix` | string | - | 读实体时间时的后缀 |
| `force_midnight` | boolean | `false` | 强制取午夜时间 |

---

## 可视化编辑面板

本卡片内置了基于 `HTMLElement`（非文件内 LitElement，避免版本冲突）的编辑器 `MapCardEditor`，支持：

- **标题** — `title`
- **实体列表** — 多行 picker，支持增删、自动过滤含定位的域（`device_tracker / zone / person / sensor / air_quality / camera / sun`）
- **主题模式** — radio（自动 / 浅色 / 深色）
- **CARTO API Key** — `carto_api_key`
- **缩放级别** — `zoom`
- **历史起点** — `history_start`

点击 HA 卡片编辑 → "配置" 即可看到可视化表单。在编辑器里未选择的空实体行会自动从 YAML 中清除。

> **硬刷新**：HA 强缓存自定义卡片 JS，修改 `map-card.js` 后需要 F12 → Network → Disable cache → Ctrl+Shift+R。

---

## 修改说明

本项目在原始 [nathan-gs/ha-map-card](https://github.com/nathan-gs/ha-map-card) 基础上做了以下改动：

1. **默认底图改为 CARTO 明/暗双底图**
   - 亮色：CARTO Voyager `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png`
   - 暗色：CARTO dark_all `https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`
   - `{r}` 由 Leaflet 自动处理 Retina 屏

2. **根据 HA 主题自动切换明/暗底图**
   - 卡片初始化时读 `hass.themes.darkMode`（`theme_mode: auto` 时）
   - 主题变化时通过 `setUrl()` 实时切换瓦片，不重建地图

3. **关闭旧的 CSS 反相滤镜**
   - 暗色模式不再靠 `invert/hue-rotate` 反相，改用原生暗色瓦片

4. **新增底图相关 YAML 配置**
   - `carto_api_key` / `carto_api_key_light` / `carto_api_key_dark`
   - `tile_layer_url_dark`（可设 `null` 禁用暗色底图）
   - `tile_layer_options` / `tile_layer_attribution`

5. **内置 Lovelace 可视化编辑器**
   - `MapCardEditor extends HTMLElement`（避免与文件内打包 Lit 冲突）
   - 自动过滤含定位的实体域
   - 空实体自动清理

### 相关代码位置

- `MapConfig` 构造函数：底图默认 URL、CARTO key 注入、`tileLayerDark` 配置
- `MapCard._setupMap()`：建图时按主题选底图
- `MapCard._syncBasemapTheme()`：主题切换时实时换图
- `MapCard` 静态 `styles`：暗色 CSS 滤镜关闭
- `MapCardEditor`：可视化编辑面板（`HTMLElement` + `innerHTML` + `addEventListener`）
- `customElements.define("map-card-editor", MapCardEditor)`：注册编辑器

### YAML 示例集合

最常用的几种写法：

```yaml
# 最简
type: custom:map-card
carto_api_key: "xxx"
entities:
  - device_tracker.phone

# 多实体 + 历史轨迹
type: custom:map-card
title: 车辆跟踪
carto_api_key: "xxx"
history_start: "24 hours ago"
entities:
  - entity: device_tracker.car_1
    color: "#ff6600"
    history_line_color: "#ff6600"
  - entity: device_tracker.car_2
    color: "#0066ff"

# 自定义底图（不走 CARTO）
type: custom:map-card
tile_layer_url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
tile_layer_url_dark: null
tile_layer_attribution: "© OpenStreetMap contributors"
entities:
  - zone.home

# 带圆 + GeoJSON
type: custom:map-card
carto_api_key: "xxx"
entities:
  - entity: device_tracker.phone
    circle: auto                              # 显示 GPS 精度圆
    geojson: geo_location                     # 显示 GeoJSON 区域
```
