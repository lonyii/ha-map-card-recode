/* =============================================================================
 *  AMap Location Card  —  Home Assistant 自定义 Lovelace 卡片
 *  高德地图定位卡片：实体定位 + WGS84→GCJ02 转换 + 周边检索（充电桩 / 公厕）
 * -----------------------------------------------------------------------------
 *  设计要点
 *   · 单文件 ES Module，零构建依赖（HACS / www 目录直接可用）
 *   · 坐标转换强制走高德 Web 服务 /v3/assistant/coordinate/convert (coordsys=gps)
 *   · 所有高德请求统一走「节流 + 去重 + TTL 缓存」，避免超限
 *   · 全链路降级：Web 服务失败 → JS API 插件 → 原始坐标（并给出提示，绝不炸卡）
 *   · 地图渲染失败 / 无 WebGL（iOS Safari 常见）→ 自动切换简化视图，功能不丢
 *   · 「自动搜索范围」= 浏览者屏幕上的可视矩形（随容器尺寸 / 缩放自适应）。
 *     高德周边检索只支持圆形：先按「中心→最远角」的外接半径去搜，再把落在矩形外的
 *     结果裁掉 —— 合起来等价于一次矩形范围检索，屏幕里一条不漏、屏幕外一条不显示
 *   · 搜索范围圈默认不画（show_radius_circle=false）：范围就是整张地图，画圈只是噪音
 *   · fixed 模式（用户显式指定半径）不做裁剪，仍有 _checkPinsVisible / _fitAllPins 兜底
 *   · iPhone Safari：touch-action 手势治理、固定 px 高度、WebGL 探测、点击兜底
 * ============================================================================= */

const ALC_VERSION = '1.0.4';
const ALC_CARD_TAG = 'amap-location-card';
const ALC_EDITOR_TAG = 'amap-location-card-editor';

const AMAP_REST_BASE = 'https://restapi.amap.com';
const AMAP_JS_API_BASE = 'https://webapi.amap.com/maps';
const AMAP_JS_API_HOST = 'webapi.amap.com';
const AMAP_JS_VERSION = '2.0';

/**
 * 坐标转换接口返回值的最大容许偏移（度）。
 * 实测：境内 GCJ-02 偏移量 < 0.01°，境外坐标高德原样返回（偏移 0）。
 * 取 0.05° 做护栏 —— 明显错乱的返回会被拦下，正常（含境外）结果不会误伤。
 */
const ALC_GCJ_MAX_SHIFT = 0.05;

/* =============================================================================
 *  1. 默认配置
 * ============================================================================= */

const ALC_DEFAULTS = {
  /* 基础 */
  entity: '',
  title: '',
  height: 320,
  /* 铺满浏览器窗口：地图自动撑满可视区域（配置编辑器里的预览不铺满）。
     关掉后回到固定高度 height。 */
  fill_viewport: true,

  /* 高德 Key —— 只需要一个：同一个 Key 同时用于坐标转换、周边检索与地图底图 */
  amap_key: '',
  amap_js_key: '',                // 高级：仅当想把底图 Key 与 Web 服务 Key 分开时才填
  security_js_code: '',           // 高级：仅当 JS API 报 INVALID_USER_SCODE 时才需要

  /* 实体坐标所属坐标系。
   *   wgs84（默认）= GPS / HA Companion 等原始坐标，必须走高德转换，否则高德底图上会整体偏移约 300~600 米；
   *   gcj02        = 实体坐标本来就来自高德/腾讯等国内服务，再转换会二次偏移 —— 直接当高德坐标用。 */
  coord_sys: 'wgs84',

  /* 地图视图 */
  view_mode: 'follow',            // follow | locked
  follow_zoom: 16,
  locked_center: '',              // "经度,纬度"
  locked_zoom: 15,
  map_style: 'amap://styles/normal',
  gesture: 'map',                 // map（地图吃掉手势）| scroll（纵向滚动优先）
  show_source_marker: true,
  // 高德 JS 底图渲染不出来时（iOS App 内嵌 WKWebView 常见）自动切「瓦片底图」：
  // 同一套高德栅格瓦片，绕过 JS API 直接画到 canvas，永不见白板。
  fallback_tiles: true,
  // 搜索范围圈默认不画：检索范围就是整张地图的可视区域，画圈只是多一层视觉噪音
  show_radius_circle: false,
  show_scale: true,
  show_toolbar: true,

  /* 周边检索 */
  radius_mode: 'auto',            // auto（跟随地图当前缩放 / 可视范围）| fixed（固定半径）
  radius: 2000,                   // fixed 模式下的固定半径（米）
  // 自动半径的取法：
  //   cover（默认）= 中心→最远角（外接圆）。检索覆盖整个可视矩形 —— 视口里能看到的
  //                  每一个 POI 都在检索范围内，不会出现「地图上明明有、列表里没有」。
  //   visible      = 中心→最近边（内切圆）。只搜画面中间的一块，四角方向不覆盖。
  // 两种取法下，auto 模式都会把落在视口外的结果剔除（见 _fetchPois），
  // 所以地图上只会出现看得见的点，不需要「铺满显示」兜底。
  auto_radius_basis: 'cover',
  auto_radius_pad: 1,             // 自动半径系数：1 = 恰好贴到可视边缘
  auto_radius_max: 5000,          // 自动半径上限（米），避免缩得很远时把检索范围撑爆
  show_charging: true,
  show_charging_price: true,
  show_charging_available: true,
  charging_type: '011100',
  show_toilet: true,
  toilet_type: '140306',
  max_poi: 20,

  /* 图标 */
  icon_entity: 'mdi:crosshairs-gps',
  icon_charging: 'mdi:ev-station',
  icon_toilet: 'mdi:human-male-female',
  icon_size: 34,

  /* 交互 */
  click_action: 'popup',          // popup（弹窗）| navigate（直接唤起导航）
  show_list: false,
  open_in_new_tab: true,          // true = window.open 保留 HA 面板；false = 当前页跳转

  /* 性能与容错 */
  coord_cache_ttl: 300,           // 坐标转换缓存（秒）
  poi_cache_ttl: 300,             // 周边检索缓存（秒）
  api_min_interval: 400,          // 两次高德请求最小间隔（毫秒）
  refresh_interval: 60,           // 实体移动时的最小刷新间隔（秒）
  show_debug: false,

  /* 电价 / 桩数 字段映射（留空使用内置候选，逗号分隔，支持 biz_ext.xxx 与顶层 xxx） */
  price_fields: '',
  available_fields: '',
  total_fields: '',
};

/* 高德 POI 不保证返回电价与空闲桩数，这里给一组候选字段名逐个探测（可在配置里覆盖） */
const ALC_PRICE_FIELD_CANDIDATES = [
  'biz_ext.charge_price', 'biz_ext.chargeprice', 'biz_ext.charging_price',
  'biz_ext.electricity_price', 'biz_ext.elec_price', 'biz_ext.ele_price',
  'biz_ext.power_price', 'biz_ext.unit_price', 'biz_ext.price', 'biz_ext.fee',
  'biz_ext.cost', 'charge_price', 'electricity_price', 'price',
];
const ALC_AVAILABLE_FIELD_CANDIDATES = [
  'biz_ext.available', 'biz_ext.surplus', 'biz_ext.free', 'biz_ext.idle',
  'biz_ext.available_num', 'biz_ext.available_count', 'biz_ext.usable',
  'biz_ext.can_use', 'biz_ext.free_gun', 'biz_ext.idle_gun', 'biz_ext.vacant',
  'biz_ext.surplus_num', 'biz_ext.free_num', 'biz_ext.remain', 'available', 'surplus',
];
const ALC_TOTAL_FIELD_CANDIDATES = [
  'biz_ext.total', 'biz_ext.total_num', 'biz_ext.count', 'biz_ext.gun_num',
  'biz_ext.pile_num', 'biz_ext.port_num', 'biz_ext.sum', 'total',
];

/* =============================================================================
 *  2. 通用工具
 * ============================================================================= */

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 只允许 http/https/相对路径，避免 URL 注入 */
function safeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return s;
  return '';
}

/** Haversine 距离（米） */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function formatDistance(m) {
  const n = toNum(m);
  if (n === null) return '—';
  if (n < 1000) return `${Math.round(n)} m`;
  if (n < 10000) return `${(n / 1000).toFixed(1)} km`;
  return `${Math.round(n / 1000)} km`;
}

/* Web Mercator（简化视图使用） */
const lonToWorldX = (lon, z) => ((lon + 180) / 360) * 256 * Math.pow(2, z);
const latToWorldY = (lat, z) => {
  const s = Math.sin(clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z);
};
const worldXToLon = (x, z) => (x / (256 * Math.pow(2, z))) * 360 - 180;
const worldYToLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / (256 * Math.pow(2, z));
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};
/** 某纬度、某 zoom 下 1 像素代表多少米 */
const metersPerPixel = (lat, z) => (156543.03392 * Math.cos(clamp(lat, -85, 85) * Math.PI / 180)) / Math.pow(2, z);

function fireEvent(node, type, detail) {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/* =============================================================================
 *  3. 缓存 / 节流 / 错误
 * ============================================================================= */

class TtlCache {
  constructor(max = 300) { this.max = max; this.map = new Map(); }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expire) { this.map.delete(key); return undefined; }
    // LRU：命中后移到末尾
    this.map.delete(key); this.map.set(key, hit);
    return hit.value;
  }
  set(key, value, ttlSec) {
    const ttl = toNum(ttlSec);
    if (ttl === null || ttl <= 0) return;   // ttl<=0 视为关闭缓存
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expire: Date.now() + ttl * 1000 });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

/** 串行节流器：保证两次调用之间至少间隔 minInterval 毫秒，且失败不阻塞队列 */
class RateLimiter {
  constructor(minInterval = 400) {
    this.min = Math.max(0, minInterval);
    this._chain = Promise.resolve();
    this._last = 0;
  }
  setMinInterval(ms) { this.min = Math.max(0, ms); }
  schedule(task) {
    const run = this._chain.then(async () => {
      const wait = this._last + this.min - Date.now();
      if (wait > 0) await sleep(wait);
      this._last = Date.now();
      return task();
    });
    this._chain = run.then(() => undefined, () => undefined);
    return run;
  }
}

class AmapError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AmapError';
    this.code = code || 'UNKNOWN';
  }
}

/**
 * 高德官方 infocode → 中文提示（来源：高德开放平台「错误码说明」）
 * 只收录本卡片会真正遇到的码；命中率不高的长尾交回 info 字符串兜底。
 */
const ALC_AMAP_INFOCODE = {
  10001: '高德 Key 不正确或已过期，请检查配置里的 Key',
  10002: '该 Key 没有权限使用此服务（接口路径拼错，或未开通该服务）',
  10003: '今日调用量已超出配额，被高德自动封停，次日 0:00 自动解封',
  10004: '单位时间内访问过于频繁（1 分钟），已触发限流，下一分钟自动解封',
  10005: '发送请求的 IP 不在该 Key 的 IP 白名单内',
  10006: '该 Key 绑定的域名无效，请在控制台重新设置',
  10007: '数字签名未通过验证（本卡片不支持签名，请改用安全密钥方式）',
  10008: 'MD5 安全码未通过验证，请检查安全密钥 securityJsCode',
  10009: 'Key 与绑定平台不符：坐标转换 / 周边检索必须使用「Web 服务」类型的 Key',
  10010: '单个 IP 请求次数超出限制，已被封停（需提交工单解封）',
  10011: '该服务不支持 https 请求',
  10012: '权限不足，服务请求被拒绝',
  10013: '该 Key 已被删除',
  10014: '服务 QPS 超限，超出部分的请求被拒绝',
  10015: '受单机 QPS 限流限制，请降低请求频率',
  10016: '高德服务器负载过高，请稍后再试',
  10017: '所请求的资源不可用',
  10019: '该服务总 QPS 超限，请降低请求频率',
  10020: '该 Key 使用此接口的 QPS 超出限制',
  10021: '账号使用此接口的 QPS 超出限制',
  10026: '账号处于被封禁状态',
  10041: '该接口的权限已过期',
  10044: '账号维度的日调用量超出限制',
  10045: '账号维度的海外服务日调用量超出限制',
  20000: '请求参数非法，请检查坐标与半径的取值',
  20001: '缺少必填参数',
  20002: '请求协议非法（该接口仅支持 GET）',
  20003: '高德返回未知错误',
  20011: '查询点在海外，但该 Key 没有海外地图权限',
  20012: '查询内容存在非法字符',
  20800: '规划点不在中国大陆陆地范围内',
  20801: '规划点附近搜不到路',
  20803: '起点与终点距离过长',
  40000: '所购买服务的余额已耗尽',
  40002: '所购买的服务已到期',
  40003: '海外服务余额已耗尽',
};

/**
 * 把高德返回的 info / infocode 映射成用户能看懂的中文提示
 * @param {string} info     高德返回的 info 字段
 * @param {string|number} [infocode] 高德返回的 infocode 字段
 */
function friendlyAmapInfo(info, infocode) {
  const k = String(info || '').toUpperCase();
  const table = {
    INVALID_USER_KEY: '高德 Key 无效或未开通该服务，请检查 Web 服务 Key',
    INVALID_USER_SCODE: '缺少安全密钥（securityJsCode），请在配置中补全',
    INVALID_USER_DOMAIN: '该 Key 绑定的域名无效，请在控制台重新设置',
    INVALID_USER_SIGNATURE: '数字签名未通过验证',
    INVALID_USER_IP: '发送请求的 IP 不在该 Key 的 IP 白名单内',
    USER_KEY_PLATFORM_ERROR: '高德 Key 与服务类型不匹配（周边检索需要「Web 服务」Key，底图需要「Web 端(JS API)」Key）',
    USERKEY_PLAT_NOMATCH: '高德 Key 与请求的服务类型不匹配（请确认是「Web 服务」类型的 Key）',
    USER_KEY_RECYCLED: '高德 Key 已被回收',
    DAILY_QUERY_OVER_LIMIT: '今日高德接口调用量已达上限，请明天再试',
    ACCESS_TOO_FREQUENT: '请求过于频繁触发限流，已自动退避重试',
    IP_QUERY_OVER_LIMIT: '单个 IP 请求次数超出限制',
    QPS_HAS_EXCEEDED_THE_LIMIT: '请求过于频繁触发限流，已自动退避重试',
    CQPS_HAS_EXCEEDED_THE_LIMIT: '该服务总 QPS 超限，已自动退避',
    CKQPS_HAS_EXCEEDED_THE_LIMIT: '该 Key 在此接口上的 QPS 超限，已自动退避',
    CUQPS_HAS_EXCEEDED_THE_LIMIT: '并发请求超限，已自动退避',
    GATEWAY_TIMEOUT: '受单机 QPS 限流限制，请稍后再试',
    SERVER_IS_BUSY: '高德服务器负载过高，请稍后再试',
    RESOURCE_UNAVAILABLE: '所请求的高德资源不可用',
    SERVICE_NOT_AVAILABLE: '高德服务暂时不可用，请稍后重试',
    SERVICE_NOT_EXIST: '请求的高德服务不存在',
    INSUFFICIENT_PRIVILEGES: '权限不足，该 Key 未开通此服务',
    NO_EFFECTIVE_INTERFACE: '该接口的权限已过期',
    INVALID_PARAMS: '请求参数不合法',
    MISSING_REQUIRED_PARAMS: '缺少必填参数',
    ILLEGAL_REQUEST: '请求协议非法',
    INSUFFICIENT_ABROAD_PRIVILEGES: '查询点在海外，但该 Key 没有海外地图权限',
    ILLEGAL_CONTENT: '查询内容存在非法字符',
    OUT_OF_SERVICE: '规划点不在中国大陆陆地范围内',
    NO_ROADS_NEARBY: '该点附近搜不到路',
    ROUTE_FAIL: '路线计算失败',
    OVER_DIRECTION_RANGE: '起点与终点距离过长',
    QUOTA_PLAN_RUN_OUT: '所购买服务的余额已耗尽',
    SERVICE_EXPIRED: '所购买的服务已到期',
    ABROAD_QUOTA_PLAN_RUN_OUT: '海外服务余额已耗尽',
    ENGINE_RESPONSE_DATA_ERROR: '高德返回数据异常',
    NO_MORE_POIS: '没有更多结果了',
  };
  if (table[k]) return table[k];

  // info 是兜底，但 infocode 更精确，放在其次
  const ic = String(infocode === undefined || infocode === null ? '' : infocode).trim();
  if (ic && ALC_AMAP_INFOCODE[ic]) return ALC_AMAP_INFOCODE[ic];

  if (k.includes('OVER_LIMIT') || k.includes('QPS')) return '请求过于频繁或超出配额，已自动退避';
  if (k.includes('KEY')) return '高德 Key 校验失败';

  if (info) return ic ? `高德接口返回：${info}（infocode ${ic}）` : `高德接口返回：${info}`;
  return ic ? `高德接口返回错误码 ${ic}` : '高德接口调用失败';
}

/** 返回坐标是否落在合法的经纬度范围内 */
function isValidLngLat(lng, lat) {
  return toNum(lng) !== null && toNum(lat) !== null
    && Math.abs(toNum(lat)) <= 90 && Math.abs(toNum(lng)) <= 180;
}

/**
 * 中国境内粗包围盒（用于判断「WGS-84 → GCJ-02 本应产生偏移」）。
 * 只用于诊断提示，不参与任何坐标计算 —— 境外坐标偏移为 0 是正确行为。
 */
const ALC_CHINA_BBOX = { minLng: 73.5, maxLng: 135.1, minLat: 18.0, maxLat: 53.6 };

function inChinaBbox(lng, lat) {
  const x = toNum(lng);
  const y = toNum(lat);
  if (x === null || y === null) return false;
  return x >= ALC_CHINA_BBOX.minLng && x <= ALC_CHINA_BBOX.maxLng
    && y >= ALC_CHINA_BBOX.minLat && y <= ALC_CHINA_BBOX.maxLat;
}

/**
 * 解析并校验坐标转换接口的返回值。
 *
 * ⚠️ 实测行为：高德对越界坐标（如 locations=999,999）**不报错**，
 *    status=1 / info=ok / infocode=10000，把非法坐标原样回显。
 *    因此响应侧必须自己把关，否则会把荒谬坐标当 GCJ-02 用在图上。
 *
 * @param {{locations?:string}} json 高德原始返回
 * @param {number} inLng 传入的 WGS-84 经度
 * @param {number} inLat 传入的 WGS-84 纬度
 * @returns {{lng:number, lat:number, noopShift:boolean}} noopShift=true 表示境内坐标却得到 0 偏移（疑似转换未生效）
 */
function parseConvertedLocation(json, inLng, inLat) {
  // 一次可传多个坐标（';' 分隔），本卡片只传一个，取第一个
  const first = String((json && json.locations) || '').split(';')[0];
  const [glng, glat] = first.split(',').map((x) => toNum(x));
  if (glng === null || glat === null) {
    throw new AmapError('BAD_LOCATION', '坐标转换返回内容无法解析（locations 为空或格式异常）');
  }
  if (!isValidLngLat(glng, glat)) {
    throw new AmapError('BAD_LOCATION', `坐标转换返回越界坐标（${glng}, ${glat}），已忽略`);
  }
  // 境内 GCJ-02 偏移实测 < 0.01°，境外原样返回（偏移 0）；0.05° 余量足够拦住错乱返回。
  const shift = Math.max(Math.abs(glng - inLng), Math.abs(glat - inLat));
  if (shift > ALC_GCJ_MAX_SHIFT) {
    throw new AmapError(
      'BAD_LOCATION',
      `坐标转换返回结果与输入偏差过大（${shift.toFixed(4)}°），已忽略该结果`
    );
  }
  // 境内 WGS-84 转 GCJ-02 必然产生 300~700 米偏移。若原样回显（偏移 < 1 米），
  // 说明这把 Key 的转换能力没生效（未开通 Web 服务 / 接口降级），
  // 此时实体与检索中心会整体偏 ~500 米 —— 标出来，别让用户对着偏移找 bug。
  const noopShift = shift < 1e-5 && inChinaBbox(inLng, inLat);
  return { lng: glng, lat: glat, noopShift };
}

/* =============================================================================
 *  4. 实体坐标读取与校验
 * ============================================================================= */

const ALC_LOC_ERRORS = {
  ENTITY_MISSING: '实体不存在或不可用',
  NO_COORDS: '该实体没有 latitude / longitude 属性',
  BAD_COORDS: '经纬度数值超出合法范围',
  ZERO_COORDS: '经纬度为 (0, 0)，疑似未获取到定位',
};

/**
 * 读取实体经纬度
 * @returns {{ok:true, lat:number, lon:number, accuracy:number|null, state:string}
 *          |{ok:false, reason:string, message:string, state:string|null}}
 */
function readEntityLocation(hass, entityId) {
  if (!hass || !entityId || !hass.states) {
    return { ok: false, reason: 'ENTITY_MISSING', message: ALC_LOC_ERRORS.ENTITY_MISSING, state: null };
  }
  const st = hass.states[entityId];
  if (!st) return { ok: false, reason: 'ENTITY_MISSING', message: ALC_LOC_ERRORS.ENTITY_MISSING, state: null };

  const a = st.attributes || {};
  const lat = toNum(a.latitude !== undefined ? a.latitude : a.lat);
  const lon = toNum(
    a.longitude !== undefined ? a.longitude : (a.lon !== undefined ? a.lon : a.lng)
  );

  if (lat === null || lon === null) {
    return { ok: false, reason: 'NO_COORDS', message: ALC_LOC_ERRORS.NO_COORDS, state: st.state };
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { ok: false, reason: 'BAD_COORDS', message: ALC_LOC_ERRORS.BAD_COORDS, state: st.state };
  }
  if (lat === 0 && lon === 0) {
    return { ok: false, reason: 'ZERO_COORDS', message: ALC_LOC_ERRORS.ZERO_COORDS, state: st.state };
  }
  return {
    ok: true, lat, lon,
    accuracy: toNum(a.gps_accuracy !== undefined ? a.gps_accuracy : a.accuracy),
    state: st.state,
  };
}

/* =============================================================================
 *  5. 高德 JS API 加载（单例，按 Key 复用）
 * ============================================================================= */

const ALC_JS_API_PLUGINS = ['AMap.Scale'];   // ToolBar 在 Shadow DOM 下不可交互，缩放按钮由卡片自绘

