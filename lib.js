'use strict';
// watcher/lib.js — shared helpers for watcher.js.

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ROOT     = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

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

async function fetchSeason(aids) {
    let lastErr;
    for (const aid of aids) {
        try {
            const data = await fetchViewWithRetry(aid);
            if (!data.ugc_season)
                throw new Error(`aid=${aid}: no ugc_season in response`);
            return data;
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr ?? new Error('No aids provided');
}

// Given a ugc_season object and a filter set of sectionIds (empty = all),
// returns an array of { basic, snapshot } for each matched section.
//
// basic:    { season_id, section_id, section_title, episodes: [{aid,bvid,title,pubdate}] }
//           — static info; write to <sectionId>.json once, update only when episodes change
// snapshot: { time, episodes: [{aid, view, danmaku, reply, fav, coin, share, like}] }
//           — per-tick stats; append to <sectionId>.jsonl every cycle
//
// Link key between the two files: aid
function extractSectionData(ugc, targetSectionIds, time) {
    const filterAll = !targetSectionIds || targetSectionIds.length === 0;
    const results   = [];

    for (const sec of (ugc.sections ?? [])) {
        if (!filterAll && !targetSectionIds.includes(sec.id)) continue;

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

// Write basic JSON (pretty-printed). Always call basicNeedsUpdate first.
function writeBasicJson(filePath, basic) {
    ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(basic, null, 2), 'utf8');
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

// Write the season metadata json (rewritten only when title / section list /
// episode set / membership changed, appending any new moves) and append one
// pure-facts line to the season jsonl every cycle.
// Returns { movesAdded, metaChanged }.
function writeSeason(ugc, sectionData, time) {
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
    appendJsonl(jsonlPath, facts);
    return { movesAdded: newMoves.length, metaChanged };
}

// Returns true if the basic JSON file is absent or its content differs from
// the freshly-fetched basic object (episode list or titles changed).
function basicNeedsUpdate(filePath, basic) {
    const existing = loadJson(filePath, null);
    if (!existing) return true;
    if (existing.section_title !== basic.section_title) return true;
    const existAids   = (existing.episodes ?? []).map(e => e.aid).join(',');
    const newAids     = basic.episodes.map(e => e.aid).join(',');
    if (existAids !== newAids) return true;
    const existTitles = (existing.episodes ?? []).map(e => e.title).join('\0');
    const newTitles   = basic.episodes.map(e => e.title).join('\0');
    return existTitles !== newTitles;
}

module.exports = {
    ROOT, DATA_DIR, dataPath,
    nowTime, sleep,
    loadJson, appendJsonl,
    fetchSeason,
    extractSectionData, writeBasicJson, basicNeedsUpdate,
    seasonJsonPath, seasonJsonlPath,
    assembleSeason, computeMoves, writeSeason,
};
