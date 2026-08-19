'use strict';
// server/lib.js — shared helpers for watcher.js.

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ROOT     = __dirname;                              // server/ —— list.json 与本目录同级
const DATA_DIR = path.join(ROOT, '..', 'web', 'data');   // 数据落在看板的静态根 web/ 下

// ── Date / time (Beijing UTC+8) ───────────────────────────────────────────────

function nowTime() {
    const d   = new Date(Date.now() + 8 * 3600 * 1000);
    const y   = d.getUTCFullYear();
    const mo  = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h   = String(d.getUTCHours()).padStart(2, '0');
    const mi  = String(d.getUTCMinutes()).padStart(2, '0');
    const s   = String(d.getUTCSeconds()).padStart(2, '0');
    return `${y}-${mo}-${day} ${h}:${mi}:${s}`;
}

// ── File I/O ──────────────────────────────────────────────────────────────────

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function dataPath(name) { return path.join(DATA_DIR, name); }

function loadJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}

// Append one JSONL line (no trailing newline on the very first write is fine;
// every line is terminated so subsequent reads are unambiguous).
function appendJsonl(filePath, obj) {
    ensureDataDir();
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

const HEADERS = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'Referer':         'https://www.bilibili.com/',
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
};
const TIMEOUT_MS = 15_000;

function fetchView(aid) {
    return new Promise((resolve, reject) => {
        const url = `https://api.bilibili.com/x/web-interface/view?aid=${aid}`;
        const req = https.get(url, { headers: HEADERS }, res => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', c => buf += c);
            res.on('end', () => {
                try {
                    const obj = JSON.parse(buf);
                    if (obj.code !== 0)
                        return reject(new Error(`API code=${obj.code} msg=${obj.message}`));
                    resolve(obj.data);
                } catch (e) { reject(e); }
            });
        });
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('Request timed out')));
        req.on('error', reject);
    });
}

