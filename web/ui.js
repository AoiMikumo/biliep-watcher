// ── UI 层：DOM 构建 + 页面组件 ──────────────────────────────────────
import { VERSION, STAT_DEFS, TABLE_COLS, WINDOWS, MANY_EP, MULTI_DEF, ML, METRIC_ICONS } from './config.js';
import { fmt, fmtFull, fmtPct, fmtDate, shortT, attachTip, parseBeijingTime, computeComposite } from './utils.js';
import { S } from './state.js';
import { filterEps, filteredInfoEps, pickBaselineSnap,
         updateWindowNote, updateWindowAvailability } from './data.js';

// ── DOM 骨架初始化（应用启动时调用一次）──────────────────────────────
export function buildDOM() {
  document.getElementById('version-badge').textContent = 'v' + VERSION;
  const tr = document.getElementById('table-head');
  TABLE_COLS.forEach(c => {
    const th = document.createElement('th');
    th.dataset.col = c.col;
    if (c.width) th.style.width = c.width;
    if (c.num) th.className = 'cell-num';
    th.textContent = c.label;
    if (c.sortable) {
      const si = document.createElement('span');
      si.className = 'si';
      si.textContent = '↕';
      th.appendChild(si);
    }
    tr.appendChild(th);
  });
}

// ── 错误 & Toast ──────────────────────────────────────────────────────
export function showError(title, detail) {
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('error-screen').style.display  = '';
  document.getElementById('error-msg').textContent        = title;
  document.getElementById('error-detail').textContent     = detail || '';
}