const amapLoader = {
  _promise: null,
  _key: null,
  _scriptEl: null,

  isReady() { return typeof window !== 'undefined' && !!window.AMap; },

  /** 注入安全密钥（必须在 script 加载之前设置） */
  _applySecurity(securityJsCode) {
    const code = String(securityJsCode || '').trim();
    if (!code) return;
    window._AMapSecurityConfig = Object.assign({}, window._AMapSecurityConfig, {
      securityJsCode: code,
    });
  },

  /**
   * WebGL 可用性探测。
   *
   * 只用来「诊断 / 提示」，**不再作为是否加载底图的开关**（见 _ensureMap）。
   * 原因：HA iOS App 跑的是 WKWebView，未挂载到文档的 canvas 在部分 iOS 版本上
   * 拿不到 WebGL 上下文（Safari 里同样的写法却是好的）—— 旧逻辑据此直接降级成
   * 简化视图，表现就是「iOS App 里没有底图、Safari 正常」。
   *
   * 探测本身也做了加固：临时挂载 + 显式 1×1（WKWebView 对 0 尺寸 / 离屏 canvas 更挑）、
   * 依次尝试 webgl2 / webgl / experimental-webgl、并且**用完就释放上下文** ——
   * iOS 上 WebGL 上下文配额很少（约 8 个），探测泄漏一个都可能让后面的地图建不出来。
   */
  hasWebGL() {
    let c = null;
    let attached = false;
    let ctx = null;
    try {
      c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      c.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      const host = document.body || document.documentElement;
      if (host) { host.appendChild(c); attached = true; }
      const opts = { failIfMajorPerformanceCaveat: false, antialias: false, depth: false, stencil: false };
      for (const name of ['webgl2', 'webgl', 'experimental-webgl']) {
        try { ctx = c.getContext(name, opts); } catch (e) { ctx = null; }
        if (ctx) break;
      }
      return !!ctx;
    } catch (e) {
      return false;
    } finally {
      try {
        const lose = ctx && ctx.getExtension && ctx.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (e) { /* ignore */ }
      if (attached && c && c.parentNode) { try { c.parentNode.removeChild(c); } catch (e) { /* ignore */ } }
    }
  },

  /** 诊断用：WebGL 的渲染器名称（iOS App 里可据此判断是软件渲染还是被禁用） */
  webglInfo() {
    try {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      const ctx = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!ctx) return 'unavailable';
      const dbg = ctx.getExtension && ctx.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER);
      const lose = ctx.getExtension && ctx.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return String(renderer || 'unknown');
    } catch (e) { return 'error: ' + ((e && e.message) || e); }
  },

  /**
   * 加载高德 JS API 2.0
   * @returns {Promise<any>} 解析为 window.AMap
   */
  load({ key, securityJsCode, plugins = ALC_JS_API_PLUGINS }) {
    if (this.isReady() && this._key === key) return Promise.resolve(window.AMap);
    if (this._promise && this._key === key) return this._promise;

    if (!key) return Promise.reject(new AmapError('NO_JS_KEY', '未配置高德 Key'));

    // Key 变更：清掉旧实例重新加载
    if (this.isReady() && this._key !== key) {
      try { if (this._scriptEl && this._scriptEl.parentNode) this._scriptEl.parentNode.removeChild(this._scriptEl); } catch (e) { /* ignore */ }
      try { delete window.AMap; } catch (e) { window.AMap = undefined; }
    }

    this._applySecurity(securityJsCode);
    this._key = key;

    this._promise = new Promise((resolve, reject) => {
      const params = new URLSearchParams({ v: AMAP_JS_VERSION, key });
      if (plugins && plugins.length) params.set('plugin', plugins.join(','));
      const src = `${AMAP_JS_API_BASE}?${params.toString()}`;

      /** 失败时把请求地址一起带上，便于用户/控制台直接定位 */
      const makeErr = (code, message) => {
        const err = new AmapError(code, message);
        err.url = src;
        err.safeUrl = src.replace(/key=[^&]*/, 'key=***');
        return err;
      };

      const s = document.createElement('script');
      s.async = true;
      s.src = src;
      s.dataset.alcAmap = '1';

      // 清掉之前失败留下的脚本标签，避免用户反复点「重试」时在 head 里堆积
      try {
        document.querySelectorAll('script[data-alc-amap]').forEach((n) => {
          if (n !== this._scriptEl && n.parentNode) n.parentNode.removeChild(n);
        });
      } catch (e) { /* ignore */ }

      const timer = setTimeout(() => {
        cleanup();
        reject(makeErr('JS_API_TIMEOUT', '高德 JS API 加载超时'));
      }, 15000);

      const cleanup = () => { clearTimeout(timer); s.onload = null; s.onerror = null; };

      s.onload = () => {
        cleanup();
        if (window.AMap) resolve(window.AMap);
        else reject(makeErr('JS_API_EMPTY', '高德 JS API 已加载但未初始化成功'));
      };
      s.onerror = () => {
        cleanup();
        reject(makeErr('JS_API_ERROR', '高德 JS API 脚本加载失败'));
      };

      this._scriptEl = s;
      document.head.appendChild(s);
    });

    this._promise.catch(() => { this._promise = null; });
    return this._promise;
  },
};

/**
 * 探测高德底图域名是否可达 —— 用于把「脚本加载失败」细分成两类，给出可操作的提示。
 *
 * <script> 标签不受 CORS 约束，fetch 受约束；这里用 `mode: 'no-cors'` 拿 opaque 响应，
 * 只要能返回就说明「网络层能到该域名」，于是可以区分：
 *   · unreachable → 网络 / DNS / 代理 / 防火墙（或 CSP connect-src）不通
 *   · reachable   → 域名通，但 script 被拦截（扩展、CSP script-src、沙箱预览环境）
 * @returns {Promise<'reachable'|'unreachable'|'unsupported'>}
 */
async function probeAmapHost(timeoutMs = 4000) {
  if (typeof fetch !== 'function') return 'unsupported';
  let timer = null;
  try {
    const opts = { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
    if (typeof AbortController === 'function') {
      const ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, timeoutMs);
    }
    await fetch(`${AMAP_JS_API_BASE}?v=${AMAP_JS_VERSION}`, opts);
    return 'reachable';
  } catch (e) {
    return 'unreachable';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把 JS API 加载失败的原因翻译成一句可操作的中文提示
 * @param {any} err amapLoader.load() 抛出的错误（带 url / safeUrl）
 */
async function diagnoseJsApiFailure(err) {
  const probe = await probeAmapHost();
  // 失败详情一律打到控制台，便于用户直接复制排查（不依赖 show_debug）
  try {
    console.warn(
      `[amap-location-card] 高德底图加载失败（${(err && err.code) || 'UNKNOWN'}）：${(err && err.message) || ''}\n` +
      `  请求地址：${(err && err.safeUrl) || `${AMAP_JS_API_BASE}?v=${AMAP_JS_VERSION}`}\n` +
      `  域名探测：${AMAP_JS_API_HOST} ${probe === 'reachable' ? '可达' : (probe === 'unreachable' ? '不可达' : '未能探测')}`
    );
  } catch (e) { /* ignore */ }

  if (probe === 'unreachable') {
    return `疑似无法访问 ${AMAP_JS_API_HOST}：请检查设备网络 / DNS / 代理 / 防火墙，或浏览器的 CSP（connect-src）与内容拦截扩展。`;
  }
  if (probe === 'reachable') {
    return `${AMAP_JS_API_HOST} 本身可访问，脚本是被拦截的：常见于广告拦截扩展、站点 CSP（script-src），或沙箱化的预览环境；换到真实浏览器/HA 页面打开通常即可恢复。`;
  }
  return `详情已输出到浏览器控制台。`;
}

/* =============================================================================
 *  6. 高德 Web 服务客户端（统一 Key / 缓存 / 节流 / 降级）
 * ============================================================================= */

/*
 * ⚠️ 坐标系契约（改动本文件前必读）——三个坐标来源，转换规则各不相同：
 *
 *   实体坐标（HA 实体 latitude/longitude，来自 GPS / Companion App）  → WGS-84，必须转一次
 *   周边检索结果（/v3/place/around 返回的 pois[].location）           → 已是 GCJ-02，一次都不能转
 *   底图 / JS API（AMap.Marker、setCenter）                          → 期望 GCJ-02
 *
 *   POI 坐标若再走一次 WGS-84→GCJ-02，会整体偏 ~500 米（南昌实测 602 米）。
 *   所以 normalizePoi / _renderPins 一律原样透传 poi.location，
 *   只有 _refresh 里对实体坐标调用 convertToGcj02（唯一允许的转换入口）。
 */

/** 判断当前是否处于 Mock 调试模式（demo.html 使用） */
const alcMock = () => (typeof window !== 'undefined' && window.__AMAP_LOCATION_CARD_MOCK__) || null;

/** 高德 POI → 内部结构。坐标为 GCJ-02，原样保留（见上文「坐标系契约」） */
function normalizePoi(p) {
  const parts = String(p.location || '').split(',');
  const lng = toNum(parts[0]);
  const lat = toNum(parts[1]);
  return {
    id: String(p.id || `${p.name}-${p.location}`),
    name: p.name || '未命名',
    type: p.type || '',
    address: typeof p.address === 'string' ? p.address : '',
    tel: typeof p.tel === 'string' ? p.tel : '',
    lng: lng,
    lat: lat,
    distance: p.distance !== undefined && p.distance !== '' ? toNum(p.distance) : null,
    bizExt: (p.biz_ext && typeof p.biz_ext === 'object') ? p.biz_ext : {},
    raw: p,
  };
}

/** 按点号路径取值 */
function pickByPath(obj, path) {
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 在若干候选字段中取第一个「有值」的 */
function pickFirstField(poi, candidates) {
  for (const path of candidates) {
    const v = pickByPath(poi.bizExt, path.replace(/^biz_ext\./, '')) !== undefined
      ? pickByPath(poi.bizExt, path.replace(/^biz_ext\./, ''))
      : pickByPath(poi.raw, path);
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s || s === '[]' || s === '-' || s === '--') continue;
      return s;
    }
    if (typeof v === 'number') return v;
    if (Array.isArray(v) && v.length) return v.join('/');
  }
  return undefined;
}

function parseFieldList(custom, fallback) {
  const s = String(custom || '').trim();
  if (!s) return fallback;
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

class AmapWebApi {
  constructor(opts = {}) {
    this.key = '';
    this.limiter = new RateLimiter(opts.minInterval || 400);
    this.coordCache = new TtlCache(120);
    this.poiCache = new TtlCache(200);
    this.coordTtl = opts.coordTtl || 300;
    this.poiTtl = opts.poiTtl || 300;
    this.debug = !!opts.debug;
    this.stats = { request: 0, cacheHit: 0, error: 0 };
    this._pending = new Map();
  }

  configure({ key, minInterval, coordTtl, poiTtl, debug }) {
    if (key !== undefined && key !== this.key) {
      this.key = String(key || '').trim();
      this._pending.clear();
    }
    if (minInterval !== undefined) this.limiter.setMinInterval(minInterval);
    if (coordTtl !== undefined) this.coordTtl = coordTtl;
    if (poiTtl !== undefined) this.poiTtl = poiTtl;
    if (debug !== undefined) this.debug = !!debug;
  }

  _log(...args) { if (this.debug) console.debug('[amap-location-card]', ...args); }

  async _fetch(path, params) {
    const url = new URL(AMAP_REST_BASE + path);
    Object.keys(params).forEach((k) => {
      const v = params[k];
      if (v === undefined || v === null || v === '') return;
      url.searchParams.set(k, String(v));
    });
    url.searchParams.set('key', this.key);

    this.stats.request++;
    this._log('→', url.pathname + url.search.replace(this.key, '***'));

    const res = await fetch(url.toString(), {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) {
      this.stats.error++;
      throw new AmapError(`HTTP_${res.status}`, `高德接口网络异常（HTTP ${res.status}）`);
    }
    let json;
    try { json = await res.json(); }
    catch (e) {
      this.stats.error++;
      throw new AmapError('BAD_JSON', '高德接口返回内容无法解析');
    }
    if (String(json.status) !== '1') {
      this.stats.error++;
      // status=0 时高德一定给了 info + infocode，两个都带上去做映射与排查
      const err = new AmapError(
        json.info || 'AMAP_ERROR',
        friendlyAmapInfo(json.info, json.infocode)
      );
      err.infocode = json.infocode === undefined ? '' : String(json.infocode);
      err.info = json.info === undefined ? '' : String(json.info);
      this._log('✗', err.code, err.infocode, err.message);
      throw err;
    }
    this._log('←', json);
    return json;
  }

  /** 坐标转换与周边检索分别使用独立缓存池 */
  _cacheOf(path) {
    return path.indexOf('/assistant/coordinate/convert') >= 0 ? this.coordCache : this.poiCache;
  }
  _getCache(path, cacheKey) { return this._cacheOf(path).get(cacheKey); }
  _putCache(path, cacheKey, value, ttl) { this._cacheOf(path).set(cacheKey, value, ttl); }

  _cachedRequest(path, params, cacheKey, ttl) {
    const useCache = !!cacheKey && toNum(ttl) > 0;
    if (useCache) {
      const hit = this._getCache(path, cacheKey);
      if (hit !== undefined) {
        this.stats.cacheHit++;
        this._log('cache hit', cacheKey);
        return Promise.resolve(hit);
      }
    }
    // 关闭缓存时用更细的键，避免把每次都当成同一个并发请求合并掉
    const dedupe = `${path}::${useCache ? cacheKey : JSON.stringify(params)}`;
    if (this._pending.has(dedupe)) return this._pending.get(dedupe);

    const p = this.limiter
      .schedule(() => this._fetch(path, params))
      .then((json) => {
        if (useCache) this._putCache(path, cacheKey, json, ttl);
        return json;
      })
      .finally(() => { this._pending.delete(dedupe); });

    this._pending.set(dedupe, p);
    return p;
  }

  /** WGS84 → GCJ02（强制走高德 Web 服务 /v3/assistant/coordinate/convert，coordsys=gps） */
  async convertFromGps(lng, lat, force = false) {
    const inLng = toNum(lng);
    const inLat = toNum(lat);
    if (!isValidLngLat(inLng, inLat)) {
      throw new AmapError('BAD_COORDS', '待转换的经纬度不合法，已跳过坐标转换');
    }
    const lngS = inLng.toFixed(6);
    const latS = inLat.toFixed(6);
    const cacheKey = `${lngS},${latS}`;
    if (force) this.coordCache.map.delete(cacheKey);

    const json = await this._cachedRequest(
      '/v3/assistant/coordinate/convert',
      { locations: `${lngS},${latS}`, coordsys: 'gps', output: 'json' },
      cacheKey,
      this.coordTtl
    );

    try {
      return parseConvertedLocation(json, inLng, inLat);
    } catch (e) {
      // 只缓存成功结果：校验不通过就立刻剔除，免得坏数据在缓存里锁死 5 分钟
      this.coordCache.map.delete(cacheKey);
      throw e;
    }
  }

  /** 周边检索 */
  async placeAround({ lng, lat, types, radius, offset = 20, page = 1, force = false }) {
    const cacheKey = `${types}:${toNum(lng).toFixed(4)},${toNum(lat).toFixed(4)}:${radius}:${offset}:${page}`;
    if (force) this.poiCache.map.delete(cacheKey);

    const json = await this._cachedRequest(
      '/v3/place/around',
      {
        location: `${toNum(lng).toFixed(6)},${toNum(lat).toFixed(6)}`,
        types,
        radius: clamp(toNum(radius) || 2000, 1, 50000),
        offset: clamp(toNum(offset) || 20, 1, 25),
        page: clamp(toNum(page) || 1, 1, 100),
        extensions: 'all',
        sortrule: 'distance',
        output: 'json',
      },
      cacheKey,
      this.poiTtl
    );
    const pois = Array.isArray(json.pois) ? json.pois : [];
    return pois.map(normalizePoi).filter((p) => p.lng !== null && p.lat !== null);
  }

  /** 清空全部缓存 */
  clearCache() { this.coordCache.clear(); this.poiCache.clear(); }

  /** 只清周边检索缓存（半径 / 视角变化时用，坐标转换结果仍然有效） */
  clearPoiCache() { this.poiCache.clear(); }
}

/* =============================================================================
 *  7. 坐标转换（Web 服务 → JS API 降级 → 原始 WGS84）
 * ============================================================================= */

/**
 * @returns {Promise<{lng:number, lat:number, via:'web'|'jsapi'|'raw', notice?:string}>}
 */
async function convertToGcj02({ api, wgsLng, wgsLat, jsKey, force = false }) {
  // 1) 高德 Web 服务（需求强制路径）
  try {
    const r = await api.convertFromGps(wgsLng, wgsLat, force);
    if (r.noopShift) {
      return {
        lng: r.lng, lat: r.lat, via: 'web',
        notice: '坐标转换接口原样返回了输入坐标（偏移 0 米），纠偏未生效。'
          + '若你看到点位整体偏移约 500 米，请检查这把 Key 是否开通「Web 服务」权限。',
      };
    }
    return { lng: r.lng, lat: r.lat, via: 'web' };
  } catch (e) {
    if (alcMock() && alcMock().staticConvert) {
      return { lng: wgsLng + alcMock().staticConvert, lat: wgsLat + alcMock().staticConvert, via: 'mock' };
    }
    const apiErr = e;
    // 2) 高德 JS API 内置转换服务（同一把 Key，浏览器侧无 CORS 顾虑）
    try {
      const AMap = await amapLoader.load({ key: jsKey });
      const loc = await new Promise((resolve, reject) => {
        AMap.convertFrom([wgsLng, wgsLat], 'gps', (status, result) => {
          if (status === 'complete' && result && result.info === 'ok' && result.locations && result.locations.length) {
            const l = result.locations[0];
            resolve({ lng: toNum(l.getLng ? l.getLng() : l.lng), lat: toNum(l.getLat ? l.getLat() : l.lat) });
          } else {
            reject(new AmapError('JSAPI_CONVERT_FAIL', 'JS API 坐标转换失败'));
          }
        });
      });
      if (loc.lng !== null && loc.lat !== null && isValidLngLat(loc.lng, loc.lat)) {
        return {
          lng: loc.lng, lat: loc.lat, via: 'jsapi',
          notice: `坐标转换已降级为 JS API（Web 服务异常：${apiErr.message}）`,
        };
      }
      throw new AmapError('JSAPI_CONVERT_BAD', 'JS API 坐标转换返回异常');
    } catch (e2) {
      // 3) 兜底：直接使用原始 WGS84（会有几十到几百米偏移），但绝不阻塞
      return {
        lng: wgsLng, lat: wgsLat, via: 'raw',
        notice: `坐标转换失败，已按原始 WGS84 坐标展示，点位可能存在偏移（${apiErr.message}）`,
      };
    }
  }
}

/* =============================================================================
 *  8. 图标 / 标记 / 导航链接
 * ============================================================================= */

/** 图标描述可以是 mdi:xxx、图片 URL、/local/xxx.png 或任意 emoji/文字 */
function iconHtml(spec, size, className = '') {
  const s = String(spec === undefined || spec === null ? '' : spec).trim();
  const px = Math.max(12, toNum(size) || 34);
  if (!s) return `<span class="alc-icon alc-icon-text ${className}" style="width:${px}px;height:${px}px"></span>`;

  const url = safeUrl(s);
  if (url) {
    return `<img class="alc-icon alc-icon-img ${className}" alt="" draggable="false"
      src="${escapeHtml(url)}" style="width:${px}px;height:${px}px">`;
  }
  if (/^[a-z0-9_-]+:[a-z0-9-]+$/i.test(s)) {
    return `<ha-icon class="alc-icon alc-icon-ha ${className}" icon="${escapeHtml(s)}"
      style="--mdc-icon-size:${Math.round(px * 0.72)}px;width:${px}px;height:${px}px"></ha-icon>`;
  }
  return `<span class="alc-icon alc-icon-emoji ${className}"
    style="font-size:${Math.round(px * 0.56)}px;width:${px}px;height:${px}px">${escapeHtml(s)}</span>`;
}

const ALC_NAV_SRC = 'amap-location-card';

/** 高德地图标注页（可唤起 App） */
function buildMarkerUrl({ lng, lat, name }) {
  return 'https://uri.amap.com/marker'
    + `?position=${lng.toFixed(6)},${lat.toFixed(6)}`
    + `&name=${encodeURIComponent(name || '位置')}`
    + `&coordinate=gaode&callnative=1&src=${ALC_NAV_SRC}`;
}

/** 高德导航页（可唤起 App） */
function buildNavigationUrl({ fromLng, fromLat, fromName, toLng, toLat, toName, mode = 'car' }) {
  let u = 'https://uri.amap.com/navigation'
    + `?to=${toLng.toFixed(6)},${toLat.toFixed(6)},${encodeURIComponent(toName || '终点')}`
    + `&mode=${encodeURIComponent(mode)}&coordinate=gaode&callnative=1&src=${ALC_NAV_SRC}`;
  if (toNum(fromLng) !== null && toNum(fromLat) !== null) {
    u += `&from=${toNum(fromLng).toFixed(6)},${toNum(fromLat).toFixed(6)},${encodeURIComponent(fromName || '起点')}`;
  }
  return u;
}

/**
 * 打开外部链接
 * @param {string} url
 * @param {boolean} newTab true = 新标签页打开（保留 HA 面板）；false = 当前页面直接跳转
 *        （部分 iOS 环境下直接跳转更能可靠唤起高德 App，故保留为可配置项）
 */
function openExternal(url, newTab) {
  if (!url) return;
  if (newTab === false) {
    try { window.location.href = url; return; } catch (e) { /* 继续尝试 window.open */ }
  }
  let win = null;
  try { win = window.open(url, '_blank', 'noopener'); } catch (e) { win = null; }
  if (!win) {
    try { window.location.href = url; } catch (e) { /* ignore */ }
  }
}

/* =============================================================================
 *  9. 简化视图地图（WebGL / JS API 不可用时的降级渲染）
 *     同一套标记 DOM，与高德底图模式视觉一致，交互（拖动 / 缩放 / 点击）保留
 * ============================================================================= */

class CanvasFallbackMap {
  constructor(host, opts = {}) {
    this.host = host;
    this.zoom = clamp(toNum(opts.zoom) || 15, 3, 19);
    this.center = [toNum(opts.centerLng) || 116.397428, toNum(opts.centerLat) || 39.90923];
    // 定位点（源实体）自身的经纬度：十字准星与搜索半径圈都画在它上面，
    // 而不是永远画在画布正中 —— 用户拖动/缩放地图后两者会分开。
    const fLng = toNum(opts.focusLng);
    const fLat = toNum(opts.focusLat);
    this.focus = (fLng === null || fLat === null) ? null : [fLng, fLat];
    this.radius = toNum(opts.radius) || 0;
    // 真实瓦片底图：JS API 完全不可用时（iOS App 内嵌 WKWebView 上常见）也不用看白板 ——
    // 直接按 Web 墨卡托取高德栅格瓦片画到 canvas 上，经纬度投影与 JS API 完全一致。
    this.tiles = opts.tiles !== false;
    this._tileCache = new Map();
    this._tileRaf = null;
    this.markers = [];
    this.onMarkerClick = opts.onMarkerClick || (() => {});
    this.onViewChange = opts.onViewChange || (() => {});
    this.onZoom = opts.onZoom || (() => {});
    // 卡片已经在地图右下角放了统一控件列（回到定位 / + / − / 列表），
    // 默认不再重复创建简化视图自带的一套按钮。
    this.showControls = opts.controls !== false;
    this._pointers = new Map();
    this._pinchDist = 0;
    this._dragging = false;
    this._popupHost = null;
    this._build();
  }

  _build() {
    this.host.innerHTML = '';
    this.host.classList.add('alc-fallback-map');

    const canvas = document.createElement('canvas');
    canvas.className = 'alc-fm-canvas';
    this.canvas = canvas;

    const layer = document.createElement('div');
    layer.className = 'alc-fm-layer';
    this.layer = layer;

    // 卡片本身在地图上有一列控件（回到定位 / + / − / 列表），这里默认不再自建一套，
    // 否则右下角会出现两组互相重叠的按钮。单独使用 CanvasFallbackMap 时才需要它。
    const controls = document.createElement('div');
    controls.className = 'alc-fm-controls';
    controls.innerHTML = `
      <button type="button" class="alc-fm-btn" data-act="zoom-in" aria-label="放大">+</button>
      <button type="button" class="alc-fm-btn" data-act="zoom-out" aria-label="缩小">−</button>
      <button type="button" class="alc-fm-btn" data-act="recenter" aria-label="回到中心">◎</button>`;
    controls.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'zoom-in') this.setZoom(this.zoom + 1);
      if (btn.dataset.act === 'zoom-out') this.setZoom(this.zoom - 1);
      if (btn.dataset.act === 'recenter') this._recenterRequest && this._recenterRequest();
    });
    this.controls = controls;

    const badge = document.createElement('div');
    badge.className = 'alc-fm-badge';
    badge.textContent = this.tiles ? '瓦片底图 · 高德' : '简化视图 · 未加载高德底图';
    this.badge = badge;

    const popup = document.createElement('div');
    popup.className = 'alc-fm-popup';
    popup.hidden = true;
    this.popup = popup;

    this.host.appendChild(canvas);
    this.host.appendChild(layer);
    this.host.appendChild(badge);
    if (this.showControls) this.host.appendChild(controls);
    this.host.appendChild(popup);

    this._bindGestures();
    this._observeResize();
    this.resize();
  }

  _bindGestures() {
    const h = this.host;
    h.style.touchAction = 'none';

    h.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.alc-fm-controls')) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 1) {
        this._dragging = true;
        this._startCenter = this.center.slice();
        this._startPos = { x: e.clientX, y: e.clientY };
      } else if (this._pointers.size === 2) {
        this._dragging = false;
        this._pinchDist = this._pointerDistance();
      }
      try { h.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });

    h.addEventListener('pointermove', (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pointers.size >= 2) {
        const d = this._pointerDistance();
        if (this._pinchDist > 0 && d > 0) {
          const delta = d / this._pinchDist;
          if (delta > 1.2 || delta < 0.83) {
            this.setZoom(this.zoom + (delta > 1 ? 1 : -1), false);
            this._pinchDist = d;
          }
        }
        return;
      }
      if (!this._dragging) return;
      const dx = e.clientX - this._startPos.x;
      const dy = e.clientY - this._startPos.y;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      e.preventDefault();
      const mpp = metersPerPixel(this._startCenter[1], this.zoom);
      const dLng = -(dx * mpp) / (111320 * Math.cos(clamp(this._startCenter[1], -85, 85) * Math.PI / 180));
      const dLat = (dy * mpp) / 110540;
      this.center = [this._startCenter[0] + dLng, this._startCenter[1] + dLat];
      this._renderMarkers();
      this._render();
      this.onViewChange(this.center, this.zoom);
    });

    const endPointer = (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinchDist = 0;
      if (this._pointers.size === 0) this._dragging = false;
    };
    h.addEventListener('pointerup', endPointer);
    h.addEventListener('pointercancel', endPointer);
    h.addEventListener('pointerleave', endPointer);

    h.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setZoom(this.zoom + (e.deltaY < 0 ? 1 : -1), false);
    }, { passive: false });
  }

  _pointerDistance() {
    const pts = Array.from(this._pointers.values());
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  _observeResize() {
    if (typeof ResizeObserver === 'undefined') return;
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.host);
  }

  resize() {
    const w = this.host.clientWidth || 300;
    const h = this.host.clientHeight || 300;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const sizeChanged = w !== this._w || h !== this._h;
    this._w = w; this._h = h; this._dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this._renderMarkers();
    this._render();
    // 容器尺寸变化同样会改变可视范围（横竖屏切换）→ 通知外部重算搜索半径
    if (sizeChanged) this.onZoom(this.zoom, this.viewportRadius());
  }

  setCenter(lng, lat) {
    this.center = [toNum(lng) || 0, toNum(lat) || 0];
    this._renderMarkers();
    this._render();
  }

  setZoom(z, silent = true, quiet = false) {
    this.zoom = clamp(Math.round(z), 3, 19);
    this._renderMarkers();
    this._render();
    if (!silent) this.onViewChange(this.center, this.zoom);
    if (!quiet) this.onZoom(this.zoom, this.viewportRadius());
  }

  /**
   * 当前可视范围对应的半径（米）。
   *   basis='cover'（默认）：中心 → 四角（外接圆），覆盖整个可视矩形
   *   basis='visible'      ：中心 → 最近边（内切圆），只覆盖画面中间一块
   * 地图缩小时可视面积变大，返回值随之变大 —— 这就是「自动搜索范围」的依据。
   */
  viewportRadius(basis) {
    const w = this._w || 0;
    const h = this._h || 0;
    if (!w || !h) return null;
    const mpp = metersPerPixel(this.center[1], this.zoom);
    const half = basis === 'cover'
      ? Math.hypot(w / 2, h / 2)
      : Math.min(w / 2, h / 2);
    return Math.round(half * mpp);
  }

  /** 设置定位点（源实体，GCJ-02）；十字准星与搜索半径圈据此绘制 */
  setFocus(lng, lat) {
    const l = toNum(lng);
    const t = toNum(lat);
    const next = (l === null || t === null) ? null : [l, t];
    const same = (next === null && this.focus === null)
      || (next && this.focus && next[0] === this.focus[0] && next[1] === this.focus[1]);
    if (same) return;
    this.focus = next;
    this._render();
    this._renderMarkers();
  }

  /** 定位点在画布上的落点；没设置 focus 时退回画布中心 */
  focusPoint() {
    if (!this.focus) return { x: this._w / 2, y: this._h / 2 };
    return this.project(this.focus[0], this.focus[1]);
  }

  setRadius(m) { this.radius = toNum(m) || 0; this._render(); }

  setMarkers(list) {
    this.markers = Array.isArray(list) ? list : [];
    this._renderMarkers();
    this._render();
  }

  project(lng, lat) {
    const cx = lonToWorldX(this.center[0], this.zoom);
    const cy = latToWorldY(this.center[1], this.zoom);
    const x = lonToWorldX(toNum(lng), this.zoom);
    const y = latToWorldY(toNum(lat), this.zoom);
    return { x: (x - cx) + this._w / 2, y: (y - cy) + this._h / 2 };
  }

  _renderMarkers() {
    const frag = document.createDocumentFragment();
    const pad = 80;   // 只画到画布外一点点，配合容器 overflow:hidden 避免标记溢出地图框
    this.markers.forEach((m) => {
      const p = this.project(m.lng, m.lat);
      if (p.x < -pad || p.y < -pad || p.x > this._w + pad || p.y > this._h + pad) return;
      const el = document.createElement('div');
      el.className = `alc-fm-marker alc-fm-marker-${m.kind || 'poi'}`;
      el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`;
      el.innerHTML = m.html;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.onMarkerClick(m.data, el);
      });
      frag.appendChild(el);
    });
    this.layer.innerHTML = '';
    this.layer.appendChild(frag);
    this._placePopup();   // 视图变了，弹窗跟着锚点走，别停在原地
  }

  _render() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const { _w: w, _h: h, _dpr: dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cs = getComputedStyle(this.host);
    const bg = cs.getPropertyValue('--alc-fallback-bg').trim() || '#f2f4f7';
    const grid = cs.getPropertyValue('--alc-fallback-grid').trim() || 'rgba(0,0,0,0.06)';
    const accent = cs.getPropertyValue('--alc-accent').trim() || '#03a9f4';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const mpp = metersPerPixel(this.center[1], this.zoom);

    // 先铺真实瓦片；一张都铺不上（离线 / 瓦片被拦 / 关了瓦片）时才退回网格占位
    if (!this._drawTiles(ctx, w, h)) {
      // 网格
      let step = 200; // 米
      const steps = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
      for (const s of steps) { if (s / mpp >= 48) { step = s; break; } step = s; }
      const stepPx = step / mpp;
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const cx = lonToWorldX(this.center[0], this.zoom);
      const cy = latToWorldY(this.center[1], this.zoom);
      const originX = (cx % stepPx);
      const originY = (cy % stepPx);
      for (let x = -originX; x <= w; x += stepPx) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
      for (let y = -originY; y <= h; y += stepPx) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
      ctx.stroke();
    }

    // 定位点（源实体）在画布上的真实落点 —— 拖动地图后它不再等于画布中心
    const fp = this.focusPoint();

    // 搜索半径圈：以定位点为圆心，而不是以画布为圆心
    if (this.radius > 0) {
      const rpx = this.radius / mpp;
      ctx.beginPath();
      ctx.arc(fp.x, fp.y, rpx, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(3,169,244,0.08)';
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);

      // 比例尺文字（贴在圈顶，圈顶出画布时落到画布内）
      ctx.fillStyle = accent;
      ctx.font = '11px system-ui, -apple-system, sans-serif';
      const label = this.radius >= 1000 ? `${(this.radius / 1000).toFixed(1)} km` : `${Math.round(this.radius)} m`;
      ctx.fillText(`搜索半径 ${label}`, clamp(fp.x + 8, 4, Math.max(4, w - 110)), clamp(fp.y - rpx + 14, 12, h - 4));
    }

    // 十字准星：定位点本体
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(fp.x - 7, fp.y); ctx.lineTo(fp.x + 7, fp.y);
    ctx.moveTo(fp.x, fp.y - 7); ctx.lineTo(fp.x, fp.y + 7);
    ctx.stroke();
  }

  /* ------------------------------------------------ 瓦片底图（无 JS API 时） */

  /**
   * 把高德栅格瓦片铺到 canvas 上。瓦片用的是标准 Web 墨卡托 XYZ 编号，
   * 与 project()/lonToWorldX() 的投影完全一致，所以标记不需要任何额外偏移。
   * 返回「是否铺上了至少一张」—— false 时调用方退回网格占位。
   */
  _drawTiles(ctx, w, h) {
    if (!this.tiles || !ctx || typeof ctx.drawImage !== 'function') return false;
    const z = clamp(this.zoom, 3, 19);
    const tz = Math.min(z, 18);                        // 高德瓦片最高 18 级
    const size = 256 * Math.pow(2, z - tz);            // z=19 时把 18 级瓦片放大一倍
    const left = lonToWorldX(this.center[0], z) - w / 2;
    const top = latToWorldY(this.center[1], z) - h / 2;
    const n = Math.pow(2, tz);
    const x0 = Math.floor(left / size);
    const y0 = Math.floor(top / size);
    const x1 = Math.floor((left + w) / size);
    const y1 = Math.floor((top + h) / size);
    let drawn = 0;
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= n) continue;               // 南北极之外没有瓦片
        const wx = ((tx % n) + n) % n;                 // 东西方向绕地球一圈
        const img = this._tile(tz, wx, ty);
        if (!img) continue;
        ctx.drawImage(img, tx * size - left, ty * size - top, size, size);
        drawn++;
      }
    }
    return drawn > 0;
  }

  /** 取瓦片（已加载才返回 img）；未加载过就发起请求，失败的不再重试 */
  _tile(tz, x, y) {
    const key = `${tz}/${x}/${y}`;
    const hit = this._tileCache.get(key);
    if (hit === 'loading' || hit === 'error') return null;
    if (hit) return hit;
    if (this._tileCache.size > 320) this._pruneTiles();
    const img = document.createElement('img');
    // 不设 crossOrigin：瓦片若不带 CORS 头，设了反而整批加载失败。
    // 这里只 drawImage、从不读像素，画布被「污染」没有任何影响。
    img.decoding = 'async';
    img.onload = () => {
      if (!this.canvas) return;                        // 已销毁
      this._tileCache.set(key, img);
      this._scheduleTileRender();
    };
    img.onerror = () => { this._tileCache.set(key, 'error'); };
    this._tileCache.set(key, 'loading');
    img.src = `https://wprd0${1 + ((x + y) % 4)}.is.autonavi.com/appmaptile`
      + `?lang=zh_cn&size=1&style=7&x=${x}&y=${y}&z=${tz}`;
    return null;
  }

  /** 缓存别无限涨：按插入顺序丢掉最老的 80 张（Map 保持插入序） */
  _pruneTiles() {
    let n = 0;
    for (const k of this._tileCache.keys()) {
      this._tileCache.delete(k);
      if (++n >= 80) break;
    }
  }

  /** 一张瓦片加载完就重绘一次（合并到同一帧，避免十几张各自重绘） */
  _scheduleTileRender() {
    if (this._tileRaf) return;
    const raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
      ? window.requestAnimationFrame.bind(window)
      : (fn) => setTimeout(fn, 16);
    this._tileRaf = raf(() => { this._tileRaf = null; this._render(); });
  }

  /** 打开自定义弹窗（与高德 InfoWindow 内容保持一致） */
  openPopup(data, anchorEl) {
    if (!data || !data.popupHtml) { this.closePopup(); return; }
    this.popup.innerHTML = `<div class="alc-popup-body">${data.popupHtml}</div>
      <button type="button" class="alc-popup-close" aria-label="关闭">×</button>`;
    this.popup.hidden = false;
    this._popupFor = data;
    this._placePopup();
    const close = this.popup.querySelector('.alc-popup-close');
    if (close) close.addEventListener('click', (e) => { e.stopPropagation(); this.closePopup(); });
  }

  /**
   * 把弹窗摆到锚点上方；上方放不下就翻到下方，并整体夹在画布内。
   * 弹窗用 transform:translate(-50%,-100%)，所以 style.top 是弹窗底边。
   */
  _placePopup() {
    const data = this._popupFor;
    if (!data || !this.popup || this.popup.hidden) return;
    const w = this._w || 0;
    const h = this._h || 0;
    if (!w || !h) return;
    const pw = this.popup.offsetWidth || 220;
    const ph = this.popup.offsetHeight || 120;
    const gap = 14;
    const p = this.project(data.lng, data.lat);

    let topEdge = p.y - gap - ph;                         // 优先：点位正上方
    if (topEdge < 4) topEdge = p.y + gap;                 // 上方放不下 → 翻到下方
    topEdge = clamp(topEdge, 4, Math.max(4, h - ph - 4));

    const minX = Math.min(pw / 2 + 4, w / 2);
    const maxX = Math.max(w - pw / 2 - 4, w / 2);
    this.popup.style.left = `${clamp(p.x, minX, maxX)}px`;
    this.popup.style.top = `${topEdge + ph}px`;
  }

  closePopup() { if (this.popup) { this.popup.hidden = true; this.popup.innerHTML = ''; } this._popupFor = null; }

  destroy() {
    try { if (this._ro) this._ro.disconnect(); } catch (e) { /* ignore */ }
    if (this._tileRaf) {
      try { (window.cancelAnimationFrame || clearTimeout)(this._tileRaf); } catch (e) { /* ignore */ }
      this._tileRaf = null;
    }
    this._tileCache.clear();
    this._pointers.clear();
    this.canvas = null;                 // 让在途的瓦片回调知道自己已被丢弃
    this.host.innerHTML = '';
  }
}

/* =============================================================================
 *  10. 共享的高德 Web 服务客户端（按 Key 复用，保证跨卡片统一节流）
 * ============================================================================= */

const ALC_API_REGISTRY = new Map();

function getSharedApi(key, opts = {}) {
  const k = String(key || '').trim() || '__no_key__';
  let api = ALC_API_REGISTRY.get(k);
  if (!api) {
    api = new AmapWebApi({ minInterval: opts.minInterval, coordTtl: opts.coordTtl, poiTtl: opts.poiTtl, debug: opts.debug });
    ALC_API_REGISTRY.set(k, api);
  }
  api.configure({
    key: k === '__no_key__' ? '' : k,
    minInterval: opts.minInterval,
    coordTtl: opts.coordTtl,
    poiTtl: opts.poiTtl,
    debug: opts.debug,
  });
  return api;
}

const parseLngLat = (s) => {
  const parts = String(s || '').split(',').map((x) => toNum(x));
  if (parts.length < 2 || parts[0] === null || parts[1] === null) return null;
  if (Math.abs(parts[1]) > 90 || Math.abs(parts[0]) > 180) return null;
  return [parts[0], parts[1]];
};

/** 把 POI 展平成视图需要的结构 */
function buildPoiView(poi, opts) {
  const { kind, icon, center, cfg } = opts;
  const distance = poi.distance !== null
    ? poi.distance
    : haversine(center.lat, center.lng, poi.lat, poi.lng);

  let price = null;
  let available = null;
  let total = null;
  if (kind === 'charging') {
    price = pickFirstField(poi, parseFieldList(cfg.price_fields, ALC_PRICE_FIELD_CANDIDATES));
    available = pickFirstField(poi, parseFieldList(cfg.available_fields, ALC_AVAILABLE_FIELD_CANDIDATES));
    total = pickFirstField(poi, parseFieldList(cfg.total_fields, ALC_TOTAL_FIELD_CANDIDATES));
  }
  return { kind, icon, poi, distance, price, available, total };
}

const formatPrice = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = toNum(v);
  if (n !== null) return `${n} 元/度`;
  const s = String(v).trim();
  if (!s) return null;
  return /元|度|kwh/i.test(s) ? s : `${s} 元/度`;
};

