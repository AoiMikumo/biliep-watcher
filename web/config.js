// ── 全局配置 & 魔法数字 ─────────────────────────────────────────────
// 版本号（同步更新 buildDOM 里的版本徽章与 <title>）
export const VERSION = '1.4.0';

// 图表颜色序列
export const COLORS = [
  '#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6',
  '#06b6d4','#f97316','#84cc16','#ec4899','#6366f1',
  '#14b8a6','#a855f7','#0ea5e9','#d946ef','#22c55e',
  '#e11d48','#0284c7','#16a34a','#ca8a04','#7c3aed'
];

// 指标键 → 中文标签
export const ML = {
  view:'播放', like:'点赞', coin:'投币', fav:'收藏',
  danmaku:'弹幕', reply:'回复', share:'分享'
};

// 指标键 → 图标文件路径（相对于 web/ 目录）
export const METRIC_ICONS = {
  view:    'src/view.png',
  like:    'src/like.png',
  coin:    'src/coin.png',
  fav:     'src/fav.png',
  danmaku: 'src/danmaku.png',
  reply:   'src/reply.png',
  share:   'src/share.png'
};

// 统计卡片定义（key / 中文标签 / 图标 / 强调色）
export const STAT_DEFS = [
  { key:'view',    label:'总播放量', icon:'src/view.png',    accent:'#3b82f6' },
  { key:'like',    label:'总点赞数', icon:'src/like.png',    accent:'#ec4899' },
  { key:'coin',    label:'总投币数', icon:'src/coin.png',    accent:'#f59e0b' },
  { key:'fav',     label:'总收藏数', icon:'src/fav.png',     accent:'#8b5cf6' },
  { key:'danmaku', label:'总弹幕数', icon:'src/danmaku.png', accent:'#06b6d4' },
  { key:'reply',   label:'总回复数', icon:'src/reply.png',   accent:'#10b981' },
  { key:'share',   label:'总分享数', icon:'src/share.png',   accent:'#f97316' }
];

// 增量时间窗口选项
export const WINDOWS = [
  { label: '1h',  hours: 1   },
  { label: '4h',  hours: 4   },
  { label: '12h', hours: 12  },
  { label: '1d',  hours: 24  },
  { label: '3d',  hours: 72  },
  { label: '7d',  hours: 168 }
];

// 表格列定义
export const TABLE_COLS = [
  { col: 'rank',       label: '#',          width: '44px', num: false, sortable: true  },
  { col: 'title',      label: '标题',       width: '',     num: false, sortable: false },
  { col: 'view',       label: '播放',       width: '',     num: true,  sortable: true  },
  { col: 'like',       label: '点赞',       width: '',     num: true,  sortable: true  },
  { col: 'coin',       label: '投币',       width: '',     num: true,  sortable: true  },
  { col: 'fav',        label: '收藏',       width: '',     num: true,  sortable: true  },
  { col: 'danmaku',    label: '弹幕',       width: '',     num: true,  sortable: true  },
  { col: 'reply',      label: '回复',       width: '',     num: true,  sortable: true  },
  { col: 'share',      label: '分享',       width: '',     num: true,  sortable: true  },
  { col: 'composite',  label: '综合评分',   width: '',     num: true,  sortable: true  },
  { col: 'viewGrowth', label: '播放增长',   width: '',     num: true,  sortable: true  },
  { col: 'pubdate',    label: '发布时间',   width: '',     num: false, sortable: false }
];

// ── 阈值 & 上限 ──────────────────────────────────────────────────────
export const MANY_EP           = 15;   // 超过此值进入"高集数模式"
export const PIE_MAX           = 10;   // 饼图最多显示视频数
export const MULTI_DEF         = 12;   // 趋势对比默认显示 Top N
export const DOWNSAMPLE_MOBILE = 73;   // 移动端降采样阈值
export const DOWNSAMPLE_DESKTOP= 145;  // 桌面端降采样阈值
export const MOBILE_BP         = 768;  // 移动端断点（px）
export const BREAK_RATIO       = 5;    // 柱状图折断阈值：Max/P90 >= 此值（也用于多折线图的对数轴 outlier 检测）
export const OUTLIER_PCT       = 90;   // 异常值判断百分位

// 根据视口宽度返回当前适用的降采样阈值
export function getDownsampleMax() {
  return window.innerWidth < MOBILE_BP ? DOWNSAMPLE_MOBILE : DOWNSAMPLE_DESKTOP;
}