let _toastTimer;
export function showToast(msg) {
  const el = document.getElementById('refresh-toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Header ────────────────────────────────────────────────────────────
export function updateHeaderMeta() {
  const last    = S.snapshots[S.snapshots.length - 1];
  const first   = S.snapshots[0];
  const elapsed = S.snapshots.length > 1
    ? (parseBeijingTime(last.time) - parseBeijingTime(first.time)) / 3600000
    : 0;
  document.title = S.info.season_title + ' · 合集数据分析';
  document.getElementById('hd-title').textContent = S.info.season_title;
  document.getElementById('hd-sub').textContent =
    `合集 ${S.info.season_id} · ${S.info.sections.length} 个小节 · 共 ${S.info.episodes.length} 个视频`;
  document.getElementById('hd-update').textContent    = '最后更新：' + last.time;
  document.getElementById('hd-snapshots').textContent = `已采集 ${S.snapshots.length} 次快照`;
  document.getElementById('hd-range').textContent =
    S.snapshots.length > 1
      ? '跨度 ' + (elapsed < 1 ? Math.round(elapsed * 60) + ' 分钟' : elapsed.toFixed(1) + ' 小时')
      : '首次采样';
}

// ── 统计卡片 ──────────────────────────────────────────────────────────
// 图标 / 标签是静态的，只构建一次；刷新、切窗口、改筛选时只更新数值与增量，
// 不重建 DOM —— 否则每次都会重新创建 7 个图标 <img> 并向服务器重复请求图片。
export function buildStatCards() {
  const last     = S.snapshots[S.snapshots.length - 1];
  const baseline = pickBaselineSnap(S.deltaWindowHours);
  const totals = {}, firsts = {};
  Object.keys(ML).forEach(m => {
    totals[m] = filterEps(last).reduce((s, e)     => s + (e[m] || 0), 0);
    firsts[m] = filterEps(baseline).reduce((s, e) => s + (e[m] || 0), 0);
  });
  const el = document.getElementById('stat-cards');

  // 首次：构建静态骨架（图标 + 标签），图片只在此创建一次
  if (el.children.length !== STAT_DEFS.length) {
    el.innerHTML = '';
    STAT_DEFS.forEach(d => {
      const div = document.createElement('div');
      div.className = 'stat-card';
      div.style.setProperty('--accent', d.accent);

      const iconSpan = document.createElement('span');
      iconSpan.className = 'stat-icon';
      const iconImg = document.createElement('img');
      iconImg.src = 'web/' + d.icon;
      iconImg.alt = d.label;
      iconImg.className = 'stat-icon-img';
      iconSpan.appendChild(iconImg);

      const valueDiv = document.createElement('div');
      valueDiv.className = 'stat-value';

      const labelDiv = document.createElement('div');
      labelDiv.className = 'stat-label';
      labelDiv.textContent = d.label;

      const growthDiv = document.createElement('div');
      growthDiv.className = 'stat-growth';

      div.appendChild(iconSpan);
      div.appendChild(valueDiv);
      div.appendChild(labelDiv);
      div.appendChild(growthDiv);
      el.appendChild(div);
    });
  }

  // 每次：只刷新数值与增量
  STAT_DEFS.forEach((d, i) => {
    const card      = el.children[i];
    const val       = totals[d.key] || 0;
    const growth    = val - (firsts[d.key] || 0);
    card.querySelector('.stat-value').textContent = fmtFull(val);

    const growthDiv = card.querySelector('.stat-growth');
    growthDiv.innerHTML = '';
    if (growth > 0) {
      growthDiv.className = 'stat-growth up';
      const arrow = document.createElement('span'); arrow.textContent = '▲';
      const text  = document.createElement('span'); text.textContent  = fmt(growth);
      growthDiv.appendChild(arrow); growthDiv.appendChild(text);
    } else if (growth < 0) {
      growthDiv.className = 'stat-growth down';
      const arrow = document.createElement('span'); arrow.textContent = '▼';
      const text  = document.createElement('span'); text.textContent  = fmt(Math.abs(growth));
      growthDiv.appendChild(arrow); growthDiv.appendChild(text);
    } else {
      growthDiv.className = 'stat-growth zero';
      growthDiv.textContent = '暂无增量数据';
    }
  });
}

// ── 小节筛选栏 ────────────────────────────────────────────────────────
// 监测对象是「合集」，按小节筛选：勾选哪些小节，就重算这些小节（按当前归属）
// 下全部视频的数据。initFilterBar 只在首次启动时调用：构建 pill、绑定
// "全选/重置"按钮。刷新时调用 refreshFilterBar，保留用户已取消勾选的小节；
// 新订阅的小节自动以"勾选"状态加入。
export function initFilterBar(onChange) {
  if (S.info.sections.length <= 1) return;
  refreshFilterBar(onChange);
  document.getElementById('filter-all-btn').addEventListener('click', () => {
    const container = document.getElementById('filter-pills');
    const pills     = container.querySelectorAll('.filter-pill');
    const allActive = Array.prototype.every.call(pills, p => p.classList.contains('active'));
    pills.forEach(p => {
      if (allActive) p.classList.remove('active');
      else p.classList.add('active');
    });
    _syncFilterState();
    onChange();
  });
}

// 重建筛选栏的 pill，复用当前已取消勾选的小节集合，保证用户筛选状态不丢失。
export function refreshFilterBar(onChange) {
  const sections  = S.info.sections;
  const row       = document.getElementById('filter-row');
  const container = document.getElementById('filter-pills');
  if (sections.length <= 1) { row.style.display = 'none'; return; }
  row.style.display = '';

  // 每个小节当前的视频数（按当前归属）
  const countBySec = {};
  S.info.episodes.forEach(ep => { countBySec[ep.section_id] = (countBySec[ep.section_id] || 0) + 1; });

  // 记录现存 pill 中处于"未勾选"状态的小节 id（用户主动取消的）
  const deselected = new Set();
  container.querySelectorAll('.filter-pill').forEach(p => {
    if (!p.classList.contains('active')) deselected.add(Number(p.dataset.sid));
  });

  container.innerHTML = '';
  sections.forEach(sec => {
    const btn = document.createElement('button');
    btn.className   = 'filter-pill' + (deselected.has(sec.id) ? '' : ' active');
    btn.textContent = `${shortT(sec.title, 12)} (${countBySec[sec.id] || 0})`;
    btn.dataset.sid = sec.id;
    attachTip(btn, () => `${sec.title} · ${countBySec[sec.id] || 0} 个视频`);
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      _syncFilterState();
      onChange();
    });
    container.appendChild(btn);
  });
  _syncFilterState();
}

function _syncFilterState() {
  const pills  = document.querySelectorAll('#filter-pills .filter-pill');
  const active = [];
  pills.forEach(p => { if (p.classList.contains('active')) active.push(Number(p.dataset.sid)); });
  S.selectedSections = (active.length === S.info.sections.length) ? null : new Set(active);
}

// ── 时间窗口选择器 ────────────────────────────────────────────────────
export function initWindowSelector(onChange) {
  const container = document.getElementById('window-pills');
  WINDOWS.forEach(w => {
    const btn = document.createElement('button');
    btn.className     = 'window-pill';
    btn.textContent   = w.label;
    btn.dataset.hours = String(w.hours);
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      S.deltaWindowHours = w.hours;
      localStorage.setItem('bv_delta_window', String(w.hours));
      container.querySelectorAll('.window-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateWindowNote();
      onChange();
    });
    container.appendChild(btn);
  });
  updateWindowAvailability();
}

