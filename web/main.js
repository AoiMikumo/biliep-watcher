// ── 应用入口：初始化流程 & 全局协调 ────────────────────────────────
import { S } from './state.js';
import { loadData, updateWindowAvailability } from './data.js';
import { buildDOM, showError, showToast,
         updateHeaderMeta, buildStatCards,
         initFilterBar, refreshFilterBar, initWindowSelector,
         initSortToggles, initPieToggle, setupBtns, setupMultiToggle,
         buildTable } from './ui.js';
import { buildTrendChart, buildPieChart, buildBarChart,
         buildEngagementChart, buildMultiChart, buildDeltaChart } from './charts.js';

// ── Chart.js 全局默认字体 ────────────────────────────────────────────
Chart.defaults.font.family = "'PingFang SC','Microsoft YaHei',system-ui,sans-serif";
Chart.defaults.font.size   = 12;

// ── 构建 DOM 骨架 ────────────────────────────────────────────────────
buildDOM();

// ── 刷新按钮 ─────────────────────────────────────────────────────────
document.getElementById('refresh-btn').addEventListener('click', () => _loadData(false));

// ── 启动 ─────────────────────────────────────────────────────────────
_loadData(true);

// ── 内部：数据加载 ───────────────────────────────────────────────────
function _loadData(firstLoad) {
  loadData(firstLoad,
    /* onInit    */ () => _initDashboard(),
    /* onRefresh */ errMsg => {
      if (errMsg) {
        showToast('刷新失败：' + errMsg);
      } else {
        _refreshDashboard();
        showToast('数据已更新至 ' + S.snapshots[S.snapshots.length - 1].time);
      }
    },
    /* onError   */ (title, detail) => showError(title, detail)
  );
}

// ── 筛选栏变更回调（首次初始化和刷新时复用同一份）──────────────────
function _onFilterChange() {
  _buildAllCharts();
  buildStatCards();
  buildTable();
}

// ── 首次初始化（只运行一次） ──────────────────────────────────────────
function _initDashboard() {
  updateHeaderMeta();
  initWindowSelector(() => {
    buildStatCards();
    _buildAllCharts();
    buildTable();
  });
  initFilterBar(_onFilterChange);
  buildStatCards();
  setupBtns('trend-btns', 'view', m => buildTrendChart(m));
  setupBtns('bar-btns',   'view', m => { buildBarChart(m); _syncBarEngHeight(); });
  setupBtns('multi-btns', 'view', m => buildMultiChart(m));
  setupMultiToggle(() => buildMultiChart(_activeMetric('multi-btns')));
  initPieToggle(() => buildPieChart());
  initSortToggles(
    () => { buildBarChart(_activeMetric('bar-btns')); _syncBarEngHeight(); },
    () => { buildEngagementChart(); _syncBarEngHeight(); }
  );
  _buildAllCharts();
  buildTable();
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('dashboard').style.display = '';
}

// ── 刷新（重新拉取数据后）────────────────────────────────────────────
function _refreshDashboard() {
  updateHeaderMeta();
  refreshFilterBar(_onFilterChange);      // 新订阅的小节自动加入筛选栏，用户已取消的状态保留
  updateWindowAvailability();
  buildStatCards();
  _buildAllCharts();
  buildTable();
}

// ── 构建所有图表 ──────────────────────────────────────────────────────
function _buildAllCharts() {
  buildTrendChart(_activeMetric('trend-btns'));
  buildPieChart();
  buildBarChart(_activeMetric('bar-btns'));
  buildEngagementChart();
  _syncBarEngHeight();
  buildMultiChart(_activeMetric('multi-btns'));
  buildDeltaChart();
}

// ── 同步条形图与综合评分图高度 ───────────────────────────────────────
function _syncBarEngHeight() {
  const barWrap = document.getElementById('bar-chart-wrap');
  const engWrap = document.getElementById('engage-chart-wrap');
  if (!barWrap || !engWrap) return;
  // 读取 buildBarChart / buildEngagementChart 刚设好的动态高度，取其中较大的作基准
  const barH  = parseInt(barWrap.style.height) || 200;
  const engH  = parseInt(engWrap.style.height) || 200;
  const baseH = Math.max(barH, engH);
  requestAnimationFrame(() => {
    const barHd  = barWrap.parentElement ? barWrap.parentElement.querySelector('.card-hd') : null;
    const engHd  = engWrap.parentElement ? engWrap.parentElement.querySelector('.card-hd') : null;
    const barHdH = barHd ? barHd.offsetHeight : 0;
    const engHdH = engHd ? engHd.offsetHeight : 0;
    const hdDiff = barHdH - engHdH; // 正值：bar 头部更高；负值：eng 头部更高
    barWrap.style.height = (baseH + Math.max(0, -hdDiff)) + 'px';
    engWrap.style.height = (baseH + Math.max(0,  hdDiff)) + 'px';
  });
}

// ── 获取当前激活的指标按钮 ────────────────────────────────────────────
function _activeMetric(containerId) {
  const el = document.querySelector(`#${containerId} .metric-btn.active`);
  return el ? el.dataset.metric : 'view';
}
