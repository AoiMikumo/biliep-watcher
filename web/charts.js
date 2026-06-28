// ── 图表层：所有 Chart.js 图表构建函数 ─────────────────────────────
import { COLORS, MANY_EP, PIE_MAX, MULTI_DEF, getDownsampleMax, ML } from './config.js';
import { fmt, fmtFull, fmtAxis, shortT, hexToRgba, fmtTimeLabel, downsample, showTip, hideTip, attachTip, computeComposite, calcLogAxisBounds, isNeatLogTick, calcBrokenAxisConfig, remapToBrokenAxis, inverseFromBrokenAxis, niceTickStep } from './utils.js';
import { S } from './state.js';
import { filterEps, filteredInfoEps, makeEpMap, gWindowedSnaps,
         pickBaselineSnap, windowDisplayLabel } from './data.js';

// 条形图 / 得分图 / 趋势对比的完整标题（tooltip 使用）
let _barFullTitles   = [];
let _engFullTitles   = [];
let _multiFullTitles = [];

// ── 内部工具 ─────────────────────────────────────────────────────────
function getCtx(key, id) {
  if (!S.ctxs[key]) S.ctxs[key] = document.getElementById(id).getContext('2d');
  return S.ctxs[key];
}

// ── Chart.js 插件：条形图内联数据标签 + 真实"轴折断"效果 ──────────────
// 当 chart._brokenCfg 存在（说明该图启用了折断轴）时：
//   ① 柱子穿过折断带：在折断带中央画两道锯齿状边缘（左右），中间用背景色擦出空隙
//   ② 数值标签照常画在柱子右端，显示真实值（来自 dataset._realData）
// 没有折断时退化为：所有柱子的数值标签紧贴在右端。
export const inlineBarLabels = {
  id: 'inlineBarLabels',
  afterDatasetsDraw: chart => {
    const ctx    = chart.ctx;
    const xScale = chart.scales.x;
    const cfg    = chart._brokenCfg;
    chart.data.datasets.forEach((dataset, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      const realData = dataset._realData || dataset.data;
      meta.data.forEach((bar, j) => {
        const realValue = realData[j];
        if (realValue == null || realValue === 0) return;
        const barColor  = Array.isArray(dataset.backgroundColor)
          ? dataset.backgroundColor[j]
          : dataset.backgroundColor;
        const isBroken  = cfg && realValue > cfg.visualBreak;

        // 折断带中央画锯齿（柱子被压缩处的视觉断口）
        if (isBroken) {
          const gapMid  = (cfg.visualBreak + cfg.hiZoneStart) / 2;
          const breakX  = xScale.getPixelForValue(gapMid);
          const barH    = bar.height || 16;
          const yTop    = bar.y - barH / 2;
          const yBot    = bar.y + barH / 2;
          const teeth   = Math.max(3, Math.floor(barH / 5));
          const halfW   = 4;

          // ① 擦掉柱子中央一段
          ctx.save();
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(breakX - halfW, yTop, halfW * 2, barH);
          ctx.restore();

          // ② 左侧锯齿边缘
          ctx.save();
          ctx.strokeStyle = barColor;
          ctx.lineWidth   = 1.4;
          ctx.lineJoin    = 'round';
          ctx.beginPath();
          for (let t = 0; t <= teeth; t++) {
            const yy = yTop + (yBot - yTop) * t / teeth;
            const xx = breakX - halfW + (t % 2 === 0 ? 0 : 2);
            if (t === 0) ctx.moveTo(xx, yy);
            else         ctx.lineTo(xx, yy);
          }
          ctx.stroke();
          // ③ 右侧锯齿边缘（镜像）
          ctx.beginPath();
          for (let t = 0; t <= teeth; t++) {
            const yy = yTop + (yBot - yTop) * t / teeth;
            const xx = breakX + halfW - (t % 2 === 0 ? 0 : 2);
            if (t === 0) ctx.moveTo(xx, yy);
            else         ctx.lineTo(xx, yy);
          }
          ctx.stroke();
          ctx.restore();
        }

        // 数值标签：紧贴柱子右端，显示真实值
        ctx.save();
        ctx.font         = '11px PingFang SC,Microsoft YaHei,sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign    = 'left';
        ctx.fillStyle    = isBroken ? '#b45309' : '#475569';
        ctx.fillText(fmt(realValue), bar.x + 4, bar.y);
        ctx.restore();
      });
    });
  }
};

