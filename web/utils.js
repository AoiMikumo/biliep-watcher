// ── 纯工具函数（无副作用，无 DOM，无状态依赖）────────────────────────
import { BREAK_RATIO, OUTLIER_PCT } from './config.js';

// ── 数字格式化 ───────────────────────────────────────────────────────
export const fmt     = n => n >= 10000 ? (n / 10000).toFixed(1) + '万' : n.toLocaleString('zh-CN');
export const fmtFull = n => n.toLocaleString('zh-CN');

// 图表轴刻度专用：fmt 在 ≥10000 时固定保留 1 位小数（"1.0万"），
// 在以下两种情况下会失去意义，需退回到逗号分隔的完整数字：
//   ① 相邻刻度差 <1000：多个刻度会撞成同一 "X.X万" 字符串
//   ② 整段轴跨度 <10000：会出现 "0" / "2,000" / ... / "1.0万" 这种混合显示
export function fmtAxis(value, _index, ticks) {
  if (ticks && ticks.length >= 2) {
    const vals = ticks.map(t => t.value).slice().sort((a, b) => a - b);
    let step = Infinity;
    for (let i = 1; i < vals.length; i++) {
      const d = vals[i] - vals[i - 1];
      if (d > 0 && d < step) step = d;
    }
    if (step < 1000) return value.toLocaleString('zh-CN');
    const span = vals[vals.length - 1] - vals[0];
    if (span < 10000) return value.toLocaleString('zh-CN');
  }
  return fmt(value);
}
export function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ── 时间解析与格式化 ─────────────────────────────────────────────────
// 将 "2024-01-01 10:00:00" 解析为北京时区的 Date 对象
export const parseBeijingTime = s => new Date(s.replace(' ', 'T') + '+08:00');
// 将快照时间字符串缩短为图表刻度标签，如 "01-01 10:00"
export function fmtTimeLabel(s) {
  const p = s.split(' ');
  if (p.length !== 2) return s;
  const dp = p[0].split('-');
  return `${dp[1]}-${dp[2]} ${p[1].substring(0, 5)}`;
}

// ── 字符串工具 ───────────────────────────────────────────────────────
// 截断标题到 max 个字符（超出加省略号）
export const shortT = (t, max = 13) => t.length > max ? t.substring(0, max - 1) + '…' : t;
// Hex 颜色 → rgba(...)
export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── 数据解析 ─────────────────────────────────────────────────────────
// 解析 JSONL 文本为快照数组
export const parseJsonl = text =>
  text.trim().split('\n')
    .map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);

// ── 图表辅助 ─────────────────────────────────────────────────────────
// 检测柱状图数据是否存在显著异常值：Max/P90 >= BREAK_RATIO
export function findOutlier(values, pct = OUTLIER_PCT) {
  const pos = values.filter(v => v > 0);
  if (pos.length < 2) return { hasOutlier: false };
  pos.sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(pos.length * pct / 100));
  const pValue = pos[Math.min(idx, pos.length - 1)];
  const max = pos[pos.length - 1];
  if (pValue <= 0) return { hasOutlier: false };
  const ratio = max / pValue;
  return ratio >= BREAK_RATIO ? { hasOutlier: true, pValue, max, ratio } : { hasOutlier: false };
}

// 对数 Y 轴的智能边界：上下端各自做 outlier 检测
//   - 上端：dataMax / P90 >= BREAK_RATIO 时取 P90 * 1.3，否则 dataMax * 1.05
//   - 下端：P10 / dataMin >= BREAK_RATIO 时取 P10 * 0.8，否则 dataMin * 0.8
// 用途：让对数 Y 轴的主体数据区域占据合理高度，不被极值或新视频拉伸出大片空白。
export function calcLogAxisBounds(values) {
  const pos = values.filter(v => v > 0);
  if (pos.length === 0) return { min: 1, max: 100, hasHighClip: false, hasLowClip: false };
  pos.sort((a, b) => a - b);
  const dataMin = pos[0];
  const dataMax = pos[pos.length - 1];
  const p10 = pos[Math.max(0, Math.floor(pos.length * 0.10))];
  const p90 = pos[Math.min(pos.length - 1, Math.floor(pos.length * 0.90))];
  const hasHighClip = dataMax / p90 >= BREAK_RATIO;
  const hasLowClip  = dataMin > 0 && p10 / dataMin >= BREAK_RATIO;
  const max = hasHighClip ? Math.ceil(p90 * 1.3) : Math.ceil(dataMax * 1.05);
  const min = Math.max(1, Math.floor((hasLowClip ? p10 : dataMin) * 0.8));
  return { min, max, hasHighClip, hasLowClip };
}

// 对数轴刻度过滤器：只显示 1/2/5 × 10ⁿ 的"整齐"值
export function isNeatLogTick(val) {
  if (val == null || val <= 0) return false;
  const mantissa = val / Math.pow(10, Math.floor(Math.log10(val)));
  return Math.abs(mantissa - 1) < 0.05
      || Math.abs(mantissa - 2) < 0.05
      || Math.abs(mantissa - 5) < 0.05;
}