// ── 排序切换（通用辅助） ──────────────────────────────────────────────
function _setSegActive(seg, mode) {
  seg.querySelectorAll('.seg-opt').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
}

// ── 排序切换按钮 ──────────────────────────────────────────────────────
export function initSortToggles(onBarRebuild, onEngRebuild) {
  // 从缓存恢复排序偏好
  const cachedBar = localStorage.getItem('bv_bar_sort');
  if (cachedBar === 'val' || cachedBar === 'list') S.barSortByValue = cachedBar === 'val';
  const cachedEng = localStorage.getItem('bv_eng_sort');
  if (cachedEng === 'val' || cachedEng === 'list') S.engSortByValue = cachedEng === 'val';
  const barSeg = document.getElementById('bar-seg');
  const engSeg = document.getElementById('eng-seg');
  barSeg.querySelectorAll('.seg-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      S.barSortByValue = btn.dataset.mode === 'val';
      localStorage.setItem('bv_bar_sort', S.barSortByValue ? 'val' : 'list');
      _setSegActive(barSeg, S.barSortByValue ? 'val' : 'list');
      onBarRebuild();
    });
  });
  engSeg.querySelectorAll('.seg-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      S.engSortByValue = btn.dataset.mode === 'val';
      localStorage.setItem('bv_eng_sort', S.engSortByValue ? 'val' : 'list');
      _setSegActive(engSeg, S.engSortByValue ? 'val' : 'list');
      onEngRebuild();
    });
  });
  _setSegActive(barSeg, S.barSortByValue ? 'val' : 'list');
  _setSegActive(engSeg, S.engSortByValue ? 'val' : 'list');
}

// ── 饼图模式切换 ──────────────────────────────────────────────────────
export function initPieToggle(onRebuild) {
  const seg = document.getElementById('pie-seg');
  seg.querySelectorAll('.seg-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      S.pieShowDelta = btn.dataset.mode === 'delta';
      _setSegActive(seg, S.pieShowDelta ? 'delta' : 'cum');
      onRebuild();
    });
  });
}

// ── 指标按钮组 ────────────────────────────────────────────────────────
export function setupBtns(containerId, defaultMetric, onChange) {
  const container = document.getElementById(containerId);
  Object.keys(ML).forEach(m => {
    const btn = document.createElement('button');
    btn.className      = 'metric-btn' + (m === defaultMetric ? ' active' : '');
    btn.title          = ML[m];
    btn.dataset.metric = m;
    const img = document.createElement('img');
    img.src = 'web/' + METRIC_ICONS[m];
    img.alt = ML[m];
    img.className = 'metric-btn-icon';
    btn.appendChild(img);
    btn.addEventListener('click', () => {
      container.querySelectorAll('.metric-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(m);
    });
    container.appendChild(btn);
  });
}

// ── 多折线"显示全部"切换 ──────────────────────────────────────────────
export function setupMultiToggle(onRebuild) {
  const btn    = document.getElementById('multi-toggle');
  const manyEp = filteredInfoEps().length > MANY_EP;
  if (!manyEp) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  btn.textContent   = '显示全部';
  btn.addEventListener('click', () => {
    S.multiShowAll = !S.multiShowAll;
    btn.textContent = S.multiShowAll ? '仅 Top ' + MULTI_DEF : '显示全部';
    btn.classList.toggle('active', S.multiShowAll);
    onRebuild();
  });
}

// ── 数据表格 ──────────────────────────────────────────────────────────
export function buildTable() {
  const last     = S.snapshots[S.snapshots.length - 1];
  const baseline = pickBaselineSnap(S.deltaWindowHours);
  const latestByAid = {}, firstByAid = {};
  filterEps(last).forEach(e     => { latestByAid[e.aid] = e; });
  filterEps(baseline).forEach(e => { firstByAid[e.aid]  = e; });

  S.tableData = filteredInfoEps().map(ep => {
    const lat  = latestByAid[ep.aid] || {};
    const fir  = firstByAid[ep.aid]  || {};
    const view = lat.view || 0;
    const like = lat.like || 0;
    return {
      aid: ep.aid, bvid: ep.bvid, title: ep.title, pubdate: ep.pubdate,
      view, like,
      coin: lat.coin || 0, fav: lat.fav || 0,
      danmaku: lat.danmaku || 0, reply: lat.reply || 0, share: lat.share || 0,
      composite: computeComposite(lat),
      viewGrowth: view - (fir.view || 0)
    };
  });

  if (!buildTable._bound) {
    document.querySelectorAll('#data-table thead th[data-col]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (col === 'title') return;
        if (col === 'rank') {
          if (S.sortCol === null) { S.sortAsc = !S.sortAsc; }
          else { S.sortCol = null; S.sortAsc = false; }
          document.querySelectorAll('#data-table thead th').forEach(t => {
            t.classList.remove('sorted');
            const si = t.querySelector('.si');
            if (si) si.textContent = '↕';
          });
          th.classList.add('sorted');
          const rankIcon = th.querySelector('.si');
          if (rankIcon) rankIcon.textContent = S.sortAsc ? '↑' : '↓';
          renderRows();
          return;
        }
        if (S.sortCol === col) S.sortAsc = !S.sortAsc;
        else { S.sortCol = col; S.sortAsc = false; }
        document.querySelectorAll('#data-table thead th').forEach(t => {
          t.classList.remove('sorted');
          const si = t.querySelector('.si');
          if (si) si.textContent = '↕';
        });
        th.classList.add('sorted');
        const icon = th.querySelector('.si');
        if (icon) icon.textContent = S.sortAsc ? '↑' : '↓';
        renderRows();
      });
    });
    buildTable._bound = true;
  }
  renderRows();
}

