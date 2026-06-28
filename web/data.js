// ── 数据访问层：加载、过滤、时间窗口逻辑 ───────────────────────────
import { WINDOWS } from './config.js';
import { parseBeijingTime, parseJsonl } from './utils.js';
import { S } from './state.js';

// ── 快照过滤（按选中的小节）─────────────────────────────────────────
// 一个视频归属哪个小节「全看当前时间节点」：S.aidSection 给出每个 aid 的
// 当前小节，并以此贯穿其全部历史。这样视频在小节间移动时，被移出的小节不会
// 数据突降、移入的小节不会突增。已彻底移出合集（不在任何当前小节）的 aid，
// 即便历史快照里仍有，也一并剔除。
export const filterEps = snap =>
  S.selectedSections
    ? snap.episodes.filter(e => S.selectedSections.has(S.aidSection[e.aid]))
    : snap.episodes.filter(e => S.aidSection[e.aid] !== undefined);

// 过滤 info.episodes（按当前小节归属）
export const filteredInfoEps = () =>
  S.selectedSections
    ? S.info.episodes.filter(e => S.selectedSections.has(e.section_id))
    : S.info.episodes;

// aid → { bvid, title, pubdate, idx } 映射
export function makeEpMap() {
  const m = {};
  S.info.episodes.forEach((ep, i) => {
    m[ep.aid] = { bvid: ep.bvid, title: ep.title, pubdate: ep.pubdate, idx: i + 1 };
  });
  return m;
}

// ── 时间窗口 ─────────────────────────────────────────────────────────
// 返回当前时间窗口内的快照切片
export function gWindowedSnaps() {
  if (!S.deltaWindowHours || S.snapshots.length <= 1) return S.snapshots;
  const lastMs = parseBeijingTime(S.snapshots[S.snapshots.length - 1].time).getTime();
  const cutoff = lastMs - S.deltaWindowHours * 3600000;
  let idx = 0;
  for (let i = 0; i < S.snapshots.length; i++) {
    if (parseBeijingTime(S.snapshots[i].time).getTime() >= cutoff) { idx = i; break; }
    idx = i;
  }
  return S.snapshots.slice(idx);
}

// 返回距"最新快照 - windowHours"最近的（不晚于该时刻的）快照作基线
export function pickBaselineSnap(windowHours) {
  if (!windowHours || S.snapshots.length <= 1) return S.snapshots[0];
  const lastMs = parseBeijingTime(S.snapshots[S.snapshots.length - 1].time).getTime();
  const cutoff = lastMs - windowHours * 3600000;
  let baseline = S.snapshots[0];
  for (let i = 0; i < S.snapshots.length - 1; i++) {
    if (parseBeijingTime(S.snapshots[i].time).getTime() <= cutoff) {
      baseline = S.snapshots[i];
    } else {
      break;
    }
  }
  return baseline;
}

// 当前窗口的短标签（用于卡片和表头）
export function windowDisplayLabel() {
  const w = WINDOWS.filter(x => x.hours === S.deltaWindowHours);
  return w.length ? w[0].label + '内增长' : '增长';
}

// 更新窗口提示文字
export function updateWindowNote() {
  const note = document.getElementById('window-note');
  if (!note || !S.snapshots.length) return;
  const baseline = pickBaselineSnap(S.deltaWindowHours);
  const last     = S.snapshots[S.snapshots.length - 1];
  if (baseline === last) { note.textContent = ''; return; }
  const diffMs = parseBeijingTime(last.time).getTime() - parseBeijingTime(baseline.time).getTime();
  const diffH  = diffMs / 3600000;
  // 只有当数据不足以覆盖目标窗口时才显示提示
  if (diffH >= S.deltaWindowHours * 0.95) { note.textContent = ''; return; }
  note.textContent = '基准快照：' + baseline.time +
    '（实际覆盖 ' + (diffH < 1 ? Math.round(diffH * 60) + ' 分钟' : diffH.toFixed(1) + ' 小时') + '）';
}