// ── 柱状图"轴折断"配置 ────────────────────────────────────────────────
// 当数据存在显著高端 outlier（Max/P90 ≥ BREAK_RATIO）时，轴划分为三段：
//   ① 主区 [0, visualBreak]   → 等比线性，覆盖大多数数据
//   ② 折断带 (visualBreak, hiZoneStart) → 视觉留白，轴上标 "~"
//   ③ 压缩区 [hiZoneStart, hiZoneEnd] → 把 [hiMin, dataMax] 压缩到此段
// 数据→视觉值通过 remapToBrokenAxis 转换；轴 tick 通过 inverseFromBrokenAxis 反推真值显示。
export function calcBrokenAxisConfig(data) {
  const brk = findOutlier(data);
  if (!brk.hasOutlier) return null;
  const dataMax = Math.max(...data);
  const P90     = brk.pValue;
  // visualBreak 与 "outlier 阈值" 用同一条线，避免 (visualBreak, hiMin) 死区
  const visualBreak = Math.ceil(P90 * 1.1);
  const outliers    = data.filter(v => v > visualBreak);
  if (outliers.length === 0) return null;
  const hiMin       = Math.min(...outliers);

  // 三段比例：主区比例最大，折断带细窄，压缩区给爆款一段可见长度
  const gapWidth    = Math.max(visualBreak * 0.06, 20);
  const highWidth   = Math.max(visualBreak * 0.22, 40);
  const hiZoneStart = visualBreak + gapWidth;
  const hiZoneEnd   = hiZoneStart + highWidth;
  return { visualBreak, hiZoneStart, hiZoneEnd, hiMin, dataMax, axisMax: hiZoneEnd };
}

// 数据值 → 视觉轴值（用于绘制柱子）
export function remapToBrokenAxis(value, cfg) {
  if (!cfg || value <= cfg.visualBreak) return value;
  const range = cfg.dataMax - cfg.hiMin;
  // 对 hiMin == dataMax（仅一个 outlier 值）的退化情形：直接放到压缩段末端
  const t = range > 0 ? Math.max(0, (value - cfg.hiMin) / range) : 1;
  return cfg.hiZoneStart + t * (cfg.hiZoneEnd - cfg.hiZoneStart);
}

// 视觉轴值 → 数据值（用于 tick 标签显示原始数字）
export function inverseFromBrokenAxis(visualValue, cfg) {
  if (!cfg || visualValue <= cfg.visualBreak) return visualValue;
  if (visualValue < cfg.hiZoneStart) return cfg.hiMin;
  const range = cfg.hiZoneEnd - cfg.hiZoneStart;
  const t = range > 0 ? (visualValue - cfg.hiZoneStart) / range : 0;
  return cfg.hiMin + t * (cfg.dataMax - cfg.hiMin);
}

// 取一个"漂亮"的刻度间隔（1/2/5 × 10ⁿ 系列），让刻度都是整数
export function niceTickStep(max, targetCount) {
  if (max <= 0 || targetCount <= 0) return 1;
  const raw  = max / targetCount;
  const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let nice;
  if      (norm <= 1.5) nice = 1;
  else if (norm <= 3)   nice = 2;
  else if (norm <= 7)   nice = 5;
  else                  nice = 10;
  return nice * mag;
}

// 均匀降采样（始终保留首尾）
export function downsample(snaps, maxPts) {
  if (snaps.length <= maxPts) return snaps;
  const result = [];
  const step = (snaps.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i++) {
    result.push(snaps[Math.round(i * step)]);
  }
  return result;
}

// ── 自定义浮动标题提示 ────────────────────────────────────────────────
// 在鼠标位置正上方显示一个自定义小悬浮窗，文字垂直居中
export function showTip(text, e) {
  const tip = document.getElementById('chart-tip');
  if (!tip || !text) return;
  tip.textContent = text;
  tip.style.left    = e.clientX + 'px';
  tip.style.top     = (e.clientY - 10) + 'px';
  tip.style.display = 'block';
}
export function hideTip() {
  const tip = document.getElementById('chart-tip');
  if (tip) tip.style.display = 'none';
}
// 给 DOM 元素绑定 showTip / hideTip（mouseenter/mousemove/mouseleave）
export function attachTip(el, getTitle) {
  el.addEventListener('mousemove',  e => showTip(getTitle(), e));
  el.addEventListener('mouseleave', hideTip);
}

// ── 综合评分（纯计算，无任何外部依赖） ───────────────────────────────
export function computeComposite(s) {
  if (!s || !s.view) return 0;
  const view    = Math.max(0, s.view    || 0);
  const reply   = Math.max(0, s.reply   || 0);
  const coin    = Math.max(0, s.coin    || 0);
  const fav     = Math.max(0, s.fav     || 0);
  const danmaku = Math.max(0, s.danmaku || 0);
  const corrA  = view > 0 ? Math.min(1, (1000000 + view) / (2 * view)) : 1;
  const corrBD = view + coin * 10 + reply * 50;
  const corrB  = corrBD > 0 ? Math.min(1, Math.round((fav * 20 + coin * 10) / corrBD * 100) / 100) : 0;
  const corrCD = view * 2 + fav * 10 + coin * 20;
  const corrC  = corrCD > 0 ? Math.min(1, Math.round((reply * 50 + danmaku) / corrCD * 100) / 100) : 0;
  const corrD  = Math.max(0, Math.round(
    Math.log10(reply + danmaku + 10) / Math.log10(view + fav + coin + 10) * 1000
  ) / 1000);
  return +((view * corrA + reply * corrB * 50 + coin * corrC * 20 + fav * corrC) * corrD).toFixed(0);
}