function renderRows() {
  const sorted = S.sortCol
    ? S.tableData.slice().sort((a, b) => {
        const va = a[S.sortCol], vb = b[S.sortCol];
        return typeof va === 'number' ? (S.sortAsc ? va - vb : vb - va) : 0;
      })
    : (S.sortAsc ? S.tableData.slice().reverse() : S.tableData.slice());

  const fragment = document.createDocumentFragment();
  sorted.forEach((row, di) => {
    const tr = document.createElement('tr');

    // rank
    const tdRank = document.createElement('td');
    tdRank.className = 'rank-cell';
    const rankSpan = document.createElement('span');
    rankSpan.style.color = '#94a3b8';
    rankSpan.textContent = di + 1;
    tdRank.appendChild(rankSpan);

    // title
    const tdTitle = document.createElement('td');
    tdTitle.className = 'ep-title-cell';
    const link = document.createElement('a');
    link.href   = `https://www.bilibili.com/video/${row.bvid}`;
    link.target = '_blank';
    link.rel    = 'noopener noreferrer';
    link.textContent = row.title;
    tdTitle.appendChild(link);

    // view (bold)
    const tdView = document.createElement('td');
    tdView.className = 'cell-num';
    const strong = document.createElement('strong');
    strong.textContent = fmtFull(row.view);
    tdView.appendChild(strong);

    // like / coin / fav / danmaku / reply / share
    const simpleTds = [row.like, row.coin, row.fav, row.danmaku, row.reply, row.share].map(val => {
      const td = document.createElement('td');
      td.className = 'cell-num';
      td.textContent = fmtFull(val);
      return td;
    });

    // composite
    const tdComposite = document.createElement('td');
    tdComposite.className = 'cell-num';
    if (row.composite > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-info';
      badge.textContent = fmt(row.composite);
      tdComposite.appendChild(badge);
    } else {
      tdComposite.style.color = '#cbd5e1';
      tdComposite.textContent = '—';
    }

    // viewGrowth：列名已表明"增长"，无需三角；负值用 '-' 前缀，颜色 badge 区分正负零
    const tdGrowth = document.createElement('td');
    tdGrowth.className = 'cell-num';
    const growthBadge = document.createElement('span');
    if (row.viewGrowth > 0) {
      growthBadge.className = 'badge badge-up';
      growthBadge.textContent = fmt(row.viewGrowth);
    } else if (row.viewGrowth < 0) {
      growthBadge.className = 'badge badge-down';
      growthBadge.textContent = '-' + fmt(Math.abs(row.viewGrowth));
    } else {
      growthBadge.className = 'badge badge-zero';
      growthBadge.textContent = '—';
    }
    tdGrowth.appendChild(growthBadge);

    // pubdate
    const tdPub = document.createElement('td');
    tdPub.className = 'pub-date';
    tdPub.textContent = fmtDate(row.pubdate);

    tr.appendChild(tdRank);
    tr.appendChild(tdTitle);
    tr.appendChild(tdView);
    simpleTds.forEach(td => tr.appendChild(td));
    tr.appendChild(tdComposite);
    tr.appendChild(tdGrowth);
    tr.appendChild(tdPub);
    fragment.appendChild(tr);
  });

  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  tbody.appendChild(fragment);
  tbody.style.opacity = '0';
  requestAnimationFrame(() => { tbody.style.opacity = '1'; });
}