// ── Chart.js 插件：折断轴上的 "~" 符号 ────────────────────────────────
// 在 X 轴折断带中央画一个 "~" 字符，告诉读者此处的数值跳跃。
export const axisBreakSymbol = {
  id: 'axisBreakSymbol',
  afterDraw: chart => {
    const cfg = chart._brokenCfg;
    if (!cfg) return;
    const ctx       = chart.ctx;
    const xScale    = chart.scales.x;
    const chartArea = chart.chartArea;
    const gapMid    = (cfg.visualBreak + cfg.hiZoneStart) / 2;
    const gapMidPx  = xScale.getPixelForValue(gapMid);
    const axisY     = chartArea.bottom;

    ctx.save();
    // 用背景色盖住该位置可能被生成的刻度文字
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(gapMidPx - 8, axisY + 1, 16, 18);
    // 画一个清晰的 "~"
    ctx.fillStyle    = '#64748b';
    ctx.font         = 'bold 14px PingFang SC,Microsoft YaHei,sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('~', gapMidPx, axisY + 10);
    ctx.restore();
  }
};

// ── Chart.js 插件：多折线越界标记（↑/↓ + 真实值） ─────────────────────
// 当 dataset 中有数据点超过 y 轴上/下限时，在 chart 顶部/底部对应 x 位置画一个
// 与折线同色的小三角 + 真实极值。每个 dataset 至多两个标记（上限一个、下限一个）。
export const lineClipMarkers = {
  id: 'lineClipMarkers',
  afterDatasetsDraw: chart => {
    const ctx       = chart.ctx;
    const yScale    = chart.scales.y;
    const yMin      = yScale.min;
    const yMax      = yScale.max;
    const chartArea = chart.chartArea;
    const topY      = chartArea.top + 9;
    const botY      = chartArea.bottom - 9;

    chart.data.datasets.forEach((dataset, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      // 用 _realData 找真实极值（dataset.data 已被钳到轴范围，无法判断越界）
      const data = dataset._realData || dataset.data;
      let highIdx = -1, lowIdx = -1;
      let highVal = -Infinity, lowVal = Infinity;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (v == null || v <= 0) continue;
        if (v > yMax && v > highVal) { highVal = v; highIdx = i; }
        if (v < yMin && v < lowVal)  { lowVal  = v; lowIdx  = i; }
      }
      const color = typeof dataset.borderColor === 'string'
        ? dataset.borderColor
        : COLORS[di % COLORS.length];

      if (highIdx >= 0 && meta.data[highIdx]) {
        drawClipMarker(ctx, meta.data[highIdx].x, topY, 'up',   color, fmt(highVal), chartArea);
      }
      if (lowIdx >= 0 && meta.data[lowIdx]) {
        drawClipMarker(ctx, meta.data[lowIdx].x,  botY, 'down', color, fmt(lowVal),  chartArea);
      }
    });
  }
};

// 在 (x, y) 画一个朝上/朝下的小三角 + 真实数值。
// 数值默认显示在三角右侧；若会超出 chartArea.right，则翻转到左侧避免裁切。
function drawClipMarker(ctx, x, y, dir, color, label, chartArea) {
  const size = 4;
  ctx.save();
  // 三角
  ctx.fillStyle = color;
  ctx.beginPath();
  if (dir === 'up') {
    ctx.moveTo(x, y - size);
    ctx.lineTo(x - size, y + size - 1);
    ctx.lineTo(x + size, y + size - 1);
  } else {
    ctx.moveTo(x, y + size);
    ctx.lineTo(x - size, y - size + 1);
    ctx.lineTo(x + size, y - size + 1);
  }
  ctx.closePath();
  ctx.fill();
  // 文字：先设字体再测宽，决定贴左还是贴右
  ctx.font         = '10px PingFang SC,Microsoft YaHei,sans-serif';
  ctx.fillStyle    = color;
  ctx.textBaseline = 'middle';
  const labelW = ctx.measureText(label).width;
  if (chartArea && (x + size + 3 + labelW) > chartArea.right) {
    ctx.textAlign = 'right';
    ctx.fillText(label, x - size - 3, y);
  } else {
    ctx.textAlign = 'left';
    ctx.fillText(label, x + size + 3, y);
  }
  ctx.restore();
}

