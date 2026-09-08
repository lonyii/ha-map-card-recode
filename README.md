# Map Card

基于 [leaflet](https://leafletjs.com/) 的 Home Assistant 地图卡片，支持实体位置、轨迹历史、WMS/GeoJSON 图层等。

## 修改说明

本次修改主要调整了**底图来源与主题适配**，使地图随 Home Assistant 主题自动切换明/暗底图。

### 改动内容

1. **默认底图改为 CARTO 明/暗双底图**

   - 亮色（light）：`https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=your_key`
   - 暗色（dark）：`https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=your_key`

   原 OpenStreetMap 单一底图被替换为上述成对的 CARTO 瓦片。`{r}` 由 Leaflet 自动处理（Retina 屏取 `@2x`）。

2. **根据 HA 主题自动选择明/暗地图**

   - 卡片初始化时根据 `_isDarkMode()`（`theme_mode: auto` 时读取 `hass.themes.darkMode`）选用亮色或暗色瓦片。
   - 主题切换时通过 `_syncBasemapTheme()` 实时切换瓦片 URL（`setUrl`），无需重建地图，底图始终位于 WMS/GeoJSON 等叠加层之下。

3. **关闭旧的暗色 CSS 反相滤镜**

   原暗色模式靠 `invert/hue-rotate` 滤镜把亮色瓦片反相成暗色；现改用原生暗色瓦片，`#map.dark` 的 `--map-filter` 设为 `invert(0)`，避免暗色瓦片被二次反相。

4. **新增配置项 `tile_layer_url_dark`**

   可单独指定暗色底图 URL；设为 `null` 可禁用暗色底图，始终使用亮色底图。

### 相关代码位置

- `MapConfig` 构造函数：底图默认 URL 与 `tileLayerDark` 配置
- `MapCard._setupMap()`：建图时按主题选底图
- `MapCard._syncBasemapTheme()`：主题切换时实时换图
- `MapCard` 静态 `styles`：暗色 CSS 滤镜调整

### 可选配置示例

```yaml
type: custom:map-card
# 使用默认 CARTO 明/暗底图，无需任何额外配置即可跟随主题。

# 如需自定义：
# tile_layer_url: <亮色底图 URL>
# tile_layer_url_dark: <暗色底图 URL，设为 null 禁用>
# tile_layer_attribution: <attribution 文本>
# theme_mode: auto   # auto / dark / light
```
