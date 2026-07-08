# B 站合集数据看板 · watcher

一个轻量的自托管工具：**定时采集 B 站「视频合集」的播放/互动数据，并提供一个零依赖的网页看板做可视化分析。**

- 采集端（`server/`）每隔固定分钟数对接 B 站公开接口，把整个合集的累计数据按快照追加保存。
- 看板（`web/`）直接读取这些数据文件，提供总量趋势、增量、占比、各视频排行、综合评分、趋势对比、明细表等图表，并可**按小节筛选**。

---

## 特性

- 🛰 **定时采集**：对齐整点的固定间隔（默认 10 分钟）持续记录，进程重启不丢节奏、不累积漂移。
- 📦 **以「合集」为单位**：一个合集一组数据文件；小节只是数据里的一个字段。
- 🔁 **视频跨小节移动无突变**：每个视频按**当前**所属小节贯穿其全部历史归类，所以"被移出的小节"不会数据突降、"移入的小节"不会突增。
- 🧾 **无损的归属变更日志**：视频迁入 / 在小节间迁移 / 迁出合集都会作为事件追加到 `moves`，历史一条不丢。
- 🔌 **零依赖**：采集端纯 Node 标准库；前端原生 ES Module，唯一外部资源是 CDN 上的 Chart.js。
- 🪶 **接口友好**：每个合集每个采集周期只发 **1 次**请求（一次响应即含合集全部小节），无需登录 Cookie。

---

## 工作原理

```
                       ┌──────────────────┐   每 N 分钟，每个合集 1 次请求
 server/list.json ───▶ │ server/watcher.js │ ───────────────────▶  B 站 view 接口
   (要追踪的合集)       └─────────┬────────┘      (含 ugc_season：全部小节 + 投稿)
                                 │ 解析 + 落盘
                                 ▼
        web/data/season_<id>.json   元数据 + 当前归属 + moves 变更日志
        web/data/season_<id>.jsonl  纯事实快照（每周期 1 行，追加）
                                 │
                                 ▼  浏览器直读两份文件（无后端、无客户端合并）
                  web/ (静态站点根) ──▶  /index.html?seasonid=<id> 看板
```

采集用的是 B 站 `https://api.bilibili.com/x/web-interface/view?aid=<aid>` 接口：用合集里**任意一个**投稿的 av 号即可反查到整个合集的全部小节与投稿数据，**无需 Cookie**。

---

## 目录结构

```
biliep-watcher/
├── server/                采集端（Node，常驻运行）
│   ├── watcher.js         采集器主程序
│   ├── lib.js             共享工具（HTTP、合集存储、moves 计算）
│   └── list.json          配置：要追踪哪些合集
├── web/                   看板（静态站点根，用静态服务器托管此目录）
│   ├── index.html         入口页面
│   ├── main.js  config.js  state.js  data.js  ui.js  charts.js  utils.js
│   ├── style.css
│   ├── src/               指标图标 (view/like/coin/fav/danmaku/reply/share .png)
│   └── data/              采集输出（运行时生成）
│       ├── season_<id>.json
│       └── season_<id>.jsonl
├── README.md
├── LICENSE
└── .gitignore
```

---

## 环境要求

- **Node.js 16+**（采集端，纯标准库，无需 `npm install`）。
- 任意**静态文件服务器**用于托管看板（nginx / caddy / `python -m http.server` 等）。
- 看板默认通过 CDN 加载 Chart.js（`web/index.html` 中的 `cdn.jsdelivr.net`）；内网环境可自行改为本地引入。

---

## 快速开始

### 1) 配置 `server/list.json`

填入要追踪的合集：

```json
[
  {
    "season_id": 8019898,
    "aids": [116496122514414, 116524559894334]
  }
]
```

| 字段 | 说明 |
|---|---|
| `season_id` | 合集 id（文件命名 / 看板 URL 用的就是它）。 |
| `aids` | 合集里**任意若干**投稿的 av 号；按顺序尝试，多填几个作容错（某个被删了还能用其它的反查）。 |

> 拿不到 id？打开合集里任一视频，调用 view 接口即可：响应中 `data.ugc_season.id` 就是 `season_id`，`data.aid` 就是该视频的 aid。
> ```bash
> curl -s "https://api.bilibili.com/x/web-interface/view?bvid=BV1xxxxxxxx" \
>   | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=JSON.parse(s).data;console.log("season_id =",u.ugc_season.id,"| aid =",u.aid)})'
> ```

`server/list.json` 每个采集周期都会被重新读取，**增删合集无需重启**采集器。采集器始终采集目标合集的全部小节数据；如果同一个 `season_id` 写了多条配置，会把这些条目的 `aids` 按顺序去重合并。接口返回的合集 id 必须与配置的 `season_id` 一致，否则本轮会跳过该配置，避免把数据写到错误合集文件。

### 2) 启动采集器

```bash
node server/watcher.js
```

进程会等到下一个对齐刻点开始采样，之后每隔 `INTERVAL_MIN`（默认 10）分钟采一次，数据追加写入 `web/data/`。建议用 `pm2` / `systemd` / `nohup` 等常驻运行。

### 3) 部署看板

把 **`web/` 目录**作为静态站点根目录托管（数据就在它下面的 `data/`），然后访问：