// Attempt once; on failure wait 1-2 s and retry exactly once more.
async function fetchViewWithRetry(aid) {
    try {
        return await fetchView(aid);
    } catch (e) {
        await sleep(1000 + Math.floor(Math.random() * 1000));
        return await fetchView(aid);   // let caller handle second failure
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Season fetch + section extraction ────────────────────────────────────────
// Try aids in order until one returns a valid ugc_season response.
// Returns { seasonData } or throws if all aids fail.

async function fetchSeason(aids, expectedSeasonId) {
    const errors = [];
    for (const aid of aids) {
        try {
            const data = await fetchViewWithRetry(aid);
            if (!data.ugc_season)
                throw new Error(`aid=${aid}: no ugc_season in response`);
            if (expectedSeasonId != null && data.ugc_season.id !== expectedSeasonId)
                throw new Error(`aid=${aid}: resolved season=${data.ugc_season.id}, expected season=${expectedSeasonId}`);
            return data;
        } catch (e) {
            errors.push(e.message || String(e));
        }
    }
    throw new Error(errors.length ? errors.join('; ') : 'No aids provided');
}

// Given a ugc_season object, returns per-section metadata and pure-fact
// snapshots used to assemble the season-level files. Link key: aid.
function extractSectionData(ugc, time) {
    const results   = [];

    for (const sec of (ugc.sections ?? [])) {
        const basicEps    = [];
        const snapshotEps = [];

        for (const ep of (sec.episodes ?? [])) {
            const s = ep.arc?.stat ?? {};
            basicEps.push({
                aid:     ep.aid,
                bvid:    ep.bvid,
                title:   ep.title,
                pubdate: ep.arc?.pubdate ?? 0,
            });
            snapshotEps.push({
                aid:     ep.aid,
                view:    s.view    ?? 0,
                danmaku: s.danmaku ?? 0,
                reply:   s.reply   ?? 0,
                fav:     s.fav     ?? 0,
                coin:    s.coin    ?? 0,
                share:   s.share   ?? 0,
                like:    s.like    ?? 0,
            });
        }

        results.push({
            basic: {
                season_id:     ugc.id,
                section_id:    sec.id,
                section_title: sec.title,
                episodes:      basicEps,
            },
            snapshot: {
                time,
                episodes: snapshotEps,
            },
        });
    }
    return results;
}

// ── Per-season storage (合集为基本单位) ───────────────────────────────────────
// The monitored unit is the whole season. We store, per season:
//
//   data/season_<seasonId>.json   — metadata + current membership + a moves log
//     {
//       season_id, season_title, update_time,
//       sections: [{ id, title }, ...],
//       episodes: [{ aid, bvid, title, pubdate, section_id }, ...],  // current 归属
//       moves:    [{ time, aid, title, from, to }, ...]              // 归属变更事件
//     }                                                              // from/to=null ⇒ 合集之外
//
//   data/season_<seasonId>.jsonl  — pure facts, one snapshot per cycle (append-only)
//     { time, episodes: [{ aid, view, danmaku, reply, fav, coin, share, like }, ...] }
//
// The atomic record is (aid, time) → stats; section membership is metadata kept
// once in the .json (not repeated per snapshot). Membership history is preserved
// losslessly as discrete events in `moves`.

function seasonJsonPath(id)  { return dataPath(`season_${id}.json`); }
function seasonJsonlPath(id) { return dataPath(`season_${id}.jsonl`); }
function seasonArchivePath(id) { return dataPath(`season_${id}.archive.jsonl`); }
function seasonStatsPath(id)  { return dataPath(`season_${id}.stats.json`); }

// 热数据保留窗口：最近 30 天（相对最新快照，而非墙钟——老数据/补录时语义一致）。
const RETENTION_HOURS = 30 * 24;

function parseSnapTime(s) { return new Date(s.replace(' ', 'T') + '+08:00').getTime(); }
function fmtBeijing(ms) {
    const d = new Date(ms + 8 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
        `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function firstLineTime(file) {
    if (!fs.existsSync(file)) return null;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    try { return JSON.parse(buf.toString('utf8', 0, n).split('\n')[0]).time ?? null; } catch (_) { return null; }
}
function lastLineTime(file) {
    if (!fs.existsSync(file)) return null;
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(4096, size));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fd);
    const tail = buf.toString('utf8').trim().split('\n').pop();
    try { return JSON.parse(tail).time ?? null; } catch (_) { return null; }
}

// 热数据保留维护：jsonl 首条快照已老于 30d 时，把过期行挪进 archive（append），
// 热文件重写为窗口内部分。无过期时只读首行 2KB 即返回，代价可忽略。
// 返回 { moved }；同时只更新 stats.json 的 jsonl_bytes（不增计数）。
function rotateSeasonRetention(id) {
    const hot = seasonJsonlPath(id);
    const first = firstLineTime(hot);
    const last  = lastLineTime(hot);
    if (!first || !last) return { moved: 0 };
    const cutoff = fmtBeijing(parseSnapTime(last) - RETENTION_HOURS * 3600 * 1000);
    if (first >= cutoff) return { moved: 0 };

    const text  = fs.readFileSync(hot, 'utf8');
    const lines = text.split('\n');
    const tailEmpty = lines[lines.length - 1] === '';
    if (tailEmpty) lines.pop();
    let split = 0;
    while (split < lines.length) {
        const m = /"time":"([^"]+)"/.exec(lines[split]);
        if (m && m[1] >= cutoff) break;
        split++;
    }
    if (split === 0) return { moved: 0 };

    const moved = lines.slice(0, split);
    const kept  = lines.slice(split);
    ensureDataDir();
    fs.appendFileSync(seasonArchivePath(id), moved.join('\n') + '\n', 'utf8');
    fs.writeFileSync(hot, kept.join('\n') + '\n', 'utf8');

    const stats = loadJson(seasonStatsPath(id), null);
    if (stats) {
        stats.jsonl_bytes = fs.statSync(hot).size;
        fs.writeFileSync(seasonStatsPath(id), JSON.stringify(stats, null, 2), 'utf8');
    }
    return { moved: moved.length };
}

function countJsonlLines(file) {
    if (!fs.existsSync(file)) return 0;
    const text = fs.readFileSync(file, 'utf8');
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
    return n;
}

// 采集统计（快照总数/首尾时间/字节数）：常规每周期 +1；stats.json 缺失时（升级/重建）
// 从热文件 + 归档文件的真实行数播种，first_time 依次取归档/热文件的首行时间。
// 前端据它渲染头部信息与窗口可用性，无需为"已采集 N 次 / 跨度"下载全量历史。
function writeSeasonStats(id, time) {
    const jsonlPath = seasonJsonlPath(id);
    const prev = loadJson(seasonStatsPath(id), null);
    let count, firstTime;
    if (prev && prev.snapshot_count != null) {
        count = prev.snapshot_count + 1;
        firstTime = prev.first_time;
    } else {
        // 本周期快照已先行追加，行数即累计采集次数
        count = countJsonlLines(jsonlPath) + countJsonlLines(seasonArchivePath(id));
        if (count === 0) count = 1;
        firstTime = firstLineTime(seasonArchivePath(id)) ?? firstLineTime(jsonlPath) ?? time;
    }
    ensureDataDir();
    fs.writeFileSync(seasonStatsPath(id), JSON.stringify({
        snapshot_count: count,
        first_time: firstTime,
        last_time: time,
        jsonl_bytes: fs.existsSync(jsonlPath) ? fs.statSync(jsonlPath).size : 0,
    }, null, 2), 'utf8');
}

// From the per-section extraction, assemble the season-level metadata (current
// membership) and the pure-facts snapshot for this cycle. An aid belongs to one
// section per cycle, so the first occurrence wins on the (rare) chance of a dup.
function assembleSeason(ugc, sectionData, time) {
    const sections = sectionData.map(({ basic }) => ({ id: basic.section_id, title: basic.section_title }));
    const episodes = [];
    const factsEps = [];
    const seenMeta = new Set();
    const seenFact = new Set();
    for (const { basic, snapshot } of sectionData) {
        for (const ep of basic.episodes) {
            if (seenMeta.has(ep.aid)) continue;
            seenMeta.add(ep.aid);
            episodes.push({
                aid: ep.aid, bvid: ep.bvid, title: ep.title,
                pubdate: ep.pubdate, section_id: basic.section_id,
            });
        }
        for (const e of snapshot.episodes) {
            if (seenFact.has(e.aid)) continue;
            seenFact.add(e.aid);
            factsEps.push(e);
        }
    }
    return {
        meta:  { season_id: ugc.id, season_title: ugc.title ?? '', sections, episodes },
        facts: { time, episodes: factsEps },
    };
}

// Diff previous membership vs new; emit one event per aid whose section changed.
// Covers join (from=null), inter-section move, and leave (to=null) uniformly.
function computeMoves(prevEpisodes, newEpisodes, time) {
    const prev = new Map((prevEpisodes ?? []).map(e => [e.aid, e]));
    const next = new Map(newEpisodes.map(e => [e.aid, e]));
    const events = [];
    for (const [aid, e] of next) {
        const from = prev.has(aid) ? prev.get(aid).section_id : null;
        if (from !== e.section_id) events.push({ time, aid, title: e.title, from, to: e.section_id });
    }
    for (const [aid, e] of prev) {
        if (!next.has(aid)) events.push({ time, aid, title: e.title, from: e.section_id, to: null });
    }
    return events;
}

function episodesKey(eps) {
    return (eps ?? []).map(e => `${e.aid}:${e.section_id}:${e.title}`).join('|');
}

// 槽位去重键：把快照时间归并到 slotMin 分钟的对齐槽位。
// 槽位边界按 UTC 毫秒向下取整即可：北京时间偏移是整小时，整除 60 的
// 槽位在两种时区下边界一致。
function slotKey(timeStr, slotMin) {
    return Math.floor(parseSnapTime(timeStr) / (slotMin * 60000));
}

// Write the season metadata json (rewritten only when title / section list /
// episode set / membership changed, appending any new moves) and append one
// pure-facts line to the season jsonl every cycle.
// slotMin > 0 时启用槽位去重：热文件最后一条快照已与本次 time 同槽位时，
// 跳过追加与 stats 计数（元数据/moves 仍照常更新）——防止时钟回拨后定时器
// 重触发、或并行跑了第二个实例时在同一槽位写入第二条。
// Returns { movesAdded, metaChanged, snapSkipped }.
function writeSeason(ugc, sectionData, time, slotMin = 0) {
    const { meta, facts } = assembleSeason(ugc, sectionData, time);
    const jsonPath  = seasonJsonPath(ugc.id);
    const jsonlPath = seasonJsonlPath(ugc.id);

    const existing  = loadJson(jsonPath, null);
    const prevMoves = existing && Array.isArray(existing.moves) ? existing.moves : [];
    const newMoves  = computeMoves(existing ? existing.episodes : [], meta.episodes, time);

    const metaChanged = !existing
        || existing.season_title !== meta.season_title
        || JSON.stringify(existing.sections ?? []) !== JSON.stringify(meta.sections)
        || episodesKey(existing.episodes) !== episodesKey(meta.episodes)
        || newMoves.length > 0;

    if (metaChanged) {
        ensureDataDir();
        fs.writeFileSync(jsonPath, JSON.stringify({
            season_id:    meta.season_id,
            season_title: meta.season_title,
            update_time:  time,
            sections:     meta.sections,
            episodes:     meta.episodes,
            moves:        prevMoves.concat(newMoves),
        }, null, 2), 'utf8');
    }
    if (slotMin > 0) {
        const lastT = lastLineTime(jsonlPath);
        if (lastT && slotKey(lastT, slotMin) === slotKey(time, slotMin)) {
            return { movesAdded: newMoves.length, metaChanged, snapSkipped: true };
        }
    }
    appendJsonl(jsonlPath, facts);
    writeSeasonStats(ugc.id, time);
    rotateSeasonRetention(ugc.id);
    return { movesAdded: newMoves.length, metaChanged, snapSkipped: false };
}

module.exports = {
    ROOT, DATA_DIR, dataPath,
    nowTime, sleep,
    loadJson, appendJsonl,
    fetchSeason,
    extractSectionData,
    seasonJsonPath, seasonJsonlPath, seasonArchivePath, seasonStatsPath,
    rotateSeasonRetention, writeSeasonStats,
    assembleSeason, computeMoves, writeSeason,
};