const formatAvailable = (v, total) => {
  if (v === null || v === undefined || v === '') return null;
  const n = toNum(v);
  const t = toNum(total);
  const core = n !== null ? `${n}` : String(v);
  if (t !== null) return `${core} / ${t} 个可用`;
  return n !== null ? `${core} 个可用` : core;
};

/* =============================================================================
 *  11. 卡片主体
 * ============================================================================= */

class AmapLocationCard extends HTMLElement {
  static async getConfigElement() {
    return document.createElement(ALC_EDITOR_TAG);
  }

  static getStubConfig(hass) {
    let entity = '';
    if (hass && hass.states) {
      for (const id of Object.keys(hass.states)) {
        const a = hass.states[id].attributes || {};
        if (toNum(a.latitude) !== null && toNum(a.longitude) !== null) { entity = id; break; }
      }
    }
    return { entity, amap_key: '', radius_mode: 'auto', radius: 2000, show_charging: true, show_toilet: true };
  }

  static getCardSize() { return 8; }

  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: 'open' });
    this._mapMode = null;
    this._map = null;
    this._fbMap = null;
    this._markers = [];
    this._markerIndex = new Map();   // 高德 Marker 复用索引（拖动重搜时增量更新，见 _renderPins）
    this._pins = [];
    this._notices = new Map();
    this._poiGroups = [];
    this._built = false;
    this._busy = false;
    this._queued = false;
    this._lastRefresh = 0;
    this._lastCoordKey = null;
    this._userPannedAt = 0;
    this._programmaticAt = 0;
    this._suppressViewportRefetch = false;
    this._viewOverride = null;
    this._viewInitialized = false;
    this._listOpen = false;
    this._gesturesBound = false;
    this._activePopupPin = null;
    this._activePinData = null;
    this._lastRadius = null;
    this._lastCenter = null;   // 上次检索使用的基点（auto 模式下跟随视野中心）
    this._radiusTimer = null;
    this._radiusCircle = null;
  }

  /* ---------------------------------------------------------------- 配置 */

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error('amap-location-card：请在配置中指定 entity（一个带 latitude / longitude 属性的实体）');
    }
    const raw = JSON.stringify(config);
    if (raw === this._rawConfig) return;
    this._rawConfig = raw;

    const cfg = Object.assign({}, ALC_DEFAULTS, config);
    cfg.height = clamp(toNum(cfg.height) || 320, 120, 1200);
    cfg.fill_viewport = cfg.fill_viewport !== false;   // 默认 true，显式 false 才关
    cfg.fallback_tiles = cfg.fallback_tiles !== false; // 瓦片底图默认开（关掉就只剩网格占位）
    cfg.radius = clamp(toNum(cfg.radius) || 2000, 50, 50000);
    cfg.auto_radius_pad = clamp(toNum(cfg.auto_radius_pad) || 1, 0.2, 4);
    cfg.auto_radius_max = clamp(toNum(cfg.auto_radius_max) || 5000, 100, 50000);
    if (cfg.radius_mode !== 'fixed') cfg.radius_mode = 'auto';
    cfg.max_poi = clamp(toNum(cfg.max_poi) || 20, 1, 25);
    cfg.follow_zoom = clamp(toNum(cfg.follow_zoom) || 16, 3, 19);
    cfg.locked_zoom = clamp(toNum(cfg.locked_zoom) || 15, 3, 19);
    cfg.icon_size = clamp(toNum(cfg.icon_size) || 34, 16, 96);
    cfg.coord_cache_ttl = clamp(toNum(cfg.coord_cache_ttl) || 300, 0, 86400);
    cfg.poi_cache_ttl = clamp(toNum(cfg.poi_cache_ttl) || 300, 0, 86400);
    cfg.api_min_interval = clamp(toNum(cfg.api_min_interval) || 400, 0, 5000);
    cfg.refresh_interval = clamp(toNum(cfg.refresh_interval) || 60, 0, 3600);
    if (cfg.view_mode !== 'locked') cfg.view_mode = 'follow';
    if (cfg.gesture !== 'scroll') cfg.gesture = 'map';
    if (cfg.click_action !== 'navigate') cfg.click_action = 'popup';

    this._cfg = cfg;
    this._viewOverride = null;
    this._lastRadius = null;
    this._lastCenter = null;
    this._api = getSharedApi(cfg.amap_key, {
      minInterval: cfg.api_min_interval,
      coordTtl: cfg.coord_cache_ttl,
      poiTtl: cfg.poi_cache_ttl,
      debug: cfg.show_debug,
    });

    // 结构性配置变化 → 重建地图
    if (this._mapMode) this._teardownMap();

    this._build();
    if (this._hass) {
      this._stateFromHass();
    }
  }

  /* ------------------------------------------------------------- hass */

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._cfg) return;
    this._stateFromHass();

    // 首次渲染时若浏览器没有 WebGL / 未加载 JS API，等一帧再建图，避免容器尺寸为 0
    if (first) requestAnimationFrame(() => { if (this._resizeMap) this._resizeMap(); });
  }

  get hass() { return this._hass; }

  _stateFromHass() {
    const res = readEntityLocation(this._hass, this._cfg.entity);
    if (!res.ok) {
      this._loc = null;
      this._convertVia = null;
      this._gcj = null;
      this._poiGroups = [];
      this._showNotice('loc', 'error', `无法获取定位：${res.message}`, '重试', () => this._refresh(true));
      this._renderStatus();
      this._clearPins();
      this._renderList();
      return;
    }
    this._notices.delete('loc');
    this._renderNotices();
    this._loc = res;
    this._renderStatus();
    this._maybeUpdateMap();
  }

  /* ------------------------------------------------------- 生命周期 */

  connectedCallback() {
    if (!this._ro && typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resizeMap());
      this._ro.observe(this);
    }
  }

  disconnectedCallback() {
    this._teardownAll();
    try { if (this._ro) { this._ro.disconnect(); this._ro = null; } } catch (e) { /* ignore */ }
  }

  getCardSize() {
    if (this._cfg && this._cfg.fill_viewport && !this._inEditorPreview()) {
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      // 减掉已测到的底部工具栏高度，masonry 预留的高度才不会把列表挤到屏幕外
      return Math.max(6, Math.round((vh - (this._fillGap || 0)) / 50));
    }
    const h = (this._cfg && this._cfg.height) || 320;
    return Math.max(4, Math.round(h / 50) + 3);
  }

  /** 是否处在 HA 的卡片配置编辑器预览里 —— 那里不铺满，避免把配置面板撑爆 */
  _inEditorPreview() {
    try {
      let node = this;
      for (let i = 0; i < 24 && node; i++) {
        const tag = (node.tagName || '').toLowerCase();
        const cls = typeof node.className === 'string' ? node.className : '';
        // HA 各版本的配置容器：卡片预览 / 元素编辑器 / 选项表单 / 编辑弹窗
        if (/^hui-(card-preview|card-element-editor|card-options|dialog-edit-card)/.test(tag)) return true;
        if (tag === 'ha-dialog' || tag === 'ha-dialog-header') return true;
        if (/(^|[\s-])(card-config|card-options|element-editor)([\s-]|$)/.test(cls)) return true;
        const root = node.getRootNode ? node.getRootNode() : null;
        node = node.parentElement || (root && root.host) || null;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /* --------------------------------------------------------- DOM 骨架 */

  _build() {
    const cfg = this._cfg;
    const fill = !!cfg.fill_viewport && !this._inEditorPreview();
    this._fillViewport = fill;
    // 只保留地图本体：顶部标题栏与底部工具栏都已取消，
    // 操作入口全部浮在地图右下的控件列上（回到定位 / + / − / 列表），列表点开在后面展开。
    const cardTitle = String(cfg.title || '').trim();
    this._shadow.innerHTML = `
      <style>${ALC_STYLES}</style>
      <ha-card class="alc-root${fill ? ' alc-fill' : ''}"${cardTitle ? ` aria-label="${escapeHtml(cardTitle)}"` : ''}>
        <div class="alc-map-wrap"${fill ? '' : ` style="height:${cfg.height}px"`}>
          <div class="alc-map" id="alc-map"></div>
          <div class="alc-gesture" id="alc-gesture"></div>
          <div class="alc-ctrl" id="alc-ctrl">
            <button type="button" class="alc-fm-btn" data-act="recenter" aria-label="回到定位" title="回到定位">◎</button>
            <button type="button" class="alc-fm-btn" data-act="zoom-in" aria-label="放大" title="放大">+</button>
            <button type="button" class="alc-fm-btn" data-act="zoom-out" aria-label="缩小" title="缩小">−</button>
            <button type="button" class="alc-fm-btn alc-ctrl-list" data-act="list" aria-label="显示列表" title="显示列表">☰</button>
          </div>
          <div class="alc-status" id="alc-status"></div>
          <div class="alc-amap-pop" id="alc-amap-pop" hidden></div>
          <div class="alc-notices" id="alc-notices"></div>
          <div class="alc-loading" id="alc-loading" hidden>
            <span class="alc-spinner"></span><span id="alc-loading-text">加载中…</span>
          </div>
        </div>
        <div class="alc-list" id="alc-list" hidden>
          <div class="alc-list-head">
            <span class="alc-list-heading">附近结果<b class="alc-list-total" id="alc-list-total"></b></span>
            <button type="button" class="alc-btn" data-act="view"></button>
            <button type="button" class="alc-btn" data-act="refresh">刷新</button>
            <button type="button" class="alc-btn" data-act="list">收起</button>
          </div>
          <div class="alc-list-body" id="alc-list-body"></div>
        </div>
      </ha-card>`;

    this._els = {
      root: this._shadow.querySelector('.alc-root'),
      mapWrap: this._shadow.querySelector('.alc-map-wrap'),
      mapEl: this._shadow.querySelector('#alc-map'),
      notices: this._shadow.querySelector('#alc-notices'),
      loading: this._shadow.querySelector('#alc-loading'),
      loadingText: this._shadow.querySelector('#alc-loading-text'),
      ctrl: this._shadow.querySelector('#alc-ctrl'),
      status: this._shadow.querySelector('#alc-status'),
      list: this._shadow.querySelector('#alc-list'),
      listHead: this._shadow.querySelector('.alc-list-head'),
      listBody: this._shadow.querySelector('#alc-list-body'),
      listTotal: this._shadow.querySelector('#alc-list-total'),
      gesture: this._shadow.querySelector('#alc-gesture'),
      amapPop: this._shadow.querySelector('#alc-amap-pop'),
    };
    // 地图容器（高德 Map 与简化视图共用同一节点）
    this._mapEl = this._els.mapEl;
    this._built = true;

    // 高德底图手势接管 + 自绘控件列。
    // 原因：JSAPI 2.0 的拖拽/缩放管线依赖一个透明 iframe 盾，在 Shadow DOM 内该管线会断
    // （mousedown 后事件全部失踪，地图完全拖不动）—— 因此手势全部由卡片自己接管，
    // 只把渲染交给高德。详见 README「已知问题：JSAPI 2.0 × Shadow DOM」。
    // 控件列（回到定位 / + / − / 列表）的点击统一走下面的委托处理，两种底图共用。
    this._bindAmapGestures();
    this._applyCtrlVisibility();

    // 委托点击：兼容 InfoWindow / 列表 / 工具栏 / 简化视图弹窗
    this._onClick = (e) => this._handleDelegatedClick(e);
    this._shadow.addEventListener('click', this._onClick);

    // 网络恢复后自动重试加载底图（此时用户往往已经在简化视图里，不会主动点重试）
    if (!this._onOnline) {
      this._onOnline = () => {
        if (!this._cfg || this._mapMode === 'amap') return;
        // 只有「底图加载/渲染失败」才值得在联网后自动重试；未配置 Key 时重试没有意义
        const failed = ['jsapi', 'maperr', 'map-timeout', 'mapfail', 'tiles'].some((id) => this._notices.has(id));
        if (failed) {
          this._log('网络恢复 → 重新加载底图');
          this._retryMap();
        }
      };
      try { window.addEventListener('online', this._onOnline); } catch (e) { /* ignore */ }
    }

    // WebGL 上下文丢失：iOS App 从后台回来 / 内存紧张时最常见，画布还在但底图变白。
    // 事件不冒泡，但捕获阶段能在容器上收到。
    this._els.mapEl.addEventListener('webglcontextlost', () => {
      if (this._mapMode !== 'amap') return;
      this._log('WebGL 上下文丢失');
      this._showNotice('webgl-lost', 'warn',
        '地图渲染上下文丢失（iOS 从后台回来或内存紧张时常见），底图可能变空白。点「重试」重建地图即可恢复。',
        '重试', () => this._retryMap(),
        { label: '复制诊断', action: () => this._copyDiagnostics() });
    }, true);

    // App 切回前台：WKWebView 经常不重绘，这里补一次 resize；有失败提示时顺手重试一次
    if (!this._onVisible) {
      this._onVisible = () => {
        if (document.visibilityState !== 'visible' || !this._cfg) return;
        if (this._mapMode !== 'amap') return;
        this._resizeMap();
        const broken = ['webgl-lost', 'map-timeout', 'maperr'].some((id) => this._notices.has(id));
        if (broken) {
          this._log('回到前台且底图异常 → 重建地图');
          this._retryMap();
        }
      };
      try { document.addEventListener('visibilitychange', this._onVisible); } catch (e) { /* ignore */ }
    }

    this._renderNotices();
    this._renderStatus();

    // 铺满模式：按「可视高度 − 上下工具栏」定高，并在容器顶栏/底栏挂载得比较晚时补算两次
    // （HA 的移动端底部导航、App 原生 tab bar 通常比卡片晚一两帧才出现）
    if (fill) {
      this._syncFillHeight();
      requestAnimationFrame(() => { if (this._cfg) this._resizeMap(); });
      clearTimeout(this._fillTimer1);
      clearTimeout(this._fillTimer2);
      this._fillTimer1 = setTimeout(() => { if (this._cfg && this._fillViewport) this._resizeMap(); }, 350);
      this._fillTimer2 = setTimeout(() => { if (this._cfg && this._fillViewport) this._resizeMap(); }, 1200);

      if (!this._onViewportResize) {
        this._onViewportResize = () => this._scheduleFillSync();
        try {
          window.addEventListener('resize', this._onViewportResize);
          window.addEventListener('orientationchange', this._onViewportResize);
          if (window.visualViewport) window.visualViewport.addEventListener('resize', this._onViewportResize);
        } catch (e) { /* ignore */ }
      }
    }
  }

  refresh() { this._refresh(true); }

  /* --------------------------------------- 铺满高度：扣掉容器上下工具栏 */

  /**
   * 铺满模式的实际高度 = 可视高度 − 上方占位 − 下方遮挡。
   *
   * 为什么不能只用 CSS 的 `100dvh`：dvh 只知道浏览器自己的地址栏/工具栏，
   * 容器自己的顶栏（HA 顶栏、侧边栏头部）和底栏（HA 移动端底部导航、App 原生
   * tab bar 的占位）它一无所知。直接用 100dvh 会让卡片底部被底栏压住 ——
   * 右下角的「列表」按钮和展开后的列表正好躲在底栏下面，看不见也点不到。
   */
  _syncFillHeight() {
    const root = this._els && this._els.root;
    if (!root || !root.classList || !root.classList.contains('alc-fill')) return 0;
    if (this._fillSyncing) return this._fillH || 0;
    const vv = (typeof window !== 'undefined') ? window.visualViewport : null;
    const vh = Math.round((vv && vv.height) || window.innerHeight || 0);
    // 高度过小说明不是真的可视区（键盘弹出、卡片还在隐藏 Tab 里），先不动
    if (vh < 200) return 0;
    const rect = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
    if (!rect) return 0;

    // 卡片顶端到视口顶部的距离，正是上方被占掉的高度（顶栏与地址栏都在文档流里）
    const top = Math.max(0, Math.min(Math.round(rect.top), vh - 120));
    const max = Math.max(160, vh - top);

    this._fillSyncing = true;
    try {
      // 先撑到理论最大高度再探测：卡片已经让出过底栏时，底部露出的是页面背景
      // 而不是底栏，直接探测会测不到遮挡 —— 高度就再也长不回去（缩了就回不来）。
      root.style.setProperty('--alc-fill-h', `${max}px`);
      const gap = this._measureBottomGap(vh);
      const h = Math.max(160, max - gap);
      root.style.setProperty('--alc-fill-h', `${h}px`);
      this._fillH = h;
      this._fillGap = gap;
      return h;
    } finally {
      this._fillSyncing = false;
    }
  }

  /**
   * 底部被「贴底的固定/粘性层」压住的高度（HA 底部导航、App 原生 tab bar 占位、浏览器工具栏）。
   * 判据：视口底部中心点命中的元素，如果挂在视口底部且 position 为 fixed/sticky，
   * 它顶边到视口底的距离就是要让出的高度。取不到（jsdom、跨域 iframe）就返回 0。
   */
  _measureBottomGap(vh) {
    const host = this._shadow && this._shadow.host;
    if (!host || typeof document.elementFromPoint !== 'function') return 0;
    const x = Math.round((window.innerWidth || 0) / 2);
    if (!x) return 0;
    let node = null;
    try { node = document.elementFromPoint(x, vh - 2); } catch (e) { return 0; }
    if (!node) return 0;
    // 命中的是本卡片自己的内容（说明底部没有任何覆盖层）
    if (node === host) return 0;
    try { if (node.getRootNode && node.getRootNode() === this._shadow) return 0; } catch (e) { /* ignore */ }

    for (let i = 0; i < 8 && node; i++) {
      const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      if (r && r.height > 0 && r.bottom >= vh - 4) {
        let pos = '';
        try { pos = (window.getComputedStyle(node) || {}).position || ''; } catch (e) { pos = ''; }
        if (pos === 'fixed' || pos === 'sticky') {
          // 上限 40% 视口：真遇到怪异布局也不至于把地图压没
          return Math.max(0, Math.min(Math.round(vh - r.top), Math.round(vh * 0.4)));
        }
      }
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    return 0;
  }

  /** 视口尺寸变化（含 iOS 地址栏收起、旋转）：下一帧校准一次，连续变化只跑一遍 */
  _scheduleFillSync() {
    if (this._fillRaf) return;
    const raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
      ? window.requestAnimationFrame.bind(window)
      : (fn) => setTimeout(fn, 16);
    this._fillRaf = raf(() => {
      this._fillRaf = null;
      if (this._cfg) this._resizeMap();
    });
  }

  /* ------------------------------------------------------ 地图容器 */

  _resizeMap() {
    // 先校准铺满高度（视口 − 上下工具栏），再读容器尺寸 —— 顺序反了会拿到旧高度
    this._syncFillHeight();
    const wrap = this._els && this._els.mapWrap;
    const w = wrap ? wrap.clientWidth : 0;
    const h = wrap ? wrap.clientHeight : 0;
    const prev = this._wrapSize || { w: 0, h: 0 };
    this._wrapSize = { w, h };

    if (this._map) { try { this._map.resize(); } catch (e) { /* ignore */ } }
    if (this._fbMap) { try { this._fbMap.resize(); } catch (e) { /* ignore */ } }

    // 容器从「0 尺寸 / 不可见」变为有尺寸：HA App 恢复上次视图、从后台回来、
    // 卡片在隐藏 Tab 里创建，都走这条。高德在 0×0 容器上建图不会请求瓦片，
    // 单靠 map.resize() 补不回来，必须重新应用一次视野。
    const grew = (prev.w === 0 || prev.h === 0) && w > 0 && h > 0;
    if (grew && this._map && this._mapMode === 'amap') {
      this._log(`容器尺寸恢复（${prev.w}×${prev.h} → ${w}×${h}）→ 重新应用视野`);
      this._applyView(true);
      this._notices.delete('map-timeout');
      this._renderNotices();
    }
    if (this._mapMode) this._onViewportChanged();
  }

  /**
   * 底图空白自愈：先补一次 resize，再重新应用视野。
   * iOS App 的 WKWebView 在从后台恢复后常见「画布在、瓦片没了」，这一步能救回大部分情况。
   * 容器还没有尺寸时不做任何事 —— 那种情况由 _resizeMap 的「0 → 有尺寸」分支处理，
   * 否则会在卡片还没排版好时把用户的缩放级别重置掉。
   */
  _recoverBlankMap() {
    if (!this._map || this._mapMode !== 'amap') return;
    const wrap = this._els && this._els.mapWrap;
    const w = wrap ? wrap.clientWidth : 0;
    const h = wrap ? wrap.clientHeight : 0;
    if (w === 0 || h === 0) return;
    try { this._map.resize(); } catch (e) { /* ignore */ }
    this._viewInitialized = false;
    this._applyView(true);
  }

  /* ------------------------------------------------------ 搜索半径 */

  /** 自动半径取法：'cover'（外接，默认，覆盖整个可视矩形）| 'visible'（内切，只覆盖画面中间） */
  _radiusBasis() {
    return (this._cfg && this._cfg.auto_radius_basis === 'visible') ? 'visible' : 'cover';
  }

  /**
   * 高德地图可视范围半径（米）。
   *   cover  ：中心 → 最远角（外接圆），保证整个可视矩形都在检索范围内
   *   visible：中心 → 最近边（内切圆），只覆盖中间的一块
   */
  _viewportRadiusAMap() {
    const map = this._map;
    if (!map || typeof map.getBounds !== 'function') return null;
    try {
      const b = map.getBounds();
      const c = map.getCenter();
      if (!b || !c) return null;
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      if (!sw || !ne) return null;
      const cLng = toNum(c.getLng());
      const cLat = toNum(c.getLat());
      const neLng = toNum(ne.getLng());
      const neLat = toNum(ne.getLat());
      const swLng = toNum(sw.getLng());
      const swLat = toNum(sw.getLat());
      if (cLng === null || cLat === null || neLng === null || neLat === null) return null;

      if (this._radiusBasis() === 'cover') {
        const corners = [[swLng, swLat], [neLng, neLat]];
        let max = 0;
        corners.forEach(([lng, lat]) => {
          if (lng === null || lat === null) return;
          max = Math.max(max, haversine(cLat, cLng, lat, lng));
        });
        return max > 0 ? Math.round(max) : null;
      }
      // 内切：分别取「中心→东边中点」与「中心→北边中点」，取较小的一半
      const halfW = haversine(cLat, cLng, cLat, neLng);
      const halfH = haversine(cLat, cLng, neLat, cLng);
      const r = Math.min(halfW, halfH);
      return r > 0 ? Math.round(r) : null;
    } catch (e) {
      return null;
    }
  }

  /** 简化视图可视范围半径（米） */
  _viewportRadiusFallback() {
    if (!this._fbMap || typeof this._fbMap.viewportRadius !== 'function') return null;
    try { return this._fbMap.viewportRadius(this._radiusBasis()); } catch (e) { return null; }
  }

  /**
   * 当前实际生效的检索半径（米）。
   * auto：把「浏览者屏幕上的可视矩形」当成检索范围 —— 取能盖住整个矩形的外接半径，
   *       再用 auto_radius_pad 外扩、auto_radius_max 收敛。注意上限永远不会小于
   *       矩形本身，否则屏幕大 / 缩得远时四角就会搜不到。
   * fixed：始终使用配置里的 radius。
   */
  _currentRadius() {
    const cfg = this._cfg;
    if (!cfg) return 2000;
    if (cfg.radius_mode !== 'auto') return cfg.radius;
    const vp = (this._mapMode === 'amap' ? this._viewportRadiusAMap() : null)
      || this._viewportRadiusFallback();
    if (!vp) return cfg.radius;
    const cap = Math.max(cfg.auto_radius_max, vp);
    return clamp(Math.round(vp * cfg.auto_radius_pad), 100, Math.min(50000, cap));
  }

  /**
   * 检索基点（周边检索的 location 参数）。
   * auto 模式：跟随当前视野中心 —— 拖动地图后以新视野为基点重新搜索，
   *            结果天然落在可见范围内（内切圆半径以地图中心计算，两者自洽）。
   * fixed 模式：始终围绕实体坐标。
   */
  _searchCenter() {
    if (!this._cfg || this._cfg.radius_mode !== 'auto') return this._gcj;
    if (this._map && typeof this._map.getCenter === 'function') {
      try {
        const c = this._map.getCenter();   // 真实 AMap 返回不可变快照
        const lng = toNum(c.getLng ? c.getLng() : c.lng);
        const lat = toNum(c.getLat ? c.getLat() : c.lat);
        if (lng !== null && lat !== null) return { lng, lat };
      } catch (e) { /* 退回实体 */ }
    }
    if (this._fbMap && Array.isArray(this._fbMap.center) && this._fbMap.center.length >= 2) {
      const lng = toNum(this._fbMap.center[0]);
      const lat = toNum(this._fbMap.center[1]);
      if (lng !== null && lat !== null) return { lng, lat };
    }
    return this._gcj;
  }

  /** 两点平面近似距离（米），用于中心移动死区判定 */
  _centerDeltaMeters(a, b) {
    if (!a || !b || toNum(a.lng) === null || toNum(a.lat) === null || toNum(b.lng) === null || toNum(b.lat) === null) return Infinity;
    const dLat = (b.lat - a.lat) * 110540;
    const midLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * 111320 * Math.cos(midLat);
    return Math.hypot(dLng, dLat);
  }

  /* ------------------------------------------------- 结果是否在可视范围内 */

  /** 某个点当前是否落在可视矩形内 */
  _pinInView(p) {
    if (!p || toNum(p.lng) === null || toNum(p.lat) === null) return true;
    if (this._map && typeof this._map.getBounds === 'function') {
      try {
        const b = this._map.getBounds();
        if (b && typeof b.contains === 'function') return !!b.contains([p.lng, p.lat]);
        const sw = b.getSouthWest();
        const ne = b.getNorthEast();
        return p.lng >= toNum(sw.getLng()) && p.lng <= toNum(ne.getLng())
          && p.lat >= toNum(sw.getLat()) && p.lat <= toNum(ne.getLat());
      } catch (e) { return true; }
    }
    if (this._fbMap) {
      try {
        const q = this._fbMap.project(p.lng, p.lat);
        return q.x >= 0 && q.x <= this._fbMap._w && q.y >= 0 && q.y <= this._fbMap._h;
      } catch (e) { return true; }
    }
    return true;
  }

  /** 统计落在可视范围外的结果，并给出「铺满显示」一键入口 */
  _checkPinsVisible() {
    // auto 模式：检索范围就是当前视图，结果在 _fetchPois 里已剔除视口外的点；
    // 偶尔出画只是因为拖动的这几百毫秒里地图动了，松手后会自动重检索 —— 不值得提示。
    if (this._cfg && this._cfg.radius_mode === 'auto') {
      if (this._notices.delete('offscreen')) this._renderNotices();
      return;
    }
    const pois = (this._pins || []).filter((p) => p.kind !== 'entity');
    const out = pois.filter((p) => !this._pinInView(p));
    if (!out.length) {
      if (this._notices.delete('offscreen')) this._renderNotices();
      return;
    }
    this._notices.set('offscreen', {
      level: 'info',
      text: `有 ${out.length} 个结果落在当前视图之外，点「铺满显示」把它们放进画面。`,
      actionLabel: '铺满显示',
      action: () => this._fitAllPins(),
    });
    this._renderNotices();
  }

  /** 缩放/平移视野，让全部标记（含搜索半径圈）进入画面 */
  _fitAllPins() {
    if (!this._pins || !this._pins.length) return;
    // 这是程序化改视野：既不能算作「用户拖动」，也不该反过来触发按新视野重检索
    this._programmaticAt = Date.now();
    this._suppressViewportRefetch = true;
    clearTimeout(this._suppressTimer);
    // 结束后按铺满后的新视野补一次判定：基点（视野中心）变了就重新检索
    this._suppressTimer = setTimeout(() => { this._suppressViewportRefetch = false; this._onViewportChanged(); }, 1200);

    if (this._map && typeof this._map.setFitView === 'function') {
      try {
        const overlays = (this._markers || []).slice();
        if (this._radiusCircle) overlays.push(this._radiusCircle);
        this._map.setFitView(overlays.length ? overlays : null, false, [48, 48, 48, 48]);
      } catch (e) { /* 交给简化视图分支 */ }
    }
    if (this._fbMap) {
      const lngs = this._pins.map((p) => p.lng);
      const lats = this._pins.map((p) => p.lat);
      const minLng = Math.min(...lngs); const maxLng = Math.max(...lngs);
      const minLat = Math.min(...lats); const maxLat = Math.max(...lats);
      const cLng = (minLng + maxLng) / 2;
      const cLat = (minLat + maxLat) / 2;
      const wM = (maxLng - minLng) * 111320 * Math.cos(clamp(cLat, -85, 85) * Math.PI / 180);
      const hM = (maxLat - minLat) * 110540;
      const rM = (this._lastRadius || this._currentRadius()) * 2;
      const availW = Math.max(60, this._fbMap._w - 80);
      const availH = Math.max(60, this._fbMap._h - 80);
      let z = 19;
      for (; z > 3; z--) {
        const mpp = metersPerPixel(cLat, z);
        if (wM / mpp <= availW && hM / mpp <= availH && rM / mpp <= Math.min(availW, availH)) break;
      }
      this._fbMap.setCenter(cLng, cLat);
      this._fbMap.setZoom(z, true, true);
      this._fbMap.setFocus(this._gcj ? this._gcj.lng : null, this._gcj ? this._gcj.lat : null);
    }

    this._checkPinsVisible();
  }

  /** 可视化：高德地图上用 Circle 画，简化视图交给 canvas。圆心 = 检索基点（auto=视野中心，fixed=实体） */
  _syncRadiusCircle(radius) {
    const cfg = this._cfg;
    if (this._fbMap) this._fbMap.setRadius(cfg.show_radius_circle ? radius : 0);
    const sc = this._searchCenter();
    if (!sc) return;
    if (!this._map || !window.AMap) return;

    const show = !!cfg.show_radius_circle && toNum(radius) > 0;
    if (!show) {
      if (this._radiusCircle) {
        try { this._map.remove(this._radiusCircle); } catch (e) { /* ignore */ }
        this._radiusCircle = null;
      }
      return;
    }
    if (!this._radiusCircle) {
      try {
        this._radiusCircle = new window.AMap.Circle({
          center: [sc.lng, sc.lat],
          radius,
          strokeColor: '#03a9f4',
          strokeOpacity: 0.85,
          strokeWeight: 1.5,
          strokeStyle: 'dashed',
          fillColor: '#03a9f4',
          fillOpacity: 0.08,
          zIndex: 30,
          bubble: false,
        });
        this._map.add(this._radiusCircle);
      } catch (e) {
        this._radiusCircle = null;
        return;
      }
    }
    try {
      this._radiusCircle.setCenter([sc.lng, sc.lat]);
      this._radiusCircle.setRadius(radius);
    } catch (e) { /* ignore */ }
  }

  /**
   * 地图视野变化（缩放 / 拖动平移 / 容器尺寸）→ 自动模式下重新检索。
   * 防抖 600ms；半径变化不足 12% 且检索基点（视野中心）移动不足半径的 25%（至少 120 米）
   * 时只更新圈、不重新请求，避免拖动缩放时打爆配额。
   */
  _onViewportChanged() {
    this._placeAmapPopup();   // 弹窗跟锚点走，无论半径模式
    if (!this._cfg || this._cfg.radius_mode !== 'auto') return;
    if (this._suppressViewportRefetch) return;   // 「铺满显示」等程序化改视野期间不重检索
    const next = this._currentRadius();
    this._syncRadiusCircle(next);
    const prev = this._lastRadius;
    if (prev === null) return;                       // 首次检索还没跑，等它自己带上正确半径
    // 拖动平移：检索基点跟着视野中心走，移动超过半径的 25%（至少 120 米）才重新请求
    const nextC = this._searchCenter();
    const moved = !this._lastCenter
      || this._centerDeltaMeters(this._lastCenter, nextC) > Math.max(120, prev * 0.25);
    if (Math.abs(next - prev) / prev < 0.12 && !moved) return;

    clearTimeout(this._radiusTimer);
    this._radiusTimer = setTimeout(() => {
      this._radiusTimer = null;
      if (!this._cfg || this._cfg.radius_mode !== 'auto') return;
      const r = this._currentRadius();
      const c = this._searchCenter();
      const centerSame = this._lastCenter
        && this._centerDeltaMeters(this._lastCenter, c) <= Math.max(120, r * 0.25);
      if (r === this._lastRadius && centerSame) return;
      this._syncRadiusCircle(r);
      this._renderStatus();
      if (this._api) this._api.clearPoiCache();   // 基点或半径变了，旧结果不再适用
      this._fetchPois();
    }, 600);
  }

  _initialCenter() {
    const cfg = this._cfg;
    if (cfg.view_mode === 'locked') {
      const c = parseLngLat(cfg.locked_center);
      if (c) return c;
    }
    if (this._gcj) return [this._gcj.lng, this._gcj.lat];
    return [116.397428, 39.90923];
  }

  async _ensureMap() {
    if (this._mapMode) return this._mapMode;
    const cfg = this._cfg;
    const mock = alcMock();
    const jsKey = String(cfg.amap_js_key || '').trim() || String(cfg.amap_key || '').trim();
    const canJs = !!jsKey && !(mock && mock.noJsApi);
    // WebGL 探测结果只做诊断记录，**不再决定要不要加载底图**：
    // HA iOS App 的 WKWebView 可能误报 false（见 amapLoader.hasWebGL 注释），
    // 一旦据此提前降级，用户看到的就是「iOS App 没有底图，Safari 正常」。
    // 现在一律先真的去加载，真不支持时高德会自己报错，我们再降级并给可操作提示。
    this._webglProbe = alcMock() ? !(mock && mock.noJsApi) : amapLoader.hasWebGL();
    this._log(`底图准备：key=${jsKey ? '有' : '无'} webgl=${this._webglProbe} ua=${navigator.userAgent}`);

    if (canJs) {
      try {
        this._showLoading('正在加载高德地图…');
        const AMap = await amapLoader.load({
          key: jsKey,
          securityJsCode: cfg.security_js_code,
          plugins: ALC_JS_API_PLUGINS,
        });
        // _createAMap 失败时会自行降级为简化视图并置 _mapMode='fallback'，
        // 这里不能无条件覆盖成 'amap'，否则地图实际是画布、状态却报「高德底图」
        const built = this._createAMap(AMap);
        this._hideLoading();
        if (built) this._mapMode = 'amap';
        return this._mapMode;
      } catch (e) {
        this._hideLoading();
        // 失败原因做一次域名探测，把「网络不通」和「脚本被拦」区分开，提示才可操作
        const why = await diagnoseJsApiFailure(e);
        const glHint = this._webglProbe ? '' : '（另：本设备 WebGL 探测未通过，若为 iOS 应用内可能误报，点「重试」可再试一次）';
        this._showNotice('jsapi', 'warn',
          `${e.message}，已切换为简化视图，点位与列表功能不受影响。${why}${glHint}`, '重试', () => this._retryMap(),
          { label: '复制诊断', action: () => this._copyDiagnostics() });
      }
    } else if (!jsKey) {
      this._showNotice('nokey', 'warn',
        '未配置高德 Key，地图底图无法加载，当前为简化视图。请在配置面板中填入 Key（一个 Key 同时用于底图、坐标转换与周边检索）。');
    }

    this._createFallbackMap();
    this._mapMode = 'fallback';
    return this._mapMode;
  }

  _createAMap(AMap) {
    const cfg = this._cfg;
    this._mapEl.innerHTML = '';
    const center = this._initialCenter();
    // 手势事件由卡片的 .alc-gesture 层接管，这里按手势策略设置它的 touch-action
    this._els.gesture.style.touchAction = cfg.gesture === 'map' ? 'none' : 'pan-y';
    this._closeAmapPopup();
    this._markerIndex = new Map();   // 新地图实例：旧 Marker 已随旧图销毁，索引必须重建

    try {
      // 交互全部由 .alc-gesture 手势层接管（用户输入根本到不了高德内部 DOM），
      // 因此这里保持 drag/zoom 开启 —— 实测 zoomEnable:false 会连带禁掉程序化
      // setZoom / setFitView 的缩放（AMap 2.0 的内部耦合），绝不能关。
      // 只关滚轮与双击，避免万一事件穿透时和手势层双重触发。
      this._map = new AMap.Map(this._mapEl, {
        viewMode: '2D',
        zoom: cfg.view_mode === 'locked' ? cfg.locked_zoom : cfg.follow_zoom,
        center,
        zooms: [3, 19],
        mapStyle: cfg.map_style || 'amap://styles/normal',
        resizeEnable: true,
        showLabel: true,
        rotateEnable: false,
        pitchEnable: false,
        dragEnable: true,
        zoomEnable: true,
        doubleClickZoom: false,
        scrollWheel: false,
        keyboardEnable: false,
        jogEnable: false,
        features: ['bg', 'road', 'building', 'point'],
      });
    } catch (e) {
      // 注意：此时 loading 遮罩还挂着，必须收掉，否则会一直显示「正在加载高德地图…」
      this._hideLoading();
      const msg = (e && e.message) || '未知错误';
      let hint = '';
      if (/SCODE/i.test(msg)) {
        hint = '（安全密钥缺失或不正确：请在「高级：多 Key 与安全密钥」里填入控制台的 securityJsCode）';
      } else if (/USER_KEY|INVALID_USER/i.test(msg)) {
        hint = '（该 Key 可能不是「Web 端(JS API)」类型，可在高德控制台确认）';
      } else if (/webgl/i.test(msg) || /WebGL/i.test(msg)) {
        hint = '（该 WebView 未启用 WebGL。iOS 上多见于 App 内嵌浏览器，可换 Safari 打开，或在 iOS 设置里关闭「低电量模式」后重试）';
      }
      this._showNotice('mapfail', 'error', `地图初始化失败：${msg}${hint}`, '重试', () => this._retryMap(),
        { label: '复制诊断', action: () => this._copyDiagnostics() });
      this._createFallbackMap();
      this._mapMode = 'fallback';
      return false;
    }

    this._mapReady = false;
    this._map.on('complete', () => {
      this._mapReady = true;
      this._hideLoading();
      clearTimeout(this._mapTimeout);
      this._notices.delete('map-timeout');
      this._renderNotices();
      this._resizeMap();
    });
    this._map.on('error', (err) => {
      const msg = (err && err.message) || '未知错误';
      let keyHint = '';
      if (/SCODE/i.test(msg)) {
        keyHint = '（安全密钥缺失或不正确：请在「高级：多 Key 与安全密钥」里填入控制台的 securityJsCode）';
      } else if (/USER_KEY|INVALID_USER/i.test(msg)) {
        keyHint = '（该 Key 可能不是「Web 端(JS API)」类型，可在高德控制台确认；周边检索与坐标转换不受影响）';
      }
      this._showNotice('maperr', 'warn', `地图渲染异常：${msg}${keyHint}，可点击「重试」重建地图。`, '重试', () => this._retryMap(),
        { label: '复制诊断', action: () => this._copyDiagnostics() });
    });
    // 「自动跟随 / 回到定位」这类程序化改视野同样会触发 zoomstart/zoomend。
    // 若无条件记成用户操作，自动跟随会被自己关掉 15 秒 —— 必须放过这段窗口。
    this._programmaticAt = 0;
    const markUser = () => {
      if (Date.now() - this._programmaticAt > 800) this._userPannedAt = Date.now();
      this._renderStatus();
    };
    this._map.on('dragstart', () => { this._userPannedAt = Date.now(); this._renderStatus(); });
    this._map.on('zoomstart', markUser);
    // 缩放结束 → 自动模式下按新的可视范围重算半径并重新检索
    this._map.on('zoomend', () => { markUser(); this._onViewportChanged(); });

    clearTimeout(this._mapTimeout);
    this._mapTimeout = setTimeout(() => {
      if (this._mapReady) return;
      // App 内嵌 WebView（iOS）里偶发：卡片初始尺寸为 0 或 WebGL 上下文被回收，
      // 高德不会发瓦片请求。先补一次 resize + 重新应用视野，很多时候一补就恢复。
      this._recoverBlankMap();
      if (this._mapReady) return;
      // 再给 3 秒：真的起不来就不要让用户盯着白板了，直接换成瓦片底图（同一套高德瓦片）
      clearTimeout(this._mapTimeout2);
      this._mapTimeout2 = setTimeout(() => {
        if (!this._mapReady) this._switchToTilesMap();
      }, 3000);
    }, 12000);

    if (cfg.show_toolbar && AMap.plugin) {
      try {
        AMap.plugin(['AMap.Scale'], () => {
          if (!this._map) return;
          try {
            if (cfg.show_scale) this._map.addControl(new AMap.Scale());
          } catch (e) { /* 控件失败不影响主流程 */ }
        });
      } catch (e) { /* ignore */ }
    }
    // 缩放按钮自绘（高德 ToolBar 在 Shadow DOM 下收不到点击）
    this._applyCtrlVisibility();
    return true;
  }

  /** show_toolbar=false 时只留「列表」按钮，缩放与回到定位整条隐藏 */
  _applyCtrlVisibility() {
    if (!this._els || !this._els.ctrl) return;
    const on = !this._cfg || this._cfg.show_toolbar !== false;
    this._els.ctrl.querySelectorAll('[data-act="recenter"], [data-act="zoom-in"], [data-act="zoom-out"]')
      .forEach((b) => { b.hidden = !on; });
  }

  /* ------------------------------- 高德底图手势接管（拖拽 / 缩放 / 点选） */

  /**
   * 在 .alc-gesture 层接管全部手势，只把渲染交给高德：
   * · 单指/鼠标拖拽 → map.setCenter（用 containerToLngLat 精确反算，无漂移）
   * · 双指捏合 → map.setZoom
   * · 滚轮 → map.setZoom
   * · 轻点 → 就近命中标记（lngLatToContainer 像素距离），开弹窗；点空白收弹窗
   * 在 _build() 里绑定一次；处理函数实时读 this._map，重建地图无需重绑。
   */
  _bindAmapGestures() {
    const layer = this._els.gesture;
    if (!layer || this._gesturesBound) return;
    this._gesturesBound = true;
    const pointers = new Map();
    let pan = null;        // {x, y, center} 拖拽起点
    let pinch = null;      // {dist, zoom} 捏合起点
    let downAt = 0;
    let movedFar = false;
    const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    layer.addEventListener('pointerdown', (e) => {
      if (!this._map || this._mapMode !== 'amap') return;
      try { layer.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        pan = { x: e.clientX, y: e.clientY, center: this._map.getCenter() };
        downAt = Date.now();
        movedFar = false;
      } else if (pointers.size === 2) {
        pan = null;
        downAt = 0;                      // 捉合后不再判定为轻点
        movedFar = true;
        const pts = [...pointers.values()];
        pinch = { dist: dist2(pts[0], pts[1]), zoom: toNum(this._map.getZoom()) || 16 };
      }
      e.preventDefault();
    });

    layer.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId) || !this._map) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2 && pinch) {
        const pts = [...pointers.values()];
        const d = dist2(pts[0], pts[1]);
        if (pinch.dist > 0 && d > 0) {
          const z = clamp(pinch.zoom + Math.log2(d / pinch.dist), 3, 19);
          // 锚定在双指中点缩放：手指按住的地理位置在缩放前后不动。
          // 绕地图中心缩放会让指下的内容滑走，用户看到的就是「点在乱跑」。
          const wrap = this._els.mapWrap.getBoundingClientRect();
          const mid = {
            x: (pts[0].x + pts[1].x) / 2 - wrap.left,
            y: (pts[0].y + pts[1].y) / 2 - wrap.top,
          };
          this._amapZoomAround(mid, z);
        }
        return;
      }
      if (!pan) return;
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (!movedFar && Math.hypot(dx, dy) > 5) movedFar = true;
      try {
        const c0 = this._map.lngLatToContainer(pan.center);
        if (c0) {
          const next = this._map.containerToLngLat([c0.x - dx, c0.y - dy]);
          // 立即生效：拖拽要 1:1 跟手，动画平移会滞后/橡皮筋
          if (next) this._map.setCenter(next, true);
        }
      } catch (err) { /* ignore */ }
      this._userPannedAt = Date.now();
      this._placeAmapPopup();
    });

    const endPointer = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      try { layer.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (pointers.size === 0) {
        if (pinch) {
          pinch = null;
          this._userPannedAt = Date.now();
          this._onViewportChanged();      // 捏合结束 → 自动半径重算
          return;
        }
        if (pan) {
          pan = null;
          const dt = Date.now() - downAt;
          if (!movedFar && downAt && dt < 600) this._amapTap(e.clientX, e.clientY);
          else {
            this._userPannedAt = Date.now();
            this._onViewportChanged();    // 平移结束 → 自动半径重算
          }
          downAt = 0;
        }
      } else if (pointers.size === 1) {
        pinch = null;
        const p = [...pointers.values()][0];
        pan = { x: p.x, y: p.y, center: this._map ? this._map.getCenter() : null };
        movedFar = true;
      }
    };
    layer.addEventListener('pointerup', endPointer);
    layer.addEventListener('pointercancel', endPointer);

    layer.addEventListener('wheel', (e) => {
      if (!this._map || this._mapMode !== 'amap') return;
      e.preventDefault();
      const z = clamp((toNum(this._map.getZoom()) || 16) + (e.deltaY < 0 ? 1 : -1), 3, 19);
      // 锚定光标缩放（对齐高德原生滚轮行为），立即生效不排队动画
      const wrap = this._els.mapWrap.getBoundingClientRect();
      this._amapZoomAround({ x: e.clientX - wrap.left, y: e.clientY - wrap.top }, z);
      this._userPannedAt = Date.now();
    }, { passive: false });

    layer.addEventListener('dblclick', (e) => {
      if (!this._map || this._mapMode !== 'amap') return;
      e.preventDefault();
      this._map.setZoom(clamp((toNum(this._map.getZoom()) || 16) + 1, 3, 19), true);
    });
  }

  /**
   * 以容器内的某个像素点为锚缩放：缩放前后锚点指的地理位置不动。
   *
   * ⚠️ 两个「立即生效」缺一不可（AMap 2.0 实测）：
   * 1. setZoom(zoom, immediately)：immediately=false 是「带动画」——手势中逐帧调用
   *    会排队一堆互相打断的动画，iOS Safari 上被中断的动画会让标记层与瓦片层脱节；
   * 2. setCenter(center, immediately)：不带第二参的 setCenter 是**动画平移**，
   *    连续锚定缩放时上一次的平移动画会被下一次打断，中心停在半路 → 锚点漂移几十像素。
   *   （实测：setCenter(c) 450ms 后才到位；setCenter(c, true) 瞬时。）
   */
  _amapZoomAround(mid, z) {
    const map = this._map;
    if (!map || !this._els || !this._els.mapWrap) return;
    // 锚点坐标不完整（如合成事件缺 clientX）就退化为按中心缩放，别让 NaN 进投影
    if (!mid || !Number.isFinite(mid.x) || !Number.isFinite(mid.y)) {
      try { map.setZoom(z, true); } catch (err) { /* ignore */ }
      return;
    }
    try {
      const anchor = map.containerToLngLat([mid.x, mid.y]);
      map.setZoom(z, true);
      if (!anchor) return;
      const q = map.lngLatToContainer(anchor);
      if (!q) return;
      const dx = mid.x - q.x;
      const dy = mid.y - q.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;   // 锚点没动就别抖中心
      const w = this._els.mapWrap.clientWidth || 0;
      const h = this._els.mapWrap.clientHeight || 0;
      const c = map.containerToLngLat([w / 2 - dx, h / 2 - dy]);
      if (c) map.setCenter(c, true);
    } catch (err) { /* ignore */ }
  }

  /** 轻点命中：把点击位置换算成容器像素，就近找标记（阈值 = 标记半径 + 6px） */
  _amapTap(clientX, clientY) {
    if (!this._map || !this._els || !this._els.mapWrap) return;
    const wrap = this._els.mapWrap.getBoundingClientRect();
    const x = clientX - wrap.left;
    const y = clientY - wrap.top;
    let best = null;
    let bestD = Infinity;
    (this._pins || []).forEach((p) => {
      let q = null;
      try { q = this._map.lngLatToContainer([p.lng, p.lat]); } catch (err) { /* ignore */ }
      if (!q) return;
      const d = Math.hypot(q.x - x, q.y - y);
      const hit = Math.max(18, (toNum(p.size) || 34) / 2 + 6);
      if (d <= hit && d < bestD) { best = p; bestD = d; }
    });
    if (best) this._onPinClick(best);
    else this._closeAmapPopup();   // 点空白收弹窗（对齐高德 closeWhenClickMap）
  }

  /** 高德底图分支的自绘弹窗（InfoWindow 在 Shadow DOM 下收不到点击，弃用） */
  _showAmapPopup(pin, html) {
    const el = this._els && this._els.amapPop;
    if (!el || !this._map) return;
    this._activePopupPin = pin;
    el.innerHTML = html
      + '<button type="button" class="alc-popup-close" data-alc-act="close" aria-label="关闭">×</button>';
    el.hidden = false;
    this._placeAmapPopup();
  }

  /** 弹窗跟随锚点：视野变了就重算位置，错出画面就收起 */
  _placeAmapPopup() {
    const el = this._els && this._els.amapPop;
    const pin = this._activePopupPin;
    if (!el || el.hidden || !pin || !this._map || !this._els.mapWrap) return;
    let q = null;
    try { q = this._map.lngLatToContainer([pin.lng, pin.lat]); } catch (err) { /* ignore */ }
    if (!q) return;
    const w = this._els.mapWrap.clientWidth || 0;
    const h = this._els.mapWrap.clientHeight || 0;
    // 容器尚无布局（宽高为 0，如 jsdom / 初始帧）时跳过出界判断
    if (w > 0 && h > 0 && (q.x < -30 || q.x > w + 30 || q.y < -30 || q.y > h + 30)) {
      this._closeAmapPopup();
      return;
    }
    const pw = el.offsetWidth || 240;
    const ph = el.offsetHeight || 130;
    const left = w > 0 ? clamp(q.x, pw / 2 + 6, Math.max(pw / 2 + 6, w - pw / 2 - 6)) : q.x;
    const size = toNum(pin.size) || 34;
    let top = q.y - size / 2 - 8;
    const below = top - ph < 4;          // 上方放不下 → 翻到标记下方
    if (below) top = q.y + size / 2 + 8;
    el.classList.toggle('below', below);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  _closeAmapPopup() {
    this._activePopupPin = null;
    const el = this._els && this._els.amapPop;
    if (el) { el.hidden = true; el.innerHTML = ''; }
  }

  /**
   * 标记重建后同步弹窗（缩放/移动触发重检索 → _renderPins 会换掉整批 pin 对象）：
   * · 同一 POI（id 相同）→ 弹窗换绑到新 pin 并重渲染内容（距离等随新数据刷新）；
   * · POI 已不在结果里（半径缩小后被挤出）→ 收起弹窗。
   * 否则弹窗会锚在一个已被丢弃的旧 pin 对象上，内容与图上的点对不上。
   */
  _rebindAmapPopup(pins) {
    const old = this._activePopupPin;
    if (!old) return;
    const sameId = (a, b) => {
      if (a.kind !== b.kind) return false;
      if (a.kind === 'entity') return true;
      const ai = a.data && a.data.item;
      const bi = b.data && b.data.item;
      return !!(ai && bi && ai.poi && bi.poi && String(ai.poi.id) === String(bi.poi.id));
    };
    const next = (pins || []).find((p) => sameId(p, old));
    if (!next) { this._closeAmapPopup(); return; }
    if (next !== old) {
      const html = next.kind === 'entity'
        ? this._sourcePopupHtml()
        : this._poiPopupHtml(next.data.item);
      this._showAmapPopup(next, html);
      return;
    }
    this._placeAmapPopup();
  }

  _createFallbackMap() {
    if (this._fbMap) return;
    this._mapEl.innerHTML = '';
    this._mapEl.style.touchAction = 'none';
    const center = this._initialCenter();
    this._fbMap = new CanvasFallbackMap(this._mapEl, {
      controls: false,   // 控件列由卡片统一提供（地图右下角），避免两套按钮重叠
      tiles: this._cfg.fallback_tiles !== false,   // 没有 JS API 也铺真实高德瓦片
      zoom: this._cfg.view_mode === 'locked' ? this._cfg.locked_zoom : this._cfg.follow_zoom,
      centerLng: center[0],
      centerLat: center[1],
      focusLng: this._gcj ? this._gcj.lng : null,
      focusLat: this._gcj ? this._gcj.lat : null,
      radius: this._cfg.show_radius_circle ? this._currentRadius() : 0,
      onMarkerClick: (data) => this._onPinClick(data),
      onViewChange: () => { this._userPannedAt = Date.now(); this._renderStatus(); this._onViewportChanged(); },
      onZoom: () => this._onViewportChanged(),
    });
    this._fbMap._recenterRequest = () => this._applyView(true);
    this._renderPins();
  }

  _retryMap() {
    this._teardownMap();
    this._notices.delete('jsapi');
    this._notices.delete('webgl');
    this._notices.delete('map-timeout');
    this._notices.delete('maperr');
    this._notices.delete('mapfail');
    this._notices.delete('tiles');
    this._renderNotices();
    this._mapMode = null;
    this._refresh(true);
  }

  /**
   * 高德 JS 底图迟迟渲染不出瓦片（App 内嵌 WKWebView 上最常见：WebGL 被限制、
   * 高德内部 canvas 起不来）→ 自动换成瓦片底图。
   * 换的是同一套高德栅格瓦片，只是绕过 JS API 直接画在 canvas 上，
   * 所以「空白」会立刻变成真实地图，点位/列表/检索全都不受影响。
   */
  _switchToTilesMap() {
    if (!this._cfg || this._mapMode === 'fallback') return;
    this._log('高德 JS 底图未就绪 → 自动换成瓦片底图');
    this._teardownMap();
    this._createFallbackMap();
    this._mapMode = 'fallback';
    this._showNotice('tiles', 'warn',
      '当前环境里高德 JS 底图没能渲染出瓦片（App 内嵌浏览器常见），已自动换成瓦片底图，地图与点位照常可用。',
      '重试高清底图', () => this._retryMap(),
      { label: '复制诊断', action: () => this._copyDiagnostics() });
    this._renderPins();
    this._resizeMap();
  }

  _teardownMap() {
    clearTimeout(this._mapTimeout);
    clearTimeout(this._mapTimeout2);
    clearTimeout(this._radiusTimer);
    clearTimeout(this._suppressTimer);
    this._radiusTimer = null;
    this._suppressTimer = null;
    this._suppressViewportRefetch = false;
    this._programmaticAt = 0;
    this._radiusCircle = null;
    this._lastRadius = null;
    this._lastCenter = null;
    if (this._map) { try { this._map.clearMap(); this._map.destroy(); } catch (e) { /* ignore */ } this._map = null; }
    if (this._fbMap) { try { this._fbMap.destroy(); } catch (e) { /* ignore */ } this._fbMap = null; }
    this._markers = [];
    this._pins = [];
    this._mapReady = false;
    this._mapMode = null;
    if (this._els && this._els.mapEl) this._els.mapEl.innerHTML = '';
  }

  _teardownAll() {
    this._teardownMap();
    clearTimeout(this._trailing);
    clearTimeout(this._mapTimeout);
    clearTimeout(this._listResizeTimer);
    clearTimeout(this._fillTimer1);
    clearTimeout(this._fillTimer2);
    if (this._fillRaf) {
      try { (window.cancelAnimationFrame || clearTimeout)(this._fillRaf); } catch (e) { /* ignore */ }
      this._fillRaf = null;
    }
    if (this._onViewportResize) {
      try {
        window.removeEventListener('resize', this._onViewportResize);
        window.removeEventListener('orientationchange', this._onViewportResize);
        if (window.visualViewport) window.visualViewport.removeEventListener('resize', this._onViewportResize);
      } catch (e) { /* ignore */ }
      this._onViewportResize = null;
    }
    if (this._onClick && this._shadow) { this._shadow.removeEventListener('click', this._onClick); this._onClick = null; }
    if (this._onOnline) {
      try { window.removeEventListener('online', this._onOnline); } catch (e) { /* ignore */ }
      this._onOnline = null;
    }
    if (this._onVisible) {
      try { document.removeEventListener('visibilitychange', this._onVisible); } catch (e) { /* ignore */ }
      this._onVisible = null;
    }
  }

  /* -------------------------------------------------------- 刷新流程 */

  _maybeUpdateMap(force = false) {
    const loc = this._loc;
    if (!loc) return;
    const coordKey = `${loc.lat.toFixed(5)},${loc.lon.toFixed(5)}`;
    const now = Date.now();
    const interval = (this._cfg.refresh_interval || 0) * 1000;
    const changed = coordKey !== this._lastCoordKey;

    if (force || !this._mapMode || (changed && now - this._lastRefresh >= interval)) {
      this._refresh(force);
      return;
    }
    if (changed) {
      clearTimeout(this._trailing);
      this._trailing = setTimeout(() => this._refresh(false), Math.max(150, this._lastRefresh + interval - now));
    }
  }

  async _refresh(force) {
    if (!this._loc) return;
    if (this._busy) { this._queued = true; return; }
    this._busy = true;
    const loc = this._loc;
    this._lastRefresh = Date.now();
    this._lastCoordKey = `${loc.lat.toFixed(5)},${loc.lon.toFixed(5)}`;

    try {
      const cfg = this._cfg;
      const jsKey = String(cfg.amap_js_key || '').trim() || String(cfg.amap_key || '').trim();

      // 1) 坐标转换（强制高德 Web 服务，失败自动降级）。
      //    coord_sys=gcj02 时实体坐标已是高德坐标系，直接采用 —— 再转换会二次偏移约 500 米。
      if (String(cfg.coord_sys) === 'gcj02') {
        this._gcj = { lng: loc.lon, lat: loc.lat };
        this._convertVia = 'direct';
        this._notices.delete('convert');
        this._renderStatus();
      } else {
        const conv = await convertToGcj02({
          api: this._api,
          wgsLng: loc.lon,
          wgsLat: loc.lat,
          jsKey,
          force: !!force,
        });
        this._gcj = { lng: conv.lng, lat: conv.lat };
        this._convertVia = conv.via;
        if (conv.notice) this._showNotice('convert', 'warn', conv.notice, '重试', () => this._refresh(true));
        else this._notices.delete('convert');
        this._renderStatus();
      }

      // 2) 地图实例
      await this._ensureMap();

      // 3) 源实体标记 + 视图
      this._showSourceMarker();
      this._applyView(false);

      // 4) 周边检索
      await this._fetchPois();
    } catch (e) {
      this._showNotice('refresh', 'error', `刷新失败：${e.message || e}`, '重试', () => this._refresh(true));
    } finally {
      this._busy = false;
      this._hideLoading();
      if (this._queued) { this._queued = false; this._refresh(false); }
    }
  }

  async _fetchPois() {
    const cfg = this._cfg;
    if (!this._gcj) return;
    if (!cfg.amap_key) {
      this._poiGroups = [];
      this._showNotice('nokey-web', 'warn',
        '未配置高德 Key，周边检索（充电桩 / 公共厕所）不可用。请在配置面板中填入 Key。');
      this._renderPins();
      this._renderList();
      return;
    }
    this._notices.delete('nokey-web');

    const defs = [];
    if (cfg.show_charging) defs.push({ kind: 'charging', label: '充电桩', types: cfg.charging_type, icon: cfg.icon_charging });
    if (cfg.show_toilet) defs.push({ kind: 'toilet', label: '公共厕所', types: cfg.toilet_type, icon: cfg.icon_toilet });

    if (!defs.length) {
      this._poiGroups = [];
      this._renderPins();
      this._renderList();
      return;
    }

    // 检索全程不显示任何 loading / 遮罩：拖动、缩放触发的重检索要「无感」，
    // 旧数据一直留在图上，新结果回来再原地更新（见 _renderPins 的增量重建）。
    const center = this._searchCenter();    // auto：视野中心（拖动后跟随新视野）；fixed：实体
    const radius = this._currentRadius();   // auto 模式下 = 覆盖整张视图所需的外接半径
    const errors = [];

    /* auto 模式：检索范围就是「这整张地图」。
       高德周边检索只支持圆形，外接圆是可视矩形的超集，圆内四角方向会多出一批
       落在画面外的点 —— 这里直接剔掉，让渲染结果精确等于「视图内搜到的 POI」。
       这样既覆盖了整个视图（不画圈也不漏点），又不会有点跑到地图框外面。
       fixed 模式是用户指定的固定半径，不做裁剪，只保留原有兜底。 */
    const clipToView = cfg.radius_mode === 'auto';

    const groups = await Promise.all(defs.map(async (d) => {
      try {
        const pois = await this._api.placeAround({
          lng: center.lng, lat: center.lat,
          types: d.types,
          radius,
          offset: 25,                          // 取满一页，裁掉视口外的点后仍能贴住 max_poi
        });
        const items = pois
          .map((p) => buildPoiView(p, { kind: d.kind, icon: d.icon, center, cfg }))
          .filter((it) => !clipToView || this._pinInView({ lng: it.poi.lng, lat: it.poi.lat }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, cfg.max_poi);
        return Object.assign({}, d, { items, error: null });
      } catch (e) {
        errors.push(`${d.label}检索失败：${e.message}`);
        return Object.assign({}, d, { items: [], error: e.message });
      }
    }));

    this._poiGroups = groups;
    this._lastRadius = radius;
    this._lastCenter = { lng: center.lng, lat: center.lat };
    this._syncRadiusCircle(radius);

    if (errors.length) {
      this._showNotice('poi', 'warn', errors.join('；'), '重试', () => this._refresh(true));
    } else {
      this._notices.delete('poi');
    }

    // 搜不到时保持安静：不弹提示条、不改标题，地图上只留实体点（用户明确要求）
    this._notices.delete('poi-empty');

    this._renderPins();
    this._checkPinsVisible();   // 结果跑出可视范围时给出「铺满显示」入口
    this._renderList();
    this._renderStatus();
    this._renderNotices();
  }

  /* ------------------------------------------------------ 标记渲染 */

  _pinHtml(icon, size, kind) {
    return `<div class="alc-pin alc-pin-${kind}" style="width:${size}px;height:${size}px">${iconHtml(icon, size)}</div>`;
  }

  _showSourceMarker() {
    // 首次加载时先把实体位置画出来，避免等周边检索返回才有视觉反馈；
    // 后续刷新由 _fetchPois 末尾统一重建，避免无谓的标记重复创建
    if (this._pins.length === 0) this._renderPins();
  }

  _clearPins() {
    this._pins = [];
    if (this._map) { try { this._map.remove(this._markers); } catch (e) { /* ignore */ } }
    this._markers = [];
    this._markerIndex = new Map();
    if (this._fbMap) this._fbMap.setMarkers([]);
    if (this._notices) this._notices.delete('offscreen');
    this._activePinData = null;
    this._closeAmapPopup();
  }

  _renderPins() {
    const cfg = this._cfg;
    const pins = [];
    const size = cfg.icon_size;

    if (cfg.show_source_marker && this._gcj) {
      pins.push({
        kind: 'entity',
        icon: cfg.icon_entity,
        size,
        lng: this._gcj.lng,
        lat: this._gcj.lat,
        data: { kind: 'entity' },
        title: this._entityName(),
      });
    }

    (this._poiGroups || []).forEach((g) => {
      (g.items || []).forEach((item) => {
        pins.push({
          kind: item.kind,
          icon: item.icon,
          size: Math.round(size * 0.86),
          // 高德返回的坐标已是 GCJ-02，直接用；再纠偏会偏 ~500 米
          lng: item.poi.lng,
          lat: item.poi.lat,
          data: { kind: item.kind, item },
          title: item.poi.name,
        });
      });
    });

    this._pins = pins;
    this._rebindAmapPopup(pins);
    // 注意：AMap 脚本可能已被卸载/清空（例如加载失败后重试、或页面回收），
    // 此时不能假定 window.AMap 还在，否则一次刷新就整卡抛错。
    const AMap = (typeof window !== 'undefined') ? window.AMap : null;
    if (this._map && AMap && typeof AMap.Marker === 'function') {
      /* 增量更新：同一个 POI 复用已有 Marker，只补新增、删消失的。
         整批 remove + add 会让标记整体闪一下 —— 拖动后的自动重检索就「跳」，
         所以这里按 key 做 diff，让拖动重搜真正无感。 */
      const prev = (this._markerIndex instanceof Map) ? this._markerIndex : new Map();
      const next = new Map();
      const added = [];
      pins.forEach((p) => {
        const poiId = (p.data && p.data.item && p.data.item.poi && p.data.item.poi.id) || `${p.lng},${p.lat}`;
        const key = p.kind === 'entity' ? 'entity' : `${p.kind}:${poiId}`;
        let marker = prev.get(key);
        if (marker) {
          prev.delete(key);
          try { marker.setPosition([p.lng, p.lat]); } catch (e) { /* ignore */ }
        } else {
          marker = new AMap.Marker({
            position: [p.lng, p.lat],
            content: this._pinHtml(p.icon, p.size, p.kind),
            offset: new AMap.Pixel(-p.size / 2, -p.size / 2),
            zIndex: p.kind === 'entity' ? 200 : 100,
            clickable: true,
            extData: p,
          });
          marker.on('click', () => { /* 点击由手势层命中处理（见 _amapTap） */ });
          added.push(marker);
        }
        next.set(key, marker);
      });
      const removed = Array.from(prev.values());
      if (removed.length) { try { this._map.remove(removed); } catch (e) { /* ignore */ } }
      if (added.length) this._map.add(added);
      this._markerIndex = next;
      this._markers = Array.from(next.values());
    }

    if (this._fbMap) {
      // 定位点同步给画布：十字准星与半径圈都跟着实体走，而不是钉在画布中心
      if (this._gcj) this._fbMap.setFocus(this._gcj.lng, this._gcj.lat);
      this._fbMap.setRadius(cfg.show_radius_circle ? (this._lastRadius || this._currentRadius()) : 0);
      this._fbMap.setMarkers(pins.map((p) => ({
        kind: p.kind,
        lng: p.lng,
        lat: p.lat,
        html: this._pinHtml(p.icon, p.size, p.kind),
        data: p,
      })));
    }
  }

  _applyView(animate) {
    if (!this._gcj) return;
    const cfg = this._cfg;
    const mode = this._viewOverride || cfg.view_mode;

    if (mode === 'locked') {
      if (this._map && !this._viewInitialized) {
        const c = parseLngLat(cfg.locked_center);
        if (c) this._map.setZoomAndCenter(cfg.locked_zoom, c);
      }
      this._viewInitialized = true;
      return;
    }
    // 用户刚手动操作过 → 暂停自动跟随，避免抢镜头
    if (!animate && Date.now() - this._userPannedAt < 15000) return;

    if (this._map) {
      this._programmaticAt = Date.now();   // 让 zoomend 知道这次不是用户干的
      this._map.setZoomAndCenter(cfg.follow_zoom, [this._gcj.lng, this._gcj.lat], false, animate ? 400 : 0);
    }
    if (this._fbMap) {
      this._fbMap.setCenter(this._gcj.lng, this._gcj.lat);
      this._fbMap.setFocus(this._gcj.lng, this._gcj.lat);
      if (!this._viewInitialized) this._fbMap.setZoom(cfg.follow_zoom, true, true);
    }
    this._viewInitialized = true;
  }

  /* -------------------------------------------------------- 弹窗内容 */

  _entityName() {
    const st = this._hass && this._hass.states ? this._hass.states[this._cfg.entity] : null;
    return (st && st.attributes && st.attributes.friendly_name) || this._cfg.entity;
  }

  _sourcePopupHtml() {
    const loc = this._loc;
    const g = this._gcj;
    const navUrl = buildNavigationUrl({
      toLng: g.lng, toLat: g.lat, toName: '当前位置',
    });
    return `
      <div class="alc-pop">
        <div class="alc-pop-head">
          <span class="alc-pop-icon">${iconHtml(this._cfg.icon_entity, 24)}</span>
          <span class="alc-pop-name">${escapeHtml(this._entityName())}</span>
        </div>
        <div class="alc-pop-row"><span class="k">状态</span><span class="v">${escapeHtml(loc.state || '—')}</span></div>
        <div class="alc-pop-row"><span class="k">坐标</span><span class="v mono">${g.lng.toFixed(5)}, ${g.lat.toFixed(5)}</span></div>
        ${loc.accuracy !== null && loc.accuracy !== undefined
          ? `<div class="alc-pop-row"><span class="k">精度</span><span class="v">±${Math.round(loc.accuracy)} m</span></div>` : ''}
        <div class="alc-pop-row"><span class="k">纠偏</span><span class="v">${this._convertViaLabel()}</span></div>
        <div class="alc-pop-actions">
          <button type="button" class="alc-pop-btn primary" data-alc-act="open-url" data-url="${escapeHtml(navUrl)}">高德导航</button>
          <button type="button" class="alc-pop-btn" data-alc-act="close">关闭</button>
        </div>
      </div>`;
  }

  _convertViaLabel() {
    const map = { web: '高德 Web 服务', jsapi: '高德 JS API（降级）', raw: '未纠偏（WGS84）', mock: 'Mock', direct: '已是高德坐标（未转换）' };
    return map[this._convertVia] || '—';
  }

  _poiPopupHtml(item) {
    const cfg = this._cfg;
    const poi = item.poi;
    const g = this._gcj;
    const navUrl = buildNavigationUrl({
      fromLng: g ? g.lng : null, fromLat: g ? g.lat : null, fromName: g ? '当前位置' : null,
      toLng: poi.lng, toLat: poi.lat, toName: poi.name,
    });
    const markerUrl = buildMarkerUrl({ lng: poi.lng, lat: poi.lat, name: poi.name });

    let rows = `<div class="alc-pop-row"><span class="k">距离</span><span class="v">${formatDistance(item.distance)}</span></div>`;

    if (item.kind === 'charging') {
      if (cfg.show_charging_price) {
        const p = formatPrice(item.price);
        rows += `<div class="alc-pop-row"><span class="k">电价</span><span class="v ${p ? '' : 'dim'}">${p ? escapeHtml(p) : '暂无数据'}</span></div>`;
      }
      if (cfg.show_charging_available) {
        const a = formatAvailable(item.available, item.total);
        rows += `<div class="alc-pop-row"><span class="k">可用桩</span><span class="v ${a ? '' : 'dim'}">${a ? escapeHtml(a) : '暂无数据'}</span></div>`;
      }
    }

    const addr = poi.address ? `<div class="alc-pop-addr">${escapeHtml(poi.address)}</div>` : '';
    const noPriceHint = (item.kind === 'charging' && cfg.show_charging_price && !formatPrice(item.price))
      ? '<div class="alc-pop-hint">高德 POI 未提供电价字段，可在配置中用「电价字段映射」指定自定义字段。</div>'
      : '';

    return `
      <div class="alc-pop">
        <div class="alc-pop-head">
          <span class="alc-pop-icon">${iconHtml(item.icon, 24)}</span>
          <span class="alc-pop-name">${escapeHtml(poi.name)}</span>
        </div>
        ${rows}
        ${addr}
        ${noPriceHint}
        <div class="alc-pop-actions">
          <button type="button" class="alc-pop-btn primary" data-alc-act="open-url" data-url="${escapeHtml(navUrl)}">高德导航</button>
          <button type="button" class="alc-pop-btn" data-alc-act="open-url" data-url="${escapeHtml(markerUrl)}">地图标注</button>
          <button type="button" class="alc-pop-btn" data-alc-act="close">关闭</button>
        </div>
      </div>`;
  }

  _onPinClick(pin) {
    const cfg = this._cfg;
    this._activePinData = pin;
    const navTarget = pin.kind === 'entity'
      ? { toLng: this._gcj.lng, toLat: this._gcj.lat, toName: '当前位置' }
      : { toLng: pin.data.item.poi.lng, toLat: pin.data.item.poi.lat, toName: pin.data.item.poi.name };

    if (cfg.click_action === 'navigate') {
      openExternal(buildNavigationUrl(navTarget), cfg.open_in_new_tab);
      return;
    }
    const html = pin.kind === 'entity' ? this._sourcePopupHtml() : this._poiPopupHtml(pin.data.item);
    this._openPopup(pin, html);
  }

  _openPopup(pin, html) {
    if (this._map) {
      this._showAmapPopup(pin, html);
    } else if (this._fbMap) {
      this._fbMap.openPopup({ lng: pin.lng, lat: pin.lat, popupHtml: html });
    }
  }

  /* ------------------------------------------------------ 交互事件 */

  _handleDelegatedClick(e) {
    const btn = e.target.closest && e.target.closest('button[data-alc-act], button[data-act], [data-alc-focus]');
    if (!btn) return;
    const act = btn.dataset.alcAct;
    const toolbarAct = btn.dataset.act;

    if (act === 'open-url') {
      e.preventDefault();
      openExternal(btn.dataset.url, this._cfg.open_in_new_tab);
      return;
    }
    if (act === 'close') {
      e.preventDefault();
      this._closeAmapPopup();
      if (this._fbMap) this._fbMap.closePopup();
      return;
    }
    if (act === 'list-nav' || act === 'list-focus') {
      e.preventDefault();
      const pin = this._pins.find((p) => p.data && p.data.item && String(p.data.item.poi.id) === btn.dataset.poiId);
      if (!pin) return;
      if (act === 'list-nav') {
        openExternal(buildNavigationUrl({
          fromLng: this._gcj ? this._gcj.lng : null, fromLat: this._gcj ? this._gcj.lat : null, fromName: '当前位置',
          toLng: pin.lng, toLat: pin.lat, toName: pin.data.item.poi.name,
        }), this._cfg.open_in_new_tab);
      } else {
        this._focusPin(pin);
      }
      return;
    }

    if (toolbarAct === 'zoom-in' || toolbarAct === 'zoom-out') {
      const dz = toolbarAct === 'zoom-in' ? 1 : -1;
      if (this._map && this._mapMode === 'amap') {
        const z = clamp(toNum(this._map.getZoom()) || 16, 3, 19);
        // 立即生效：连续快点 +/− 时排队的动画缩放会在 iOS 上把标记层打乱
        this._map.setZoom(clamp(z + dz, 3, 19), true);
      } else if (this._fbMap) {
        this._fbMap.setZoom(this._fbMap.zoom + dz);
      }
      return;
    }
    if (toolbarAct === 'refresh') { if (this._api) this._api.clearCache(); this._refresh(true); return; }
    if (toolbarAct === 'recenter') { this._applyView(true); return; }
    if (toolbarAct === 'view') {
      const mode = this._viewOverride || this._cfg.view_mode;
      this._viewOverride = mode === 'follow' ? 'locked' : 'follow';
      this._viewInitialized = false;
      this._applyView(true);
      this._renderStatus();
      return;
    }
    if (toolbarAct === 'list') { this._showList(!this._listOpen); return; }

    const focus = btn.dataset.alcFocus;
    if (focus) {
      const pin = this._pins.find((p) => p.data && p.data.item && String(p.data.item.poi.id) === focus);
      if (pin) this._focusPin(pin);
    }
  }

  _focusPin(pin) {
    if (this._map) {
      this._map.setZoomAndCenter(Math.max(17, (this._cfg.follow_zoom || 16)), [pin.lng, pin.lat]);
    } else if (this._fbMap) {
      this._fbMap.setCenter(pin.lng, pin.lat);
      this._fbMap.setZoom(17);
    }
    this._onPinClick(pin);
  }

  /** 展开 / 收起列表：列表在地图下方展开（铺满窗口时地图自动让出高度） */
  _showList(open) {
    this._listOpen = !!open;
    this._els.list.hidden = !open;
    if (open) this._renderList();
    this._renderStatus();
    // 展开列表会改变地图高度 → 触发一次视野变化。这里只重排画布、不按新视野重新检索：
    // 否则刚展开的列表会被「变小后的可见矩形」当场裁掉一半。
    this._suppressViewportRefetch = true;
    clearTimeout(this._listResizeTimer);
    this._resizeMap();
    this._listResizeTimer = setTimeout(() => { this._suppressViewportRefetch = false; }, 1200);
  }

  /* -------------------------------------------------------- 渲染 UI */

  /** 调试输出：仅当 show_debug 打开时打印（与 AmapWebApi._log 保持一致的前缀） */
  _log(...args) {
    if (!this._cfg || !this._cfg.show_debug) return;
    try { console.debug('[amap-location-card]', ...args); } catch (e) { /* ignore */ }
  }

  /** 是否跑在 iOS/安卓 App 的 WKWebView 里（诊断用，不参与任何渲染决策） */
  _isInAppWebView() {
    try {
      const ua = navigator.userAgent || '';
      if (/Home Assistant/i.test(ua)) return true;
      const w = window.webkit;
      return !!(w && w.messageHandlers && w.messageHandlers.externalBus);   // HA Companion App 的桥
    } catch (e) { return false; }
  }

  /**
   * 一键诊断文本。iOS App 里没有开发者工具，底图不显示时靠这段文本判断原因：
   * 是否 WKWebView、WebGL 有没有、容器尺寸是不是 0、脚本/Key 走哪条路、错误码是什么。
   */
  _diagText() {
    const cfg = this._cfg || {};
    const jsKey = String(cfg.amap_js_key || '').trim() || String(cfg.amap_key || '').trim();
    const wrap = this._els && this._els.mapWrap;
    const r = wrap && wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
    const canvas = this._mapEl ? this._mapEl.querySelectorAll('canvas') : [];
    const notices = Array.from((this._notices || new Map()).entries())
      .map(([id, n]) => `  · ${id}: ${n.text}`).join('\n') || '  · (无)';
    return [
      `amap-location-card v${ALC_VERSION}`,
      `时间：${new Date().toISOString()}`,
      `UA：${navigator.userAgent}`,
      `环境：${this._isInAppWebView() ? 'HA App / 内嵌 WebView' : '浏览器'}`,
      `屏幕：${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio || 1}x`,
      `卡片容器：${r ? `${Math.round(r.width)}×${Math.round(r.height)}` : '未知'}`,
      `地图模式：${this._mapMode || '未创建'} · 地图就绪：${this._mapReady ? '是' : '否'} · canvas 数：${canvas.length}`,
      `WebGL 探测：${this._webglProbe === undefined ? '未执行' : (this._webglProbe ? '通过' : '未通过')}`,
      `WebGL 渲染器：${amapLoader.webglInfo()}`,
      `Key：${jsKey ? `${jsKey.slice(0, 6)}…（${jsKey.length} 位，来源 ${String(cfg.amap_js_key || '').trim() ? 'amap_js_key' : 'amap_key'}）` : '未配置'}`,
      `安全密钥：${String(cfg.security_js_code || '').trim() ? '已配置' : '未配置'}`,
      `JS API：v${AMAP_JS_VERSION} · ${AMAP_JS_API_BASE}`,
      `视野：${this._rgcjForDiag()}`,
      `提示条：\n${notices}`,
    ].join('\n');
  }

  _rgcjForDiag() {
    try {
      if (this._map && this._map.getCenter) {
        const c = this._map.getCenter();
        return `center ${Number(c.getLng()).toFixed(5)},${Number(c.getLat()).toFixed(5)} zoom ${this._map.getZoom()}`;
      }
      if (this._fbMap) return `fallback zoom ${this._fbMap.zoom}`;
    } catch (e) { /* ignore */ }
    return '未知';
  }

  /** 把诊断信息复制到剪贴板（iOS WKWebView 里 navigator.clipboard 可能被拒 → 退回 execCommand） */
  async _copyDiagnostics() {
    const text = this._diagText();
    try { console.warn('[amap-location-card] 诊断信息\n' + text); } catch (e) { /* ignore */ }
    const done = () => this._showNotice('diag', 'info', '诊断信息已复制，可直接粘贴给开发者排查。');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        done();
        return;
      }
    } catch (e) { /* 落到下面的兜底 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand && document.execCommand('copy');
      if (ta.parentNode) ta.parentNode.removeChild(ta);
      if (ok) { done(); return; }
    } catch (e) { /* ignore */ }
    // 都失败：至少把内容打到控制台，并提示长度
    this._showNotice('diag', 'warn', `无法写入剪贴板，诊断信息已输出到浏览器控制台（${text.length} 字符）。`);
  }

  _showNotice(id, level, text, actionLabel, action, extra) {
    const existing = this._notices.get(id);
    if (existing && existing.text === text && existing.level === level) return;
    this._notices.set(id, { level, text, actionLabel, action, extra });
    this._renderNotices();
  }

  _renderNotices() {
    if (!this._els || !this._els.notices) return;
    const items = Array.from(this._notices.entries());
    this._noticeActions = this._noticeActions || new Map();
    this._els.notices.innerHTML = items.map(([id, n]) => `
      <div class="alc-notice alc-notice-${n.level}" data-notice="${escapeHtml(id)}">
        <span class="alc-notice-text">${escapeHtml(n.text)}</span>
        ${n.actionLabel ? `<button type="button" class="alc-notice-btn" data-notice-act="${escapeHtml(id)}">${escapeHtml(n.actionLabel)}</button>` : ''}
        ${n.extra && n.extra.label ? `<button type="button" class="alc-notice-btn ghost" data-notice-extra="${escapeHtml(id)}">${escapeHtml(n.extra.label)}</button>` : ''}
        <button type="button" class="alc-notice-x" data-notice-close="${escapeHtml(id)}" aria-label="关闭">×</button>
      </div>`).join('');

    this._els.notices.querySelectorAll('[data-notice-close]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._notices.delete(b.dataset.noticeClose);
        this._renderNotices();
      });
    });
    this._els.notices.querySelectorAll('[data-notice-act]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const n = this._notices.get(b.dataset.noticeAct);
        if (n && typeof n.action === 'function') n.action();
      });
    });
    this._els.notices.querySelectorAll('[data-notice-extra]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const n = this._notices.get(b.dataset.noticeExtra);
        if (n && n.extra && typeof n.extra.action === 'function') n.extra.action();
      });
    });
  }

  /**
   * 状态信息：坐标 / 坐标系判定 / 搜索范围 / 刷新时间。
   * 顶部标题栏已取消，这些信息收进地图左上角的一枚半透明小标签（不挡操作、不占高度）。
   */
  _renderStatus() {
    if (!this._els || !this._els.status) return;
    const cfg = this._cfg;
    const mode = this._viewOverride || cfg.view_mode;
    const paused = mode === 'follow' && Date.now() - this._userPannedAt < 15000;

    // 跟随切换按钮住在展开后的列表头部（顶部工具栏已取消，避免地图上再堆一排按钮）
    const viewBtn = this._els.listHead && this._els.listHead.querySelector('[data-act="view"]');
    if (viewBtn) viewBtn.textContent = paused ? '恢复跟随' : (mode === 'follow' ? '跟随中' : '已锁定');

    const listBtn = this._els.ctrl && this._els.ctrl.querySelector('[data-act="list"]');
    if (listBtn) {
      const label = this._listOpen ? '收起列表' : '显示列表';
      listBtn.setAttribute('aria-label', label);
      listBtn.setAttribute('title', label);
      listBtn.classList.toggle('on', !!this._listOpen);
    }
    const headBtn = this._els.listHead && this._els.listHead.querySelector('[data-act="list"]');
    if (headBtn) headBtn.textContent = '收起';

    const bits = [];
    if (this._gcj) bits.push(`${this._gcj.lng.toFixed(4)}, ${this._gcj.lat.toFixed(4)}`);
    bits.push(this._convertViaLabel());
    const r = this._lastRadius || this._currentRadius();
    if (cfg.radius_mode === 'auto') {
      // auto = 把屏幕可视矩形当检索范围（外接半径 + 视口裁剪，等价于矩形检索）
      const how = this._radiusBasis() === 'cover' ? '整屏矩形' : '内切圆';
      bits.push(`${how} · 约 ${r} m`);
    } else {
      bits.push(`半径 ${r} m`);
    }
    if (this._lastRefresh) {
      const d = new Date(this._lastRefresh);
      bits.push(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`);
    }
    if (cfg.show_debug && this._api) {
      bits.push(`请求 ${this._api.stats.request} / 命中 ${this._api.stats.cacheHit} / 失败 ${this._api.stats.error}`);
    }
    const text = bits.join(' · ');
    this._els.status.textContent = text;
    this._els.status.title = text;
    this._els.status.hidden = !text;
  }

  _renderList() {
    if (!this._els || !this._els.listBody) return;
    const cfg = this._cfg;
    const groups = this._poiGroups || [];
    const total = groups.reduce((s, g) => s + g.items.length, 0);
    if (this._els.listTotal) this._els.listTotal.textContent = total ? String(total) : '';
    if (!groups.length) {
      this._els.listBody.innerHTML = '<div class="alc-empty">暂无检索结果</div>';
      return;
    }
    this._els.listBody.innerHTML = groups.map((g) => {
      if (!g.items.length) {
        return `<div class="alc-list-group">
          <div class="alc-list-title">${iconHtml(g.icon, 18)}<span>${escapeHtml(g.label)}</span></div>
          <div class="alc-empty">${g.error ? escapeHtml(g.error) : '半径内没有结果'}</div>
        </div>`;
      }
      const rows = g.items.map((item) => {
        const meta = [];
        meta.push(`<span class="alc-meta-dist">${formatDistance(item.distance)}</span>`);
        if (item.kind === 'charging' && cfg.show_charging_price) {
          const p = formatPrice(item.price);
          meta.push(`<span class="alc-meta-chip ${p ? '' : 'dim'}">电价 ${p ? escapeHtml(p) : '暂无'}</span>`);
        }
        if (item.kind === 'charging' && cfg.show_charging_available) {
          const a = formatAvailable(item.available, item.total);
          meta.push(`<span class="alc-meta-chip ${a ? '' : 'dim'}">可用 ${a ? escapeHtml(a) : '暂无'}</span>`);
        }
        return `<div class="alc-item" data-alc-focus="${escapeHtml(item.poi.id)}" role="button" tabindex="0">
          <span class="alc-item-icon">${iconHtml(item.icon, 22)}</span>
          <span class="alc-item-main">
            <span class="alc-item-name">${escapeHtml(item.poi.name)}</span>
            <span class="alc-item-meta">${meta.join('')}</span>
            ${item.poi.address ? `<span class="alc-item-addr">${escapeHtml(item.poi.address)}</span>` : ''}
          </span>
          <span class="alc-item-actions">
            <button type="button" class="alc-mini-btn" data-alc-act="list-focus" data-poi-id="${escapeHtml(item.poi.id)}">定位</button>
            <button type="button" class="alc-mini-btn primary" data-alc-act="list-nav" data-poi-id="${escapeHtml(item.poi.id)}">导航</button>
          </span>
        </div>`;
      }).join('');
      return `<div class="alc-list-group">
        <div class="alc-list-title">${iconHtml(g.icon, 18)}<span>${escapeHtml(g.label)}</span><span class="alc-list-count">${g.items.length}</span></div>
        ${rows}
      </div>`;
    }).join('');
  }

  _showLoading(text) {
    if (!this._els || !this._els.loading) return;
    this._els.loading.hidden = false;
    if (text && this._els.loadingText) this._els.loadingText.textContent = text;
  }

  _hideLoading() {
    if (!this._els || !this._els.loading) return;
    this._els.loading.hidden = true;
  }
}

/* =============================================================================
 *  12. 可视化配置编辑器（HA 原生样式）
 * ============================================================================= */

const ALC_EDITOR_SECTIONS = [
  {
    title: '基础设置', open: true,
    fields: [
      { key: 'entity', label: '定位实体', type: 'entity', hint: '需自带 latitude / longitude 属性（手机、Teslamate 等，默认按 WGS-84 处理）' },
      { key: 'coord_sys', label: '实体坐标系', type: 'select', options: [
        ['wgs84', 'WGS-84 / GPS（默认 · 走高德纠偏）'],
        ['gcj02', 'GCJ-02 / 高德坐标（不纠偏，直接用）'],
      ], hint: '坐标来自 GPS 模块、HA Companion App 等 → 选 WGS-84；来自高德/腾讯等国内 App 上报（本身已是高德坐标）→ 必须选 GCJ-02，否则所有点会在高德底图上整体偏移约 300~600 米' },
      { key: 'title', label: '卡片标题（无障碍标签）', type: 'text', hint: '顶部标题栏已取消；这里只作为读屏/悬浮提示用的名称，留空则用实体名称' },
      { key: 'height', label: '地图高度（px）', type: 'number', min: 120, max: 1200, dependsOn: { fill_viewport: false }, hint: '仅在关闭「铺满窗口」时生效' },
      { key: 'fill_viewport', label: '铺满浏览器窗口', type: 'boolean', hint: '开：高度 = 可视高度 − 上方顶栏/地址栏 − 下方底栏/工具栏（HA 底部导航、App tab bar 都算在内），配置编辑器的预览不会铺满；关：使用上面的固定高度' },
      { key: 'view_mode', label: '视图模式', type: 'select', options: [['follow', '自动跟随实体居中'], ['locked', '手动锁定视图']] },
      { key: 'follow_zoom', label: '跟随缩放级别', type: 'number', min: 3, max: 19, dependsOn: { view_mode: 'follow' } },
      { key: 'locked_center', label: '锁定中心（经度,纬度）', type: 'text', dependsOn: { view_mode: 'locked' }, placeholder: '116.397428,39.90923' },
      { key: 'locked_zoom', label: '锁定缩放级别', type: 'number', min: 3, max: 19, dependsOn: { view_mode: 'locked' } },
    ],
  },
  {
    title: '高德 Key（只需一个）', open: false,
    fields: [
      { key: 'amap_key', label: '高德 Key', type: 'password', hint: '一个 Key 同时用于坐标转换、周边检索与地图底图。请在高德控制台为该 Key 配置调用量限制与域名白名单。' },
    ],
  },
  {
    title: '高级：多 Key 与安全密钥（通常留空）', open: false,
    fields: [
      { key: 'amap_js_key', label: '单独指定地图 Key', type: 'password', hint: '仅当想把「Web 端(JS API)」Key 与「Web 服务」Key 分开使用时才填；留空则复用上面的 Key。' },
      { key: 'security_js_code', label: '安全密钥 securityJsCode', type: 'password', hint: '仅当底图加载报 INVALID_USER_SCODE（2021-12-02 之后申请且已开启安全密钥的 JS API Key）时才需要填。仅存于本机配置。' },
    ],
  },
  {
    title: '周边检索', open: false,
    fields: [
      { key: 'radius_mode', label: '搜索范围', type: 'select', options: [['auto', '自动 · 整张地图的可视范围'], ['fixed', '固定半径']], hint: '自动模式按当前地图可视范围检索，缩放/拖动后自动重搜' },
      { key: 'radius', label: '固定搜索半径（米）', type: 'number', min: 50, max: 50000, dependsOn: { radius_mode: 'fixed' } },
      { key: 'auto_radius_basis', label: '自动范围取法', type: 'select', dependsOn: { radius_mode: 'auto' }, options: [
        ['cover', '覆盖整个视图（默认 · 视野内不漏点）'],
        ['visible', '只覆盖画面中间（内切圆）'],
      ], hint: '默认 cover：用能盖住整张地图的外接半径去搜，再把视口外的结果剔掉 —— 地图上看得到的 POI 一定能搜到，地图上也不会出现框外的点。visible 只搜画面中心的一块（宽屏时两侧会漏）。' },
      { key: 'auto_radius_pad', label: '自动范围系数', type: 'number', min: 0.2, max: 4, step: 0.1, dependsOn: { radius_mode: 'auto' }, hint: '1.0 = 恰好盖住整张地图；小于 1 收紧（四角可能漏），大于 1 向外多搜一圈' },
      { key: 'auto_radius_max', label: '自动范围上限（米）', type: 'number', min: 100, max: 50000, step: 100, dependsOn: { radius_mode: 'auto' }, hint: '地图缩得很远时避免检索范围撑得过大，默认 5000；缩到很小时四角可能覆盖不到' },
      { key: 'show_charging', label: '显示充电桩', type: 'boolean', hint: '周边搜索 types=011100（充电设施）' },
      { key: 'charging_type', label: '充电桩 POI 类型码', type: 'text', dependsOn: { show_charging: true }, placeholder: '011100' },
      { key: 'show_charging_price', label: '充电桩弹窗显示电价', type: 'boolean', dependsOn: { show_charging: true } },
      { key: 'show_charging_available', label: '充电桩弹窗显示可用桩数', type: 'boolean', dependsOn: { show_charging: true } },
      { key: 'show_toilet', label: '显示公共厕所', type: 'boolean', hint: '周边搜索 types=140306（公共厕所）' },
      { key: 'toilet_type', label: '公共厕所 POI 类型码', type: 'text', dependsOn: { show_toilet: true }, placeholder: '140306' },
      { key: 'max_poi', label: '每类最多显示（1-25）', type: 'number', min: 1, max: 25 },
      { key: 'show_radius_circle', label: '显示搜索半径圈', type: 'boolean', hint: '默认关闭。检索范围本来就是整张地图的可视区域，不需要额外画圈。' },
    ],
  },
  {
    title: '图标与外观', open: false,
    fields: [
      { key: 'icon_entity', label: '实体图标', type: 'text', hint: '支持 mdi:crosshairs-gps、图片 URL、/local/xxx.png 或 emoji' },
      { key: 'icon_charging', label: '充电桩图标', type: 'text', hint: '默认 mdi:ev-station' },
      { key: 'icon_toilet', label: '公共厕所图标', type: 'text', hint: '默认 mdi:human-male-female' },
      { key: 'icon_size', label: '图标尺寸（px）', type: 'number', min: 16, max: 96 },
      { key: 'map_style', label: '高德地图样式', type: 'select', options: [
        ['amap://styles/normal', '标准'], ['amap://styles/whitesmoke', '远山黛'],
        ['amap://styles/darkblue', '幻影黑'], ['amap://styles/light', '雅士灰'],
        ['amap://styles/fresh', '草色青'], ['amap://styles/grey', '涂鸦'],
        ['amap://styles/graffiti', '涂鸦'], ['amap://styles/macaron', '马卡龙'],
      ] },
      { key: 'show_source_marker', label: '显示实体主图标', type: 'boolean' },
      { key: 'fallback_tiles', label: '无底图时用瓦片兜底', type: 'boolean', hint: '高德 JS 底图渲染不出来时（App 内嵌浏览器常见）自动改用同一套高德栅格瓦片，永不见白板；关掉则只在网格上显示点位' },
      { key: 'show_toolbar', label: '显示缩放 / 回到定位按钮', type: 'boolean', hint: '关闭后地图右下角只留「列表」按钮' },
      { key: 'show_scale', label: '显示比例尺', type: 'boolean', dependsOn: { show_toolbar: true } },
      { key: 'click_action', label: '点击标记行为', type: 'select', options: [['popup', '弹出信息窗'], ['navigate', '直接唤起高德导航']] },
      { key: 'open_in_new_tab', label: '外部链接在新标签打开', type: 'boolean' },
      { key: 'show_list', label: '默认展开附近列表', type: 'boolean' },
    ],
  },
  {
    title: '性能 / 容错 / 兼容', open: false,
    fields: [
      { key: 'coord_cache_ttl', label: '坐标转换缓存（秒）', type: 'number', min: 0, max: 86400, hint: '同一坐标在该时长内不重复请求转换接口，默认 300（5 分钟）' },
      { key: 'poi_cache_ttl', label: '周边检索缓存（秒）', type: 'number', min: 0, max: 86400, hint: '默认 300' },
      { key: 'api_min_interval', label: '请求最小间隔（毫秒）', type: 'number', min: 0, max: 5000, hint: '节流防抖，避免触发高德 QPS 限流，默认 400' },
      { key: 'refresh_interval', label: '实体刷新最小间隔（秒）', type: 'number', min: 0, max: 3600, hint: '实体持续移动时，最少间隔多久重新转换坐标与检索，默认 60' },
      { key: 'gesture', label: '地图手势策略', type: 'select', options: [['map', '地图优先（推荐，防止 iOS 手势异常）'], ['scroll', '页面滚动优先']], hint: 'iOS Safari 上建议「地图优先」' },
      { key: 'show_debug', label: '在状态栏显示调试统计', type: 'boolean' },
      { key: 'price_fields', label: '电价字段映射', type: 'text', hint: '逗号分隔的字段路径，按顺序探测 biz_ext。留空使用内置候选。' },
      { key: 'available_fields', label: '可用桩数字段映射', type: 'text' },
      { key: 'total_fields', label: '总桩数字段映射', type: 'text' },
    ],
  },
];

class AmapLocationCardEditor extends HTMLElement {
  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._built = false;
    this._pendingUpgrade = false;
    this._builtSig = null;        // 本次渲染时用的控件能力签名（见 _ensureUpgrade）
    this._upgradeWait = 2500;     // 等原生控件注册的上限；测试会调小
    this._blurHooked = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    else {
      this._applyHass();
      // 原生控件可能比卡片晚注册：hass 是天然的心跳，顺手复查一次（同签名立即返回，无副作用）
      this._ensureUpgrade();
    }
  }
  get hass() { return this._hass; }

  setConfig(config) {
    this._config = Object.assign({}, ALC_DEFAULTS, config || {});
    if (!this._built) this._build();
    else this._sync();
  }

  _applyHass() {
    this._shadow.querySelectorAll('ha-entity-picker').forEach((el) => { el.hass = this._hass; });
  }

  _has(tag) { return typeof customElements !== 'undefined' && !!customElements.get(tag); }

  /** 组件能力签名：ha-textfield / ha-entity-picker 是否已注册（11 = 都齐了） */
  _capSig() {
    return `${this._has('ha-textfield') ? 1 : 0}${this._has('ha-entity-picker') ? 1 : 0}`;
  }

  /** 焦点是否停在编辑器内部：重建 DOM 会打断输入，此时必须推迟 */
  _focusInside() {
    const ae = this._shadow && this._shadow.activeElement;
    return !!(ae && ae !== this._shadow);
  }

  /**
   * HA 的原生控件是按需注册的：刚打开配置面板时 ha-textfield / ha-entity-picker
   * 可能还没定义，只能用原生 input/select 顶上；等组件到位后再升级成原生控件。
   *
   * ⚠️ 这里踩过一个致命坑（2026-10-18 用户反馈「配置时页面定时重置」）：
   * 旧实现是「只要 textfield 或 entity-picker 任一存在 → 重建」，
   * 而 HA 里 ha-textfield 必然存在、ha-entity-picker 往往迟迟不注册，
   * 于是 _build() → _ensureUpgrade() → 2.5s 后重建 → 再 _ensureUpgrade() …… 无限循环，
   * 表现就是配置面板每 2.5 秒整体重建一次：输入框失焦、滚动条回到顶部、值被回填，
   * 根本没法改配置。
   *
   * 现在的规则：**按「已渲染的能力签名」判断**——渲染时记下当时的能力档位，
   * 只有能力真的多于已渲染的档位才升级，升级后签名同步前移，天然不会循环；
   * 正在输入时一律推迟到失焦。
   */
  _ensureUpgrade() {
    if (this._pendingUpgrade) return;
    const sig = this._capSig();
    if (sig === this._builtSig) return;         // 与已渲染的档位一致 → 无需升级
    if (this._focusInside()) { this._retryUpgradeOnBlur(); return; }

    this._pendingUpgrade = true;
    Promise.race([
      Promise.all([
        customElements.whenDefined('ha-entity-picker').catch(() => {}),
        customElements.whenDefined('ha-textfield').catch(() => {}),
      ]),
      sleep(this._upgradeWait || 2500),
    ]).then(() => {
      this._pendingUpgrade = false;
      if (this._capSig() === this._builtSig) return;   // 没有新能力到位 → 保持现状，不再重建
      if (this._focusInside()) { this._retryUpgradeOnBlur(); return; }
      this._build();                                   // 只升级一次，_builtSig 会在 _build 里前移
    });
  }

  /** 等用户离开输入框再升级控件（否则会打断正在输入的内容） */
  _retryUpgradeOnBlur() {
    if (this._blurHooked || !this._shadow) return;
    this._blurHooked = true;
    this._shadow.addEventListener('focusout', () => {
      this._blurHooked = false;
      // 留一拍：焦点可能只在相邻字段之间跳，别把它当成失焦
      setTimeout(() => { if (!this._focusInside()) this._ensureUpgrade(); }, 0);
    }, { once: true });
  }

  _fieldVisible(field) {
    if (!field.dependsOn) return true;
    return Object.keys(field.dependsOn).every((k) => this._config[k] === field.dependsOn[k]);
  }

  _build() {
    this._built = true;
    this._builtSig = this._capSig();     // 记录本次实际用的是哪一档控件
    this._shadow.innerHTML = `<style>${ALC_EDITOR_STYLES}</style><div class="alc-ed"></div>`;
    this._root = this._shadow.querySelector('.alc-ed');
    this._renderSections();
    this._ensureUpgrade();
  }

  _renderSections() {
    const frag = document.createDocumentFragment();
    ALC_EDITOR_SECTIONS.forEach((section) => {
      const wrap = document.createElement('details');
      wrap.className = 'alc-ed-section';
      if (section.open) wrap.open = true;
      const sum = document.createElement('summary');
      sum.textContent = section.title;
      wrap.appendChild(sum);
      const body = document.createElement('div');
      body.className = 'alc-ed-body';

      section.fields.forEach((f) => {
        const row = document.createElement('div');
        row.className = 'alc-ed-field';
        row.dataset.field = f.key;
        const visible = this._fieldVisible(f);
        row.hidden = !visible;

        const label = document.createElement('label');
        label.className = 'alc-ed-label';
        label.textContent = f.label;
        row.appendChild(label);

        const inputWrap = document.createElement('div');
        inputWrap.className = 'alc-ed-input';
        inputWrap.appendChild(this._createControl(f));
        row.appendChild(inputWrap);

        if (f.hint) {
          const hint = document.createElement('div');
          hint.className = 'alc-ed-hint';
          hint.textContent = f.hint;
          row.appendChild(hint);
        }
        body.appendChild(row);
      });

      wrap.appendChild(body);
      frag.appendChild(wrap);
    });

    const note = document.createElement('div');
    note.className = 'alc-ed-note';
    note.textContent = '提示：高德 Key 仅保存在本机 HA 配置中，页面加载时会随请求发送给高德。建议在高德控制台为该 Key 设置调用量上限与域名白名单。搜索范围默认「自动」，会跟随地图当前缩放范围变化。';
    frag.appendChild(note);

    this._root.innerHTML = '';
    this._root.appendChild(frag);
    this._sync();
  }

  _createControl(field) {
    const value = this._config[field.key];
    if (field.type === 'boolean') {
      if (this._has('ha-switch')) {
        const el = document.createElement('ha-switch');
        el.checked = !!value;
        el.addEventListener('change', (e) => this._onChange(field, e.target.checked));
        return el;
      }
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'alc-native alc-native-check';
      input.checked = !!value;
      input.addEventListener('change', (e) => this._onChange(field, e.target.checked));
      return input;
    }

    if (field.type === 'entity' && this._has('ha-entity-picker')) {
      const el = document.createElement('ha-entity-picker');
      el.hass = this._hass;
      el.value = value || '';
      el.allowCustomEntity = true;
      el.addEventListener('value-changed', (e) => {
        e.stopPropagation();
        this._onChange(field, e.detail.value || '');
      });
      return el;
    }

    if (field.type === 'select') {
      if (this._has('ha-select') || this._has('ha-dropdown')) {
        // 兼容：优先原生 select，保证跨版本稳定
      }
      const sel = document.createElement('select');
      sel.className = 'alc-native alc-native-select';
      (field.options || []).forEach(([v, t]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        if (value === v) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', (e) => this._onChange(field, e.target.value));
      return sel;
    }

    if (this._has('ha-textfield') && field.type !== 'select') {
      const el = document.createElement('ha-textfield');
      el.value = value === undefined || value === null ? '' : String(value);
      el.type = field.type === 'number' ? 'number' : (field.type === 'password' ? 'password' : 'text');
      if (field.min !== undefined) el.min = field.min;
      if (field.max !== undefined) el.max = field.max;
      if (field.step !== undefined) el.step = field.step;
      if (field.placeholder) el.placeholder = field.placeholder;
      el.addEventListener('change', (e) => this._commitTyped(field, e.target.value));
      return el;
    }

    const input = document.createElement('input');
    input.className = 'alc-native';
    input.type = field.type === 'number' ? 'number' : (field.type === 'password' ? 'password' : 'text');
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    if (field.step !== undefined) input.step = field.step;
    if (field.placeholder) input.placeholder = field.placeholder;
    input.value = value === undefined || value === null ? '' : String(value);
    input.addEventListener('change', (e) => this._commitTyped(field, e.target.value));
    return input;
  }

  _commitTyped(field, raw) {
    if (field.type === 'number') {
      const n = toNum(raw);
      if (n === null) {
        // 非法输入 → 回填默认值，避免写入 NaN
        this._onChange(field, ALC_DEFAULTS[field.key]);
        this._sync();
        return;
      }
      let v = n;
      if (field.min !== undefined) v = Math.max(field.min, v);
      if (field.max !== undefined) v = Math.min(field.max, v);
      this._onChange(field, v);
      return;
    }
    this._onChange(field, String(raw || '').trim());
  }

  _onChange(field, value) {
    if (this._config[field.key] === value) return;
    this._config = Object.assign({}, this._config, { [field.key]: value });

    // 依赖项变化 → 刷新可见性
    this._shadow.querySelectorAll('.alc-ed-field').forEach((row) => {
      const key = row.dataset.field;
      const def = ALC_EDITOR_SECTIONS.flatMap((s) => s.fields).find((f) => f.key === key);
      if (def) row.hidden = !this._fieldVisible(def);
    });

    // 只把用户显式配置过的键写回去，保持 YAML 干净
    const out = {};
    Object.keys(this._config).forEach((k) => {
      const v = this._config[k];
      const def = ALC_DEFAULTS[k];
      if (v === def) return;
      if (v === '' || v === null || v === undefined) return;
      if (k === 'type') return;
      out[k] = v;
    });
    out.type = 'custom:amap-location-card';
    out.entity = this._config.entity || '';

    fireEvent(this, 'config-changed', { config: out });
  }

  _sync() {
    if (!this._root) return;
    this._shadow.querySelectorAll('.alc-ed-field').forEach((row) => {
      const key = row.dataset.field;
      const def = ALC_EDITOR_SECTIONS.flatMap((s) => s.fields).find((f) => f.key === key);
      if (!def) return;
      row.hidden = !this._fieldVisible(def);
      const value = this._config[key];
      const ctrl = row.querySelector('ha-switch, ha-textfield, ha-entity-picker, input, select');
      if (!ctrl) return;
      if (def.type === 'boolean') {
        if (!!ctrl.checked !== !!value) ctrl.checked = !!value;
        return;
      }
      if (ctrl.value === undefined) return;
      // 值没变就不要赋值：给 input / ha-textfield 赋同值也会把光标推到末尾，
      // 用户正在输入时看起来就是「打到一半被重置」（配置页体验事故）
      const next = value === undefined || value === null ? '' : String(value);
      if (String(ctrl.value) !== next) ctrl.value = next;
    });
    this._applyHass();
  }
}

/* =============================================================================
 *  13. 样式
 * ============================================================================= */

const ALC_STYLES = `
:host { display:block; }
ha-card { overflow:hidden; }
.alc-root { --alc-radius: var(--ha-card-border-radius, 12px); position:relative; }

/* overflow:hidden —— 标记/弹窗一律裁剪在地图框内，绝不溢出到页面上 */
.alc-map-wrap { position:relative; overflow:hidden; background:var(--secondary-background-color, #e9edf2); }

/* 铺满窗口：卡片撑满视口高度，地图吃掉除「展开的列表」外的全部空间。
   HA 配置编辑器里的预览不加 .alc-fill（见 _inEditorPreview），保持原高度不撑爆面板。 */
.alc-root.alc-fill { display:flex; flex-direction:column;
  height:100vh;                       /* 兜底：不支持 dvh 的老浏览器 */
  height:100dvh;                      /* 兜底：JS 还没算出来时先按浏览器可视高度铺 */
  height:var(--alc-fill-h, 100dvh); }  /* 实际值由 _syncFillHeight() 写入：
                                         可视高度 − 上方顶栏/地址栏 − 下方底栏/工具栏 */
.alc-root.alc-fill .alc-map-wrap { flex:1 1 auto; min-height:160px; }
/* 列表高度也按百分比收敛：卡片让出底栏后总高变小，纯 vh 会把列表顶到地图上方 */
.alc-root.alc-fill .alc-list { max-height:min(45vh, 55%); }
/* z-index:0 让 .alc-map 自成叠加上下文，把高德内部的标记/Logo/iframe 全部压在本卡片的
   手势层（z10）之下 —— 交互统一走手势层，不被高德内部 DOM 拦截 */
.alc-map { position:absolute; inset:0; z-index:0; }

/* 手势接管层：拖拽 / 捏合 / 滚轮 / 轻点都在这里发生（JSAPI 2.0 自身管线在 Shadow DOM 下失效） */
.alc-gesture { position:absolute; inset:0; z-index:10; cursor:grab; }
.alc-gesture:active { cursor:grabbing; }

/* 地图右下角控件列：回到定位 → + → − → 列表（两种底图共用。
   高德自带 ToolBar 在 Shadow DOM 下不可点，所以这里全自绘） */
.alc-ctrl { position:absolute; right:8px; bottom:8px; display:flex; flex-direction:column;
  gap:5px; z-index:21; }
.alc-ctrl-list { font-size:15px; line-height:1; }
.alc-ctrl-list.on { background:var(--primary-color,#03a9f4); color:#fff; border-color:transparent; }

/* 状态标签：原顶部标题栏取消后，坐标/坐标系/搜索范围/刷新时间收进地图左上角 */
.alc-status { position:absolute; left:8px; top:8px; max-width:calc(100% - 96px); z-index:11;
  font-size:10.5px; line-height:1.35; color:var(--primary-text-color);
  padding:3px 8px; border-radius:8px; pointer-events:none;
  background:color-mix(in srgb, var(--card-background-color,#fff) 78%, transparent);
  backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:.8; }
.alc-status[hidden] { display:none; }

/* 高德底图模式的自绘弹窗（替代 InfoWindow） */
.alc-amap-pop { position:absolute; transform:translate(-50%,-100%); z-index:12; }
.alc-amap-pop.below { transform:translate(-50%,0); }
.alc-amap-pop[hidden] { display:none; }

/* 高德底图铺满 */
.alc-map canvas { outline:none; }

/* 标记 */
.alc-pin { display:flex; align-items:center; justify-content:center;
  border-radius:50%; background:var(--card-background-color,#fff);
  box-shadow:0 2px 6px rgba(0,0,0,.32); border:2px solid var(--card-background-color,#fff);
  cursor:pointer; overflow:hidden; box-sizing:border-box;
  -webkit-tap-highlight-color:transparent; }
.alc-pin-entity { border-color:#e53935; box-shadow:0 0 0 4px rgba(229,57,53,.20), 0 2px 8px rgba(0,0,0,.35); }
.alc-pin-charging { border-color:#00a86b; }
.alc-pin-toilet { border-color:#7e57c2; }
.alc-icon { display:block; }
.alc-icon-ha { color:var(--primary-text-color); }
.alc-pin-entity .alc-icon-ha { color:#e53935; }
.alc-pin-charging .alc-icon-ha { color:#00a86b; }
.alc-pin-toilet .alc-icon-ha { color:#7e57c2; }
.alc-icon-emoji { line-height:1; text-align:center; display:flex; align-items:center; justify-content:center; }
.alc-icon-img { object-fit:contain; }

/* 提示条 */
.alc-notices { position:absolute; left:8px; right:52px; bottom:8px; display:flex; flex-direction:column;
  gap:6px; pointer-events:none; z-index:30; }
.alc-notice { pointer-events:auto; display:flex; align-items:center; gap:8px;
  padding:7px 10px; border-radius:10px; font-size:12px; line-height:1.35;
  backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
  box-shadow:0 2px 10px rgba(0,0,0,.16); color:var(--primary-text-color);
  background:var(--card-background-color, rgba(255,255,255,.94)); }
.alc-notice-info { border-left:3px solid var(--info-color,#039be5); }
.alc-notice-warn { border-left:3px solid var(--warning-color,#ff9800); }
.alc-notice-error { border-left:3px solid var(--error-color,#db4437); }
.alc-notice-text { flex:1 1 auto; }
.alc-notice-btn { flex:0 0 auto; border:none; border-radius:8px; padding:3px 10px; cursor:pointer;
  background:var(--primary-color,#03a9f4); color:#fff; font-size:12px; }
.alc-notice-btn.ghost { background:transparent; color:var(--primary-text-color);
  border:1px solid var(--divider-color, rgba(0,0,0,.22)); }
.alc-notice-x { flex:0 0 auto; border:none; background:transparent; cursor:pointer;
  color:var(--secondary-text-color); font-size:16px; line-height:1; padding:0 2px; }

/* 加载 */
.alc-loading { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  gap:8px; background:color-mix(in srgb, var(--card-background-color,#fff) 68%, transparent);
  color:var(--primary-text-color); font-size:13px; z-index:25; }
.alc-loading[hidden] { display:none; }
.alc-spinner { width:16px; height:16px; border-radius:50%; border:2px solid currentColor;
  border-top-color:transparent; animation:alc-spin .8s linear infinite; }
@keyframes alc-spin { to { transform:rotate(360deg); } }

/* 列表头部的按钮（列表展开后才出现；顶部工具栏已取消，刷新/跟随切换收在这里） */
.alc-btn { border:1px solid var(--divider-color, rgba(0,0,0,.12)); background:transparent;
  color:var(--primary-text-color); border-radius:8px; padding:4px 9px; font-size:11.5px;
  cursor:pointer; -webkit-tap-highlight-color:transparent; }
.alc-btn:active { background:var(--secondary-background-color, rgba(0,0,0,.06)); }

/* 附近列表：点「列表」按钮后在下方展开（铺满窗口时地图让出高度，列表自己滚动） */
.alc-list { display:flex; flex-direction:column; max-height:320px; min-height:0;
  border-top:1px solid var(--divider-color, rgba(0,0,0,.10)); }
.alc-list[hidden] { display:none; }
.alc-list-head { display:flex; align-items:center; gap:6px; padding:8px 12px 6px; flex:0 0 auto; }
.alc-list-heading { flex:1 1 auto; min-width:0; font-size:12px; font-weight:500;
  color:var(--secondary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.alc-list-total { margin-left:5px; font-weight:600; color:var(--primary-text-color); }
.alc-list-body { flex:1 1 auto; min-height:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
  padding:0 12px 12px; }
.alc-list-group + .alc-list-group { margin-top:10px; }
.alc-list-title { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:500;
  color:var(--secondary-text-color); padding:8px 0 4px; }
.alc-list-count { margin-left:auto; opacity:.7; }
.alc-item { display:flex; align-items:flex-start; gap:8px; padding:8px; border-radius:10px;
  cursor:pointer; -webkit-tap-highlight-color:transparent; }
.alc-item:hover, .alc-item:active { background:var(--secondary-background-color, rgba(0,0,0,.05)); }
.alc-item-icon { flex:0 0 auto; display:flex; align-items:center; padding-top:1px; }
.alc-item-main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; }
.alc-item-name { font-size:13px; color:var(--primary-text-color); line-height:1.3; }
.alc-item-meta { display:flex; flex-wrap:wrap; gap:6px; align-items:center; font-size:11px;
  color:var(--secondary-text-color); }
.alc-meta-chip { background:var(--secondary-background-color, rgba(0,0,0,.05)); border-radius:6px; padding:1px 6px; }
.alc-meta-chip.dim, .dim { opacity:.55; }
.alc-item-addr { font-size:11px; color:var(--secondary-text-color); opacity:.85;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.alc-item-actions { flex:0 0 auto; display:flex; gap:6px; }
.alc-mini-btn { border:1px solid var(--divider-color, rgba(0,0,0,.14)); background:transparent;
  color:var(--primary-text-color); border-radius:7px; font-size:11px; padding:4px 8px; cursor:pointer; }
.alc-mini-btn.primary { background:var(--primary-color,#03a9f4); border-color:transparent; color:#fff; }
.alc-empty { font-size:12px; color:var(--secondary-text-color); padding:8px 0 4px; }

/* 弹窗（高德底图自绘弹窗 + 简化视图弹窗共用） */
.alc-pop { min-width:190px; max-width:260px; padding:10px 12px; background:var(--card-background-color,#fff);
  color:var(--primary-text-color); border-radius:12px; box-shadow:0 4px 18px rgba(0,0,0,.22);
  font-size:12px; position:relative; }
.alc-pop-head { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
.alc-pop-name { font-size:13px; font-weight:600; line-height:1.3; }
.alc-pop-row { display:flex; gap:8px; justify-content:space-between; padding:2px 0; }
.alc-pop-row .k { color:var(--secondary-text-color); flex:0 0 auto; }
.alc-pop-row .v { text-align:right; font-weight:500; }
.alc-pop-row .v.mono { font-variant-numeric:tabular-nums; font-size:11px; }
.alc-pop-addr { margin-top:5px; color:var(--secondary-text-color); font-size:11px; line-height:1.35; }
.alc-pop-hint { margin-top:5px; font-size:10.5px; color:var(--secondary-text-color); opacity:.8; line-height:1.35; }
.alc-pop-actions { display:flex; gap:6px; margin-top:9px; flex-wrap:wrap; }
.alc-pop-btn { flex:1 1 auto; border:1px solid var(--divider-color, rgba(0,0,0,.14)); background:transparent;
  color:var(--primary-text-color); border-radius:8px; padding:6px 8px; font-size:12px; cursor:pointer;
  -webkit-tap-highlight-color:transparent; white-space:nowrap; }
.alc-pop-btn.primary { background:var(--primary-color,#03a9f4); border-color:transparent; color:#fff; }

/* 高德底图模式弃用 InfoWindow（Shadow DOM 下收不到点击），改用自绘弹窗 .alc-amap-pop */

/* 简化视图 */
.alc-fallback-map { --alc-fallback-bg:#eef2f6; --alc-fallback-grid:rgba(0,0,0,.07); --alc-accent:#03a9f4;
  position:absolute; inset:0; overflow:hidden; background:var(--alc-fallback-bg); }
.alc-fm-canvas { position:absolute; inset:0; display:block; }
.alc-fm-layer { position:absolute; inset:0; overflow:hidden; }
.alc-fm-marker { position:absolute; left:0; top:0; cursor:pointer;
  transform-origin:center; will-change:transform; }
.alc-fm-marker > .alc-pin { transform:translate(-50%,-50%); position:absolute; left:50%; top:50%; }
.alc-fm-controls { position:absolute; right:8px; bottom:8px; display:flex; flex-direction:column; gap:4px; z-index:20; }
.alc-fm-btn { width:30px; height:30px; border-radius:8px; border:none; cursor:pointer;
  background:var(--card-background-color,#fff); color:var(--primary-text-color); font-size:15px;
  box-shadow:0 2px 8px rgba(0,0,0,.2); line-height:1; }
.alc-fm-badge { position:absolute; right:8px; top:8px; font-size:10.5px; padding:3px 8px; border-radius:8px;
  background:var(--card-background-color,rgba(255,255,255,.9)); color:var(--secondary-text-color);
  box-shadow:0 1px 4px rgba(0,0,0,.14); }
.alc-fm-popup { position:absolute; transform:translate(-50%,-100%); z-index:40; }
.alc-fm-popup[hidden] { display:none; }
.alc-popup-close { position:absolute; right:-6px; top:-6px; width:22px; height:22px; border-radius:50%;
  border:none; background:var(--card-background-color,#fff); color:var(--primary-text-color);
  box-shadow:0 1px 5px rgba(0,0,0,.25); cursor:pointer; font-size:14px; line-height:1; }

/* iOS 触摸优化 */
.alc-root button { touch-action:manipulation; }
.alc-map, .alc-fallback-map { -webkit-user-select:none; user-select:none; }

@media (prefers-color-scheme: dark) {
  .alc-fallback-map { --alc-fallback-bg:#1b1e23; --alc-fallback-grid:rgba(255,255,255,.08); }
}
`;

const ALC_EDITOR_STYLES = `
:host { display:block; }
.alc-ed { display:flex; flex-direction:column; gap:10px; padding:4px 0 8px; }
.alc-ed-section { border:1px solid var(--divider-color, rgba(0,0,0,.12)); border-radius:10px; overflow:hidden; }
.alc-ed-section > summary { cursor:pointer; padding:10px 12px; font-size:14px; font-weight:500;
  color:var(--primary-text-color); background:var(--secondary-background-color, rgba(0,0,0,.03));
  list-style:none; }
.alc-ed-section > summary::-webkit-details-marker { display:none; }
.alc-ed-section > summary::before { content:'▸'; display:inline-block; width:14px; transition:transform .15s; }
.alc-ed-section[open] > summary::before { transform:rotate(90deg); }
.alc-ed-body { padding:6px 12px 12px; display:flex; flex-direction:column; gap:12px; }
.alc-ed-field { display:flex; flex-direction:column; gap:4px; }
.alc-ed-field[hidden] { display:none; }
.alc-ed-label { font-size:13px; color:var(--primary-text-color); }
.alc-ed-hint { font-size:11.5px; color:var(--secondary-text-color); line-height:1.4; }
.alc-ed-input { display:flex; align-items:center; }
.alc-ed-input > * { width:100%; }
.alc-native { box-sizing:border-box; width:100%; padding:8px 10px; font-size:13px;
  border-radius:8px; border:1px solid var(--divider-color, rgba(0,0,0,.2));
  background:var(--card-background-color, #fff); color:var(--primary-text-color); }
.alc-native-check { width:auto; height:18px; width:18px; }
.alc-native-select { appearance:none; -webkit-appearance:none; padding-right:24px; }
.alc-ed-note { font-size:11.5px; color:var(--secondary-text-color); line-height:1.5;
  background:var(--secondary-background-color, rgba(0,0,0,.03)); border-radius:8px; padding:8px 10px; }
ha-textfield, ha-entity-picker, ha-switch { width:100%; }
ha-switch { width:auto; }
`;

/* =============================================================================
 *  14. 注册
 * ============================================================================= */

if (!customElements.get(ALC_CARD_TAG)) customElements.define(ALC_CARD_TAG, AmapLocationCard);
if (!customElements.get(ALC_EDITOR_TAG)) customElements.define(ALC_EDITOR_TAG, AmapLocationCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === ALC_CARD_TAG)) {
  window.customCards.push({
    type: ALC_CARD_TAG,
    name: 'AMap Location Card',
    description: '高德地图定位卡片：实体定位 + WGS84→GCJ02 纠偏 + 周边充电桩 / 公共厕所检索',
    preview: false,
    documentationURL: 'https://github.com/your-name/amap-location-card',
  });
}

console.info(
  `%c AMAP-LOCATION-CARD %c v${ALC_VERSION} `,
  'color:#fff;background:#03a9f4;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px',
  'color:#03a9f4;background:#e3f2fd;font-weight:700;border-radius:0 3px 3px 0;padding:2px 4px'
);


