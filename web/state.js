// ── 全局可变状态（通过属性赋值修改，各模块 import { S } 共享）────────
export const S = {
  // ── 原始数据 ────────────────────────────────────────────────────────
  info:       null,  // season_<id>.json：{ season_id, season_title, sections, episodes, moves }
  snapshots:  [],    // season_<id>.jsonl：纯事实快照 [{ time, episodes:[{aid, 指标...}] }]
  aidSection: {},    // aid → 当前小节 id（来自 info.episodes[].section_id，贯穿全部历史的归属）

  // ── UI 筛选 / 排序状态 ──────────────────────────────────────────────
  deltaWindowHours: 24,    // 当前增量时间窗口（小时）
  selectedSections: null,  // Set<sectionId>，null 表示全选
  barSortByValue:   false, // 条形图：true=按指标值降序，false=按列表顺序
  engSortByValue:   false, // 综合得分图：同上
  multiShowAll:     false, // 趋势对比：是否显示全部视频
  pieShowDelta:     false, // 饼图：false=总计，true=增量

  // ── 表格排序 ─────────────────────────────────────────────────────────
  tableData: [],
  sortCol:   null,
  sortAsc:   false,

  // ── Chart.js 实例（销毁重建时通过此处持有引用）─────────────────────
  charts: {
    trend:    null,
    pie:      null,
    bar:      null,
    engage:   null,
    multi:    null,
    delta:    null
  },

  // ── Canvas 2D 上下文缓存（避免重复 getContext）──────────────────────
  ctxs: {
    trend:    null,
    bar:      null,
    engage:   null,
    multi:    null,
    delta:    null
  }
};
