'use strict';
// watcher/watcher.js — long-running tracker that samples Bilibili season data
// at fixed clock-aligned intervals and records per-section JSONL snapshots.
//
// Configuration (edit below):
//   INTERVAL_MIN  — sampling interval in minutes; MUST be a divisor of 60
//                   (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60)
//   LIST_FILE     — path to list.json; re-read before every sampling cycle
//                   so changes take effect without restarting the process
//
// list.json format:
//   [
//     {
//       "season_id":   8019898,
//       "section_ids": [8911254],   // [] means all sections of the season
//       "aids":        [116496122514414]  // at least one; tried in order
//     }
//   ]
//
// Output (合集 is the storage unit; the frontend monitors a season by ?seasonid=<id>):
//   watcher/data/season_<seasonId>.json  — metadata + current membership + moves log
//                                      (rewritten only when title / section list /
//                                       episode set / membership changes)
//                                      { season_id, season_title, update_time,
//                                        sections: [{id, title}, ...],
//                                        episodes: [{aid,bvid,title,pubdate,section_id}, ...],
//                                        moves:    [{time,aid,title,from,to}, ...] }
//   watcher/data/season_<seasonId>.jsonl — pure-facts snapshots, one per cycle (append-only)
//                                      { time, episodes: [{aid, view, danmaku,
//                                        reply, fav, coin, share, like}, ...] }
//   The atomic record is (aid, time) → stats; section is metadata, not repeated per
//   snapshot. Membership history is preserved losslessly in `moves` (from/to=null ⇒
//   outside the season). Link key between the two files: aid.
//   Existing per-section files (<sectionId>.json/.jsonl) are converted once by
//   migrate.js and then kept only as a cold archive.

const path = require('path');
const lib  = require('./lib.js');

// ── Configuration ─────────────────────────────────────────────────────────────

const INTERVAL_MIN = 10;                                    // must divide 60
const LIST_FILE    = path.join(lib.ROOT, 'list.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns the milliseconds until the next clock-aligned sample tick.
function msUntilNextTick() {
    const now      = new Date();
    const minOfHr  = now.getMinutes();
    const secOfMin = now.getSeconds();
    const msOfSec  = now.getMilliseconds();

    // Minutes past the last tick within this hour
    const minPastTick  = minOfHr % INTERVAL_MIN;
    // Full ms elapsed since the last tick
    const msSinceTick  = (minPastTick * 60 + secOfMin) * 1000 + msOfSec;
    const intervalMs   = INTERVAL_MIN * 60 * 1000;
    return intervalMs - msSinceTick;
}

function loadList() {
    const list = lib.loadJson(LIST_FILE, []);
    if (!Array.isArray(list) || list.length === 0) {
        console.warn('[watcher] list.json is empty or missing — nothing to track.');
        return [];
    }
    return list;
}

// ── One sampling cycle ────────────────────────────────────────────────────────

async function runCycle() {
    const time    = lib.nowTime();
    const list    = loadList();
    if (!list.length) return;

    // Group targets by season_id so a single API call covers all requested
    // sections of the same season.
    const bySeasonId = {};
    for (const entry of list) {
        const sid = entry.season_id;
        if (!sid || !Array.isArray(entry.aids) || entry.aids.length === 0) {
            console.warn(`[watcher] Skipping invalid entry: ${JSON.stringify(entry)}`);
            continue;
        }
        bySeasonId[sid] = entry;
    }

    let totalSeasons  = 0;
    let totalEpisodes = 0;
    const skipped     = [];
    const written     = [];

    for (const [, entry] of Object.entries(bySeasonId)) {
        const { season_id, section_ids, aids } = entry;
        let data;
        try {
            data = await lib.fetchSeason(aids);
        } catch (e) {
            skipped.push(`season=${season_id} (all aids failed: ${e.message})`);
            continue;
        }

        const ugc = data.ugc_season;
        // section_ids omitted / [] ⇒ track all sections of the season (合集为单位)
        const sectionData = lib.extractSectionData(ugc, section_ids ?? [], time);

        if (sectionData.length === 0) {
            skipped.push(`season=${season_id} (no matching sections found)`);
            continue;
        }

        // One season = one set of files: season_<id>.json (metadata + moves) and
        // season_<id>.jsonl (pure facts, appended every cycle).
        const { movesAdded } = lib.writeSeason(ugc, sectionData, time);
        const epCount = new Set(sectionData.flatMap(s => s.snapshot.episodes.map(e => e.aid))).size;
        totalSeasons++;
        totalEpisodes += epCount;
        written.push(`season=${ugc.id}(${ugc.title}) ep=${epCount}` +
            (movesAdded ? ` moves+${movesAdded}` : ''));

        // Brief pause between seasons to avoid hammering the API.
        await lib.sleep(1500 + Math.floor(Math.random() * 1000));
    }

    // ── Summary log line ──────────────────────────────────────────────────────
    const parts = [`[${time}] Cycle done.`,
        `seasons=${totalSeasons} episodes=${totalEpisodes}`];
    if (written.length)  parts.push(`Written: ${written.join(', ')}`);
    if (skipped.length)  parts.push(`⚠ Skipped: ${skipped.join('; ')}`);
    console.log(parts.join(' | '));
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

(async () => {
    if (60 % INTERVAL_MIN !== 0) {
        console.error(`[watcher] INTERVAL_MIN=${INTERVAL_MIN} is not a divisor of 60. Aborting.`);
        process.exit(1);
    }

    const waitMs = msUntilNextTick();
    const waitMin = Math.floor(waitMs / 60000);
    const waitSec = Math.floor((waitMs % 60000) / 1000);
    console.log(`[watcher] Started. Interval=${INTERVAL_MIN}min. ` +
        `First sample in ${waitMin}m${waitSec}s (next clock tick).`);

    // Wait for the first aligned tick, then enter the regular interval loop.
    await lib.sleep(waitMs);

    async function tick() {
        try {
            await runCycle();
        } catch (e) {
            console.error(`[watcher] Unhandled error in cycle: ${e.message}`);
        }
        // Schedule next tick relative to the current system time so drift
        // doesn't accumulate even if runCycle() took a while.
        setTimeout(tick, msUntilNextTick());
    }

    await tick();
})();