// 根据数据跨度启用/禁用各窗口，并自动选中合适的默认项
export function updateWindowAvailability() {
  if (!S.snapshots.length) return;
  const lastMs  = parseBeijingTime(S.snapshots[S.snapshots.length - 1].time).getTime();
  const firstMs = parseBeijingTime(S.snapshots[0].time).getTime();
  const spanH   = (lastMs - firstMs) / 3600000;
  const pills   = document.querySelectorAll('#window-pills .window-pill');
  let hasActive        = false;
  let foundFirstLarger = false;

  pills.forEach((btn, i) => {
    const w = WINDOWS[i];
    let available;
    if (spanH >= w.hours) {
      available = true;
    } else if (!foundFirstLarger) {
      available = true;
      foundFirstLarger = true;
    } else {
      available = false;
    }
    btn.disabled = !available;
    if (btn.classList.contains('active') && !available) btn.classList.remove('active');
    if (btn.classList.contains('active')) hasActive = true;
  });

  if (!hasActive) {
    const savedHours = +localStorage.getItem('bv_delta_window') || 0;
    let savedBtn = null, prefer1d = null, best = null;
    pills.forEach((btn, i) => {
      if (!btn.disabled) { best = btn; }
      if (WINDOWS[i].hours === savedHours && !btn.disabled) savedBtn = btn;
      if (WINDOWS[i].hours === 24 && !btn.disabled) prefer1d = btn;
    });
    if (best) {
      const chosen = savedBtn || prefer1d || best;
      chosen.classList.add('active');
      const idx = Array.prototype.indexOf.call(pills, chosen);
      S.deltaWindowHours = WINDOWS[idx] ? WINDOWS[idx].hours : 24;
    }
  }
  updateWindowNote();
}

// ── 数据加载 ─────────────────────────────────────────────────────────
// 合集为存储单位：直接读两份文件，无需客户端合并。
//   season_<id>.json  —— 元数据 + 当前小节归属 + moves 变更日志
//   season_<id>.jsonl —— 纯事实快照 { time, episodes:[{aid, 指标...}] }
// aid→当前小节 由 info.episodes[].section_id 给出（filterEps 据此按当前归属筛选）。
export function loadData(firstLoad, onInit, onRefresh, onError) {
  const params   = new URLSearchParams(window.location.search);
  const seasonId = params.get('seasonid');
  if (!seasonId || !/^\d+$/.test(seasonId)) {
    onError('参数非法', '请在 URL 中附带 ?seasonid=<整数>（合集 id）');
    return;
  }
  const btn = document.getElementById('refresh-btn');
  if (!firstLoad && btn) btn.classList.add('loading');
  const bust = `?_=${Date.now()}`;

  Promise.all([
    fetch(`data/season_${seasonId}.json${bust}`).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} (season_${seasonId}.json)`);
      return r.json();
    }),
    fetch(`data/season_${seasonId}.jsonl${bust}`).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} (season_${seasonId}.jsonl)`);
      return r.text();
    })
  ]).then(([info, jsonlText]) => {
    if (!info || !Array.isArray(info.sections) || !Array.isArray(info.episodes)) {
      throw new Error('合集元数据格式不正确（season_*.json）');
    }
    S.info       = info;
    S.snapshots  = parseJsonl(jsonlText);
    S.aidSection = {};
    info.episodes.forEach(ep => { S.aidSection[ep.aid] = ep.section_id; });
    if (!S.snapshots.length) throw new Error('暂无采样数据（season .jsonl 为空）');
    if (firstLoad) {
      onInit();
    } else {
      if (btn) btn.classList.remove('loading');
      onRefresh(null);
    }
  }).catch(e => {
    if (firstLoad) {
      onError('数据加载失败', e.message);
    } else {
      if (btn) btn.classList.remove('loading');
      onRefresh(e.message);
    }
  });
}