```
http://<your-host>/index.html?seasonid=8019898
```

`?seasonid=<合集 id>` 是必填参数。采集器与静态服务器可同机运行——前者写 `web/data/`，后者发 `web/` 即可。

nginx 示例：

```nginx
location /bili/ {
    alias /path/to/biliep-watcher/web/;
    add_header Cache-Control "no-store";   # data/ 频繁更新，建议禁缓存
}
```

---

## 配置项

`server/watcher.js` 顶部：

| 常量 | 默认 | 说明 |
|---|---|---|
| `INTERVAL_MIN` | `10` | 采样间隔（分钟），**必须能整除 60**（1/2/3/4/5/6/10/12/15/20/30/60）。 |
| `LIST_FILE` | `server/list.json` | 合集配置文件路径（与采集端代码同级）。 |

---

## 数据文件结构

### `season_<id>.json` —— 元数据 + 当前归属 + 变更日志

仅在标题 / 小节列表 / 投稿集合 / 归属发生变化时才重写。

```jsonc
{
  "season_id": 8019898,
  "season_title": "【异环】自制公交线路",
  "update_time": "2026-06-28 14:19:59",
  "sections": [ { "id": 8911254, "title": "最新POV" }, … ],          // 小节清单
  "episodes": [                                                       // 当前成员（每个 aid 只属一个小节）
    { "aid": …, "bvid": "BV…", "title": "…", "pubdate": 1777604400, "section_id": 8911254 }
  ],
  "moves": [                                                          // 归属变更事件（追加）
    { "time": "…", "aid": …, "title": "…", "from": null,    "to": 8911254 },  // 迁入合集
    { "time": "…", "aid": …, "title": "…", "from": 8911254, "to": 9166403 },  // 小节间迁移
    { "time": "…", "aid": …, "title": "…", "from": 9166403, "to": null     }   // 迁出合集
  ]
}
```

`moves` 中 `from`/`to` 为小节 id，`null` 表示「在合集之外」，三种归属变化统一成一条规则。

### `season_<id>.jsonl` —— 纯事实快照（每周期 1 行，只追加）

```jsonc
{ "time": "2026-06-28 14:19:59",
  "episodes": [
    { "aid": …, "view": 452, "danmaku": 0, "reply": 9, "fav": 11, "coin": 8, "share": 2, "like": 16 }
  ] }
```

> 原子记录就是 `(aid, time) → 指标`。小节归属是**元数据**（存在 `.json`，不在每条快照里重复）；历史归属由 `moves` 无损保留。

**约定**：时间统一北京时间（UTC+8）；日期 `yyyy-mm-dd`，时间戳 `yyyy-mm-dd hh:mm:ss`；JSON 元数据文件使用 2 空格缩进，JSONL 快照每行紧凑输出，UTF-8 无 BOM。

---

## 看板功能

- **增量统计窗口**：1h / 4h / 12h / 1d / 3d / 7d，按数据跨度自动启用，并据此计算各项增长。
- **小节筛选**：勾选哪些小节，就重算这些小节（按当前归属）下全部视频的所有图表与卡片。
- **图表**：七项指标统计卡、总量趋势、播放占比（总计/增量）、播放与互动排行（带轴折断）、综合评分（哔哩哔哩周刊算法）、各视频趋势对比（多折线，自动 Top N / 对数轴）、播放量增量、可排序明细表。
- **曲线从 0 起**：某视频中途首次出现且首值非 0 时，会在前一个采集点补 0，避免曲线凭空跳起。

---

## 设计要点

- **接口开销恒定**：每个合集每周期 1 次请求；一次 `ugc_season` 响应即含合集全部小节，加再多小节也不增加请求数。
- **存储与展示解耦**：数据文件保存全部真相（含历史归属 `moves`）；"按当前小节归类"是看板的展示策略，可随时调整而不动存储。
- **失败安全**：某次抓取失败则整段跳过，不会写半截快照、也不会误判"迁出"。

---

## 版本

当前 `1.4.2`（见 [`web/config.js`](web/config.js) 的 `VERSION`，同步页面版本徽章与标题）。

## 许可

本项目以 **GNU AGPL-3.0** 协议开源，完整条款见 [`LICENSE`](LICENSE)。

Copyright (C) 2026 MikumoAoi

本程序是自由软件：你可以在自由软件基金会发布的 GNU Affero 通用公共许可证（AGPL）第 3 版、或（由你选择的）任何更新版本的条款下，重新发布和/或修改它。
本程序按"现状"分发，不附带任何担保。

> ⚠️ 特别注意（AGPL 第 13 条 · 网络条款）：**若你修改了本程序，并将修改版作为网络服务提供给用户使用，必须向这些用户一并提供对应版本的完整源代码。**

详见 [`LICENSE`](LICENSE) 全文或 <https://www.gnu.org/licenses/>。

作者 **MikumoAoi** · 邮箱 lovelylychee2023@outlook.com · 哔哩哔哩 <https://space.bilibili.com/21587404>

## 免责声明

仅调用 B 站公开只读接口、用于对自有/公开内容的数据分析与学习；请遵守 B 站相关条款，合理设置采集间隔，勿滥用。