// ── 综合得分算法（已移至 utils.js） ──────────────────────────────────
export { computeComposite } from './utils.js';

// ── 饼图悬停同步 ─────────────────────────────────────────────────────
export function syncPieHover(idx) {
  const ch = S.charts.pie;
  if (ch) {
    ch.setActiveElements(idx >= 0 ? [{ datasetIndex: 0, index: idx }] : []);
    ch.update('none');
  }
  document.querySelectorAll('.pie-legend-item').forEach((el, i) => {
    el.style.opacity = (idx < 0 || i === idx) ? '1' : '0.35';
  });
}
// ── 总量趋势折线图 ────────────────────────────────────────────────────
export function buildTrendChart(metric) {
  const snaps  = downsample(gWindowedSnaps(), getDownsampleMax());
  const labels = snaps.map(s => fmtTimeLabel(s.time));
  const data   = snaps.map(s => filterEps(s).reduce((sum, e) => sum + (e[metric] || 0), 0));
  const label  = ML[metric] || metric;
  if (S.charts.trend) S.charts.trend.destroy();
  S.charts.trend = new Chart(getCtx('trend', 'chart-trend'), {
    type: 'line',
    data: { labels, datasets: [{
      label, data,
      borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)',
      borderWidth: 2.5, fill: true, tension: 0.35,
      pointRadius: 0, pointHoverRadius: 5
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` ${label}：${fmtFull(c.raw)}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, color: '#94a3b8' } },
        y: { grid: { color: '#f1f5f9' }, ticks: { color: '#94a3b8', callback: fmtAxis } }
      }
    }
  });
}

// ── 播放占比饼图（单图，总计/增量可切换） ────────────────────────────
export function buildPieChart() {
  const last      = S.snapshots[S.snapshots.length - 1];
  const baseline  = pickBaselineSnap(S.deltaWindowHours);
  const epMap     = makeEpMap();
  const eps       = filteredInfoEps();
  const hasDelta  = S.snapshots.length > 1;
  const showDelta = S.pieShowDelta && hasDelta;
  const lastByAid = {}, baseByAid = {};
  filterEps(last).forEach(e     => { lastByAid[e.aid] = e; });
  filterEps(baseline).forEach(e => { baseByAid[e.aid] = e; });

  const getVal = ep => showDelta
    ? Math.max(0, ((lastByAid[ep.aid] || {}).view || 0) - ((baseByAid[ep.aid] || {}).view || 0))
    : ((lastByAid[ep.aid] || {}).view || 0);

  const needsClip = eps.length > PIE_MAX;
  let labels, data, colors;

  if (needsClip) {
    const sorted    = eps.slice().sort((a, b) => getVal(b) - getVal(a));
    const topItems  = sorted.slice(0, PIE_MAX - 1);
    const restItems = sorted.slice(PIE_MAX - 1);
    const restSum   = restItems.reduce((s, e) => s + getVal(e), 0);
    labels = topItems.map(e => epMap[e.aid] ? epMap[e.aid].title : String(e.aid));
    data   = topItems.map(getVal);
    if (restSum > 0) { labels.push('其余 ' + restItems.length + ' 个'); data.push(restSum); }
    colors = labels.map((_, i) => i < topItems.length ? COLORS[i % COLORS.length] : '#cbd5e1');
    document.getElementById('pie-note').textContent = `Top ${PIE_MAX - 1}，其余合并`;
  } else {
    const sortedAll = eps.slice().sort((a, b) => getVal(b) - getVal(a));
    labels = sortedAll.map(e => epMap[e.aid] ? epMap[e.aid].title : String(e.aid));
    data   = sortedAll.map(getVal);
    colors = sortedAll.map((_, i) => COLORS[i % COLORS.length]);
    document.getElementById('pie-note').textContent = '';
  }

  // 更新饼图切换按钮显示状态
  const pieSeg = document.getElementById('pie-seg');
  if (!hasDelta) {
    pieSeg.style.display = 'none';
    S.pieShowDelta = false;
  } else {
    pieSeg.style.display = '';
    pieSeg.querySelectorAll('.seg-opt').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === (showDelta ? 'delta' : 'cum'));
    });
  }

  // 构建图例（DOM API，单列百分比）
  const total    = data.reduce((a, b) => a + b, 0);
  const legendEl = document.getElementById('pie-legend');
  legendEl.innerHTML = '';
  labels.forEach((lbl, i) => {
    const pct  = total > 0 ? ((data[i] / total) * 100).toFixed(1) : '—';
    const item = document.createElement('div');
    item.className = 'pie-legend-item';

    const dot = document.createElement('span');
    dot.className = 'pie-legend-dot';
    dot.style.background = colors[i];

    const name = document.createElement('span');
    name.className = 'pie-legend-name';
    name.textContent = shortT(lbl, 14);

    const val = document.createElement('span');
    val.className = 'pie-legend-val';
    val.textContent = fmt(data[i]);

    const pctSpan = document.createElement('span');
    pctSpan.className = 'pie-legend-pct';
    pctSpan.textContent = pct + '%';

    item.appendChild(dot);
    item.appendChild(name);
    item.appendChild(val);
    item.appendChild(pctSpan);
    attachTip(item, () => lbl);
    item.addEventListener('mouseenter', () => syncPieHover(i));
    item.addEventListener('mouseleave', () => syncPieHover(-1));
    legendEl.appendChild(item);
  });

  // 构建单图
  if (S.charts.pie) S.charts.pie.destroy();
  S.charts.pie = new Chart(document.getElementById('chart-pie'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors,
            borderWidth: 2, borderColor: '#fff', hoverOffset: 10 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => {
          const t = c.dataset.data.reduce((a, b) => a + b, 0);
          const pct = t > 0 ? ((c.raw / t) * 100).toFixed(1) : '0.0';
          return ` ${fmtFull(c.raw)}（${pct}%）`;
        }}}
      },
      onHover: (e, els) => syncPieHover(els.length > 0 ? els[0].index : -1)
    }
  });
}

// ── 各视频指标排行（水平条形图） ──────────────────────────────────────
export function buildBarChart(metric) {
  const last  = S.snapshots[S.snapshots.length - 1];
  const epMap = makeEpMap();
  const eps   = filteredInfoEps();
  const label = ML[metric] || metric;

  const lastEps = filterEps(last);
  let visible;
  if (S.barSortByValue) {
    visible = lastEps.slice().sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  } else {
    const aidInSnap = new Set(lastEps.map(e => e.aid));
    visible = eps.filter(ep => aidInSnap.has(ep.aid))
      .map(ep => lastEps.find(e => e.aid === ep.aid))
      .filter(Boolean);
  }

  const barLabels = visible.map(e => epMap[e.aid] ? shortT(epMap[e.aid].title, 14) : String(e.aid));
  _barFullTitles  = visible.map(e => epMap[e.aid] ? epMap[e.aid].title : String(e.aid));
  const data      = visible.map(e => e[metric] || 0);

  document.getElementById('bar-scope-note').textContent = '';
  document.getElementById('bar-chart-wrap').style.height = Math.max(200, visible.length * 28) + 'px';

  // 折断轴配置：存在显著高端 outlier 时启用
  const brokenCfg   = calcBrokenAxisConfig(data);
  const displayData = brokenCfg ? data.map(v => remapToBrokenAxis(v, brokenCfg)) : data;
  const axisMax     = brokenCfg ? brokenCfg.axisMax : undefined;

  if (S.charts.bar) {
    const c = S.charts.bar;
    c._brokenCfg = brokenCfg;
    c.data.labels = barLabels;
    c.data.datasets[0].label = label;
    c.data.datasets[0].data  = displayData;
    c.data.datasets[0]._realData = data;
    c.data.datasets[0].backgroundColor = data.map((_, i) => COLORS[i % COLORS.length]);
    c.options.scales.x.type = 'linear';
    c.options.scales.x.min  = 0;
    c.options.scales.x.max  = axisMax;
    c.options.scales.x.ticks.callback     = makeBrokenAxisTickCallback(brokenCfg);
    c.options.scales.x.afterBuildTicks    = makeBrokenAxisTickBuilder(brokenCfg);
    c.update();
  } else {
    S.charts.bar = new Chart(getCtx('bar', 'chart-bar'), {
      type: 'bar',
      data: { labels: barLabels, datasets: [{
        label, data: displayData, _realData: data,
        backgroundColor: data.map((_, i) => COLORS[i % COLORS.length]),
        borderRadius: 5, borderSkipped: false
      }]},
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'y', intersect: false },
        layout: { padding: { right: 58 } },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { type: 'linear', min: 0, max: axisMax,
               grid: { color: '#f1f5f9' },
               ticks: { color: '#94a3b8', callback: makeBrokenAxisTickCallback(brokenCfg) },
               afterBuildTicks: makeBrokenAxisTickBuilder(brokenCfg) },
          y: { grid: { display: false }, ticks: { color: '#475569' } }
        }
      },
      plugins: [inlineBarLabels, axisBreakSymbol]
    });
    S.charts.bar._brokenCfg = brokenCfg;
    const barCanvas = document.getElementById('chart-bar');
    barCanvas.addEventListener('mousemove', e => {
      const els = S.charts.bar.getElementsAtEventForMode(e, 'y', { intersect: false }, true);
      if (els.length) showTip(_barFullTitles[els[0].index] || '', e);
      else hideTip();
    });
    barCanvas.addEventListener('mouseleave', hideTip);
  }
}

// 折断轴的 tick 标签 callback 工厂——根据 cfg 反向映射出真实数值；折断带中央显示 "~"
function makeBrokenAxisTickCallback(cfg) {
  return function(val) {
    if (!cfg) return fmt(val);
    if (val > cfg.visualBreak && val < cfg.hiZoneStart) return '';  // 折断带：留空，由 axisBreakSymbol 插件画 "~"
    return fmt(inverseFromBrokenAxis(val, cfg));
  };
}

// 折断轴的 tick 位置工厂——主区给若干"漂亮"刻度，压缩区只给一个 dataMax
function makeBrokenAxisTickBuilder(cfg) {
  return function(scale) {
    if (!cfg) return;
    const ticks = [];
    const step  = niceTickStep(cfg.visualBreak, 4);
    for (let v = 0; v <= cfg.visualBreak + 0.001; v += step) {
      ticks.push({ value: Math.round(v), major: false });
    }
    // 压缩区只标 dataMax（避免与 hiMin 重合时的混乱）
    ticks.push({ value: cfg.hiZoneEnd, major: false });
    scale.ticks = ticks;
  };
}

// ── 综合得分排行 ──────────────────────────────────────────────────────
export function buildEngagementChart() {
  const last     = S.snapshots[S.snapshots.length - 1];
  const eps      = filteredInfoEps();
  const aidStats = {};
  filterEps(last).forEach(e => { aidStats[e.aid] = e; });

  const visEps = S.engSortByValue
    ? eps.slice().sort((a, b) => computeComposite(aidStats[b.aid]) - computeComposite(aidStats[a.aid]))
    : eps.slice();

  document.getElementById('engage-scope-note').textContent = '';
  document.getElementById('engage-chart-wrap').style.height = Math.max(200, visEps.length * 28) + 'px';

  const labels     = visEps.map(ep => shortT(ep.title, 14));
  _engFullTitles   = visEps.map(ep => ep.title);
  const data       = visEps.map(ep => computeComposite(aidStats[ep.aid]));

  // 折断轴配置（与播放/互动条形图共用同一套逻辑）
  const brokenCfg   = calcBrokenAxisConfig(data);
  const displayData = brokenCfg ? data.map(v => remapToBrokenAxis(v, brokenCfg)) : data;
  const axisMax     = brokenCfg ? brokenCfg.axisMax : undefined;

  if (S.charts.engage) {
    const c = S.charts.engage;
    c._brokenCfg = brokenCfg;
    c.data.labels = labels;
    c.data.datasets[0].data = displayData;
    c.data.datasets[0]._realData = data;
    c.data.datasets[0].backgroundColor = data.map((_, i) => COLORS[i % COLORS.length]);
    c.options.scales.x.min = 0;
    c.options.scales.x.max = axisMax;
    c.options.scales.x.ticks.callback     = makeBrokenAxisTickCallback(brokenCfg);
    c.options.scales.x.afterBuildTicks    = makeBrokenAxisTickBuilder(brokenCfg);
    c.update();
  } else {
    S.charts.engage = new Chart(getCtx('engage', 'chart-engagement'), {
      type: 'bar',
      data: { labels, datasets: [{
        label: '综合评分', data: displayData, _realData: data,
        backgroundColor: data.map((_, i) => COLORS[i % COLORS.length]),
        borderRadius: 4, borderSkipped: false
      }]},
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'y', intersect: false },
        layout: { padding: { right: 58 } },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { type: 'linear', min: 0, max: axisMax,
               grid: { color: '#f1f5f9' },
               ticks: { color: '#94a3b8', callback: makeBrokenAxisTickCallback(brokenCfg) },
               afterBuildTicks: makeBrokenAxisTickBuilder(brokenCfg) },
          y: { grid: { display: false }, ticks: { color: '#475569' } }
        }
      },
      plugins: [inlineBarLabels, axisBreakSymbol]
    });
    S.charts.engage._brokenCfg = brokenCfg;
    const engCanvas = document.getElementById('chart-engagement');
    engCanvas.addEventListener('mousemove', e => {
      const els = S.charts.engage.getElementsAtEventForMode(e, 'y', { intersect: false }, true);
      if (els.length) showTip(_engFullTitles[els[0].index] || '', e);
      else hideTip();
    });
    engCanvas.addEventListener('mouseleave', hideTip);
  }
}

// ── 各视频趋势对比（多折线） ──────────────────────────────────────────
// 视频数量超过 MANY_EP 时，默认按"当前窗口内、当前选中指标的增量"取 Top N：
//   - 老视频但近期不涨 → 增量小 → 自动让位
//   - 新视频在窗口内首次出现 → 基线视为 0，增量 = 当前值，有机会上榜
//   - 切换指标（如 view → coin）时，Top N 也会跟着切换为该指标的增量
// 仅 1 次快照时无法算增量，退化为按当前值排序。
export function buildMultiChart(metric) {
  const eps    = filteredInfoEps();
  const epMap  = makeEpMap();
  const last   = S.snapshots[S.snapshots.length - 1];
  const manyEp = eps.length > MANY_EP;

  let visEps;
  if (manyEp && !S.multiShowAll) {
    const hasDelta  = S.snapshots.length > 1;
    const baseline  = pickBaselineSnap(S.deltaWindowHours);
    const lastByAid = {}, baseByAid = {};
    filterEps(last).forEach(e     => { lastByAid[e.aid] = e; });
    filterEps(baseline).forEach(e => { baseByAid[e.aid] = e; });
    const aidScore = {};
    eps.forEach(ep => {
      const cur  = (lastByAid[ep.aid] || {})[metric] || 0;
      const base = (baseByAid[ep.aid] || {})[metric] || 0;
      aidScore[ep.aid] = hasDelta ? (cur - base) : cur;
    });
    visEps = eps.slice().sort((a, b) => (aidScore[b.aid] || 0) - (aidScore[a.aid] || 0)).slice(0, MULTI_DEF);
    document.getElementById('multi-scope-note').textContent = hasDelta
      ? `${ML[metric] || metric}增量 Top ${visEps.length}（共 ${eps.length} 个）`
      : `${ML[metric] || metric} Top ${visEps.length}（共 ${eps.length} 个）`;
  } else {
    visEps = eps;
    document.getElementById('multi-scope-note').textContent = manyEp ? `全部 ${eps.length} 个` : '';
  }

  const noticeEl = document.getElementById('multi-notice');
  noticeEl.innerHTML = '';
  if (S.snapshots.length === 1) {
    const div = document.createElement('div');
    div.className = 'notice';
    div.textContent = '当前只有1次采样，趋势图需要更多数据点才能显示有意义的趋势。';
    noticeEl.appendChild(div);
  }

  const snapsDS      = downsample(gWindowedSnaps(), getDownsampleMax());
  const chartLabels  = snapsDS.map(s => fmtTimeLabel(s.time));
  // 每条 dataset 同时维护：
  //   _realData  ：真实值（null=视频在该快照尚未存在，其余为真值）
  //   _isSynthetic[i]：标记该索引是不是我们"在首次出现前一个时间点补的 0"
  // 渲染用的 data 由 bounds 算出后再回填。
  const datasets = visEps.map((ep, i) => {
    const realData = snapsDS.map(s => {
      const found = s.episodes.find(e => e.aid === ep.aid);
      return found ? found[metric] || 0 : null;
    });
    const isSynthetic = realData.map(() => false);
    const firstIdx    = realData.findIndex(v => v !== null);
    // 视频中途首次出现、且首个采集值非 0：在「出现时间点的前一个采集点」补一个 0，
    // 让曲线从 0 升起而非凭空冒出。首个值本就是 0 时无需补（曲线已从 0 开始）。
    if (firstIdx > 0 && realData[firstIdx] > 0) {
      realData[firstIdx - 1]    = 0;
      isSynthetic[firstIdx - 1] = true;
    }
    return {
      label: shortT(ep.title, 12), data: realData,
      _realData: realData, _isSynthetic: isSynthetic,
      borderColor: COLORS[i % COLORS.length],
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: 0, pointHoverRadius: 5,
      tension: 0.3, spanGaps: true
    };
  });
  _multiFullTitles = visEps.map(ep => ep.title);

  // 计算 Y 轴边界（仅基于真实数据，不计入合成 0）
  const allVals = [];
  datasets.forEach(ds => {
    ds._realData.forEach((v, i) => {
      if (v != null && !ds._isSynthetic[i] && v > 0) allVals.push(v);
    });
  });
  const bounds = calcLogAxisBounds(allVals);
  // 没有 outlier 时退回线性轴 0→max·1.05：视野完整，合成 0 在 X 轴底部自然落位，
  // 不需要钳裁任何点。有 outlier 时才用对数轴 + 压缩边界，并钳裁越界折线。
  const useLog = bounds.hasHighClip || bounds.hasLowClip;
  const yMin   = useLog ? bounds.min : 0;
  const yMax   = bounds.max;
  const yType  = useLog ? 'logarithmic' : 'linear';

  // 生成绘制数据：仅在对数模式下才钳裁；合成 0 在线性下保留为 0，在对数下放到 yMin
  datasets.forEach(ds => {
    ds.borderDash = undefined;  // 清掉上轮可能加的虚线
    ds.data = ds._realData.map((v, i) => {
      if (v == null) return null;
      if (ds._isSynthetic[i]) return useLog ? yMin : 0;
      if (!useLog) return v;
      if (v <= 0)      return null;        // 对数轴无法表示 0
      if (v > yMax)    return yMax;
      if (v < yMin)    return yMin;
      return v;
    });
    // 整段越界 → 虚线提示（仅对数模式下可能发生）
    if (useLog) {
      const vals = ds._realData.filter((v, i) => v != null && !ds._isSynthetic[i] && v > 0);
      const allHigh = vals.length > 0 && vals.every(v => v > yMax);
      const allLow  = vals.length > 0 && vals.every(v => v < yMin);
      if (allHigh || allLow) ds.borderDash = [4, 3];
    }
  });

  // 每次重建图表时高亮集合重置
  const highlightedSet = new Set();
  const applyHighlight = chart => {
    const all = highlightedSet.size === 0;
    chart.data.datasets.forEach((ds, i) => {
      const active = all || highlightedSet.has(i);
      ds.borderWidth      = active ? 2 : 0.5;
      ds.borderColor      = active ? COLORS[i % COLORS.length] : hexToRgba(COLORS[i % COLORS.length], 0.2);
      ds.pointHoverRadius = active ? 5 : 0;
    });
    chart.update('none');
  };

  if (S.charts.multi) S.charts.multi.destroy();
  S.charts.multi = new Chart(getCtx('multi', 'chart-multi'), {
    type: 'line',
    data: { labels: chartLabels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          // 合成 0（标记新视频"诞生时刻"的辅助点）不参与 tooltip，避免显示 "0" 误导
          filter: c => !(c.dataset._isSynthetic && c.dataset._isSynthetic[c.dataIndex]),
          callbacks: { label: c => {
            const real = c.dataset._realData || c.dataset.data;
            const v = real[c.dataIndex];
            return v == null ? '' : ` ${c.dataset.label}：${fmtFull(v)}`;
          } }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, color: '#94a3b8' } },
        y: yType === 'logarithmic'
          ? {
              type: 'logarithmic', min: yMin, max: yMax,
              grid: { color: ctx => isNeatLogTick(ctx.tick.value) ? '#f1f5f9' : 'transparent' },
              border: { display: false },
              ticks: {
                color: '#94a3b8', autoSkip: false, maxRotation: 0,
                callback: val => isNeatLogTick(val) ? fmt(val) : ''
              }
            }
          : {
              type: 'linear', min: 0, max: yMax,
              grid: { color: '#f1f5f9' },
              ticks: { color: '#94a3b8', callback: fmtAxis }
            }
      }
    },
    plugins: [lineClipMarkers]
  });

  // 自定义 HTML 图例（DOM API）
  const multiLegend = document.getElementById('multi-legend');
  multiLegend.innerHTML = '';
  visEps.forEach((ep, i) => {
    const item = document.createElement('div');
    item.className = 'multi-legend-item';

    const dot = document.createElement('span');
    dot.className = 'pie-legend-dot';
    dot.style.background = COLORS[i % COLORS.length];

    const labelSpan = document.createElement('span');
    labelSpan.className = 'multi-legend-label';
    labelSpan.textContent = shortT(ep.title, 16);

    item.appendChild(dot);
    item.appendChild(labelSpan);
    attachTip(item, () => _multiFullTitles[i] || ep.title);
    item.addEventListener('click', () => {
      if (highlightedSet.has(i)) highlightedSet.delete(i);
      else highlightedSet.add(i);
      multiLegend.querySelectorAll('.multi-legend-item').forEach((el, j) => {
        el.style.opacity = (highlightedSet.size === 0 || highlightedSet.has(j)) ? '1' : '0.35';
      });
      applyHighlight(S.charts.multi);
    });
    multiLegend.appendChild(item);
  });
}

// ── 播放增量折线图 ────────────────────────────────────────────────────
export function buildDeltaChart() {
  const allSnaps = gWindowedSnaps();
  if (allSnaps.length < 2) { document.getElementById('delta-card').style.display = 'none'; return; }
  document.getElementById('delta-card').style.display = '';

  // 先计算每相邻快照间的原始增量
  const rawDeltas = [];
  const rawTimes  = [];
  for (let i = 1; i < allSnaps.length; i++) {
    const ps = filterEps(allSnaps[i - 1]).reduce((s, e) => s + (e.view || 0), 0);
    const cs = filterEps(allSnaps[i]).reduce(  (s, e) => s + (e.view || 0), 0);
    rawDeltas.push(cs - ps);
    rawTimes.push(allSnaps[i].time);
  }

  // 分数权重重采样：面积守恒，无数据丢失
  // 每个输入点按其与输出桶的重叠比例分配权重，边界点按比例贡献给相邻两桶
  let labels, data;
  const dsmDelta = getDownsampleMax();
  if (rawDeltas.length <= dsmDelta) {
    labels = rawTimes.map(fmtTimeLabel);
    data   = rawDeltas;
  } else {
    const M = rawDeltas.length;
    const N = dsmDelta;
    const outData = new Array(N).fill(0);
    for (let i = 0; i < M; i++) {
      const lo = i * N / M;
      const hi = (i + 1) * N / M;
      const bStart = Math.floor(lo);
      const bEnd   = Math.min(Math.ceil(hi) - 1, N - 1);
      for (let b = bStart; b <= bEnd; b++) {
        const ovLo = Math.max(lo, b);
        const ovHi = Math.min(hi, b + 1);
        if (ovHi <= ovLo) continue;
        outData[b] += rawDeltas[i] * (ovHi - ovLo) * M / N; // weight = overlap / (N/M)
      }
    }
    data = outData.map(Math.round);
    // 标签取每个输出桶中心对应的输入时间
    labels = Array.from({ length: N }, (_, b) => {
      const idx = Math.min(Math.round((b + 0.5) * M / N), M - 1);
      return fmtTimeLabel(rawTimes[idx]);
    });
  }

  if (S.charts.delta) S.charts.delta.destroy();
  S.charts.delta = new Chart(getCtx('delta', 'chart-delta'), {
    type: 'line',
    data: { labels, datasets: [{
      label: '播放增量', data,
      borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)',
      borderWidth: 2, fill: true, tension: 0.35,
      pointRadius: 0, pointHoverRadius: 5,
      segment: {
        borderColor:     ctx => ctx.p1.parsed.y < 0 ? 'rgba(239,68,68,0.8)'  : 'rgba(16,185,129,0.8)',
        backgroundColor: ctx => ctx.p1.parsed.y < 0 ? 'rgba(239,68,68,0.06)' : 'rgba(16,185,129,0.06)'
      }
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` 增量：${fmtFull(c.raw)}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 12, color: '#94a3b8' } },
        y: { grid: { color: '#f1f5f9' }, ticks: { color: '#94a3b8', callback: fmtAxis } }
      }
    }
  });
}
