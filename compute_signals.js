// 訊號引擎 - 分層架構版
// Tier 1（關切榜單：KKBOX華語／Spotify台灣／Spotify全球／StreetVoice總榜／YouTube台灣，保底 1-2 則）
// Tier 2（東南亞+日韓市場池，Spotify+YouTube，全池取前 5）
// Tier 3（其餘全部，只有極端離群才露出，資料量還淺時常態是空的）
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MOMENTUM_MIN_STREAK = 3;
const TIER1_MAX_PER_GROUP = 2;
const TIER2_POOL_SIZE = 5;
const TIER3_ZSCORE_THRESHOLD = 3.5; // Tier 3 用的是「這週所有候選訊號裡誰特別突出」，跟劇烈變動門檻是不同機制

// 各來源「正常」波動幅度差很多，用同一個數字當門檻對誰都不公平。
// 這是拿實際資料算出來的 95 百分位（2026-08 資料）。
// Spotify 每日歌曲榜額外驗證過：不同市場樣本量足夠（每市場 465-544 筆）、
// 差異也是真實的（台灣 52、印尼只有 30），改成照市場分開設定，不再用單一數字。
// 其他來源目前還沒驗證過拆更細（例如各曲風、各市場）是否也有同樣的必要，
// 先維持用「整個來源類型」當單位，沒證據前不貿然拆分。
const SPOTIFY_DAILY_MARKET_FLOOR = {
  global: 31, id: 30, in: 34, jp: 31, kr: 35, my: 47, sg: 35, th: 46, tw: 52, vn: 44,
};
const ABSOLUTE_JUMP_FLOOR = {
  kkbox_kma: 12,
  kkbox_official: 12,
  spotify_weekly: 23,
  streetvoice_realtime: 13,
  streetvoice_weekly: 16,
  youtube_top: 23,
  youtube_trending: 10,
  cashbox: 7, // 只有 30 首歌的小榜，波動天生就很小，95 百分位實測只有 6-7
};
const DEFAULT_JUMP_FLOOR = 20; // 沒對應到上面任何一種來源時的保守備援值

// iRadio 沒有真正的排名，是我們自己用「當天播放次數」湊出來的——
// 播放次數多的歌彼此之間排序有意義，但大多數歌一天只播一次、全部並列，
// 這些「並列區」的名次其實是雜訊，不是真實變化。只在播放次數夠高的範圍內
// （前面這個名次）才承認名次有意義，避免把「雜訊區衝到有意義區」誤判成劇烈變動。
const IRADIO_MEANINGFUL_RANK_LIMIT = 30;

// 國際大廠偶像團體／西洋主流大牌：這些藝人在東南亞＋日韓正常表現很好是常態，
// 不算訊號，除非漲幅遠超一般水準才值得列入 Tier 2。清單需要人工不定期更新。
const MAJOR_ACTS = new Set([
  "bts", "blackpink", "twice", "stray kids", "seventeen", "newjeans",
  "le sserafim", "ive", "aespa", "ateez", "enhypen", "txt",
  "tomorrow x together", "(g)i-dle", "itzy", "nct", "nct dream",
  "nct 127", "exo", "red velvet", "bigbang", "treasure", "zerobaseone",
  "riize", "boynextdoor",
  "taylor swift", "ariana grande", "bruno mars", "the weeknd",
  "billie eilish", "dua lipa", "ed sheeran", "justin bieber",
  "rihanna", "drake", "kendrick lamar", "sza", "doja cat",
  "sabrina carpenter", "olivia rodrigo", "lady gaga", "beyoncé",
  "post malone", "bad bunny", "karol g",
]);
function isMajorAct(name) {
  if (!name) return false;
  return MAJOR_ACTS.has(name.trim().toLowerCase());
}
const MAJOR_ACT_FLOOR_MULTIPLIER = 1.8; // 大牌要多漲這個倍數才算數

function sourceTypeOf(chartKey) {
  return chartKey.split("_").slice(0, 2).join("_");
}
function jumpFloorFor(chartKey) {
  if (chartKey.startsWith("spotify_daily_songs_")) {
    const market = chartKey.replace("spotify_daily_songs_", "");
    return SPOTIFY_DAILY_MARKET_FLOOR[market] ?? DEFAULT_JUMP_FLOOR;
  }
  return ABSOLUTE_JUMP_FLOOR[sourceTypeOf(chartKey)] ?? DEFAULT_JUMP_FLOOR;
}
// 同樣的漲幅，衝到接近榜首應該比停在後段班更值得注意
function positionWeight(finalRank, chartSize) {
  return 1 + (1 - (finalRank - 1) / chartSize);
}

const ASIA_POOL_MARKETS = ["vn", "th", "id", "in", "sg", "my", "jp", "kr"];
const MARKET_LABELS = { global: "全球", tw: "台灣", jp: "日本", kr: "韓國", vn: "越南", th: "泰國", id: "印尼", in: "印度", sg: "新加坡", my: "馬來西亞" };
const GENRE_LABELS = { mandarin: "華語", western: "西洋", korean: "韓語", taiwanese: "台語", japanese: "日語",
  all: "總榜", rock: "搖滾", folk: "民謠", hip_hop: "嘻哈", urban: "都會", electronic: "電子", explore: "探索", ai_generated: "AI生成" };

function todayDateString() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

async function fetchAllSnapshots() {
  const all = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/chart_snapshots?select=id,source,chart_key,rank,artist_name,track_name,captured_at,metrics&order=chart_key.asc,captured_at.asc&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) throw new Error(`讀取 chart_snapshots 失敗：HTTP ${res.status}`);
    const page = await res.json();
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

async function insertSignals(rows) {
  if (!rows.length) return;
  const url = `${SUPABASE_URL}/rest/v1/chart_signals`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`寫入 chart_signals 失敗：HTTP ${res.status} ${body.slice(0, 300)}`);
  }
}

function trackKey(row) {
  return `${(row.artist_name || "").trim()}|||${(row.track_name || "").trim()}`;
}
function hasIdentity(row) {
  return (row.artist_name || "").trim() !== "" || (row.track_name || "").trim() !== "";
}
function imageOf(row) {
  return row?.metrics?.image_url || row?.metrics?.cover_image_url || null;
}

// ---- 分組邏輯：把細分的 chart_key 併成邏輯上的同一組，同一件事不會因為子榜不同被講兩次 ----
function getGroupInfo(chartKey) {
  if (chartKey.startsWith("kkbox_kma_mandarin_") || chartKey.startsWith("kkbox_mandarin_")) {
    return { groupId: "kkbox_mandarin", tier: 1, label: "KKBOX 華語" };
  }
  if (chartKey === "spotify_daily_songs_tw" || chartKey === "spotify_weekly_artists_tw") {
    return { groupId: "spotify_tw", tier: 1, label: "Spotify 台灣" };
  }
  if (chartKey === "spotify_daily_songs_global" || chartKey === "spotify_weekly_artists_global") {
    return { groupId: "spotify_global", tier: 1, label: "Spotify 全球" };
  }
  if (chartKey.startsWith("streetvoice_realtime_all") || chartKey.startsWith("streetvoice_weekly_all")) {
    return { groupId: "streetvoice_all", tier: 1, label: "StreetVoice 總榜" };
  }
  if (chartKey.startsWith("youtube_") && chartKey.endsWith("_tw")) {
    return { groupId: "youtube_tw", tier: 1, label: "YouTube 台灣" };
  }

  for (const m of ASIA_POOL_MARKETS) {
    if (chartKey === `spotify_daily_songs_${m}` || chartKey === `spotify_weekly_artists_${m}`) {
      return { groupId: `spotify_${m}`, tier: 2, label: `Spotify ${MARKET_LABELS[m] || m}` };
    }
    if (chartKey.startsWith("youtube_") && chartKey.endsWith(`_${m}`)) {
      return { groupId: `youtube_${m}`, tier: 2, label: `YouTube ${MARKET_LABELS[m] || m}` };
    }
  }

  if (chartKey.startsWith("kkbox_kma_") || chartKey.startsWith("kkbox_")) {
    const m = chartKey.match(/kkbox(?:_kma)?_([a-z]+)_/);
    const genre = m ? m[1] : "other";
    return { groupId: `kkbox_${genre}`, tier: 3, label: `KKBOX ${GENRE_LABELS[genre] || genre}` };
  }
  if (chartKey.startsWith("streetvoice_")) {
    const parts = chartKey.replace("streetvoice_", "").split("_");
    parts.shift();
    const genre = parts.join("_");
    return { groupId: `streetvoice_${genre}`, tier: 3, label: `StreetVoice ${GENRE_LABELS[genre] || genre}` };
  }
  if (chartKey.startsWith("cashbox_")) {
    return { groupId: chartKey, tier: 3, label: chartKey.replace("cashbox_", "錢櫃 ") };
  }
  if (chartKey.startsWith("youtube_")) {
    return { groupId: "youtube_global", tier: 3, label: "YouTube 全球" };
  }
  return { groupId: chartKey, tier: 3, label: chartKey };
}

function groupByChartAndPeriod(snapshots) {
  const byChart = new Map();
  for (const s of snapshots) {
    if (!hasIdentity(s)) continue;
    if (!byChart.has(s.chart_key)) byChart.set(s.chart_key, new Map());
    const periods = byChart.get(s.chart_key);
    if (!periods.has(s.captured_at)) periods.set(s.captured_at, []);
    periods.get(s.captured_at).push(s);
  }
  return byChart;
}

// 對單一 chart_key，在最近一週的窗口內，各找出「最強的一個」候選（不是全部達標的都算）
function bestCandidatesForChart(chartKey, periodsMap) {
  const allPeriods = [...periodsMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (allPeriods.length < 2) return {};

  const now = new Date(allPeriods[allPeriods.length - 1][0]).getTime();
  const windowPeriods = allPeriods.filter(([t]) => now - new Date(t).getTime() <= WEEK_MS);
  if (windowPeriods.length < 2) return {};

  const weekStartRows = windowPeriods[0][1];
  const weekEndRows = windowPeriods[windowPeriods.length - 1][1];
  const chartSize = weekEndRows.length;
  const weekStartMap = new Map(weekStartRows.map((r) => [trackKey(r), r]));

  const everAppearedBeforeWindow = new Set();
  for (const [t, rows] of allPeriods) {
    if (new Date(t).getTime() >= new Date(windowPeriods[0][0]).getTime()) break;
    for (const r of rows) everAppearedBeforeWindow.add(trackKey(r));
  }

  const result = {};

  // ---- 劇烈變動：漲幅要先過這個榜自己來源類型的絕對門檻（真實資料的95百分位），
  // 過關的候選裡再用「最終停在哪裡」加權排序，同樣漲幅、衝到接近榜首的分數較高 ----
  {
    const floor = jumpFloorFor(chartKey);
    const isIradio = chartKey.startsWith("iradio_");
    let best = null, bestScore = 0;
    for (const cur of weekEndRows) {
      const prev = weekStartMap.get(trackKey(cur));
      if (!prev || prev.rank == null || cur.rank == null) continue;
      // iRadio 沒有真正名次，超過門檻範圍的都是「一天只播一次」互相並列的雜訊區，
      // 只要前後任一邊落在雜訊區，這個跳動就不算數
      if (isIradio && (prev.rank > IRADIO_MEANINGFUL_RANK_LIMIT || cur.rank > IRADIO_MEANINGFUL_RANK_LIMIT)) continue;
      const jump = prev.rank - cur.rank;
      if (jump < floor) continue;
      const score = jump * positionWeight(cur.rank, chartSize);
      if (score > bestScore) { bestScore = score; best = { cur, prev, jump, score }; }
    }
    if (best) result.jump = { ...best, chartSize, chartKey };
  }

  // ---- 新進榜：本週窗口內首次出現、且名次最高（佔榜單百分比最深）的一首 ----
  {
    let best = null, bestPct = 0;
    for (const cur of weekEndRows) {
      if (everAppearedBeforeWindow.has(trackKey(cur)) || weekStartMap.has(trackKey(cur))) continue;
      if (cur.rank == null) continue;
      const pct = 1 - (cur.rank - 1) / chartSize;
      if (pct > bestPct) { bestPct = pct; best = { cur, pct, chartSize, chartKey }; }
    }
    if (best) result.newEntry = best;
  }

  // ---- 動能延續：本週窗口內，連續上升區間爬升幅度（佔榜單百分比）最大的一段 ----
  {
    const trackHistory = new Map();
    for (const [, rows] of windowPeriods) {
      const seen = new Set();
      for (const r of rows) {
        const key = trackKey(r);
        seen.add(key);
        if (!trackHistory.has(key)) trackHistory.set(key, []);
        trackHistory.get(key).push(r.rank);
      }
      for (const [key, arr] of trackHistory) {
        if (!seen.has(key)) arr.push(null);
      }
    }
    let best = null, bestPct = 0;
    for (const [key, ranks] of trackHistory) {
      if (ranks.length < MOMENTUM_MIN_STREAK + 1) continue;
      let streakStart = 0;
      for (let i = 1; i <= ranks.length; i++) {
        const broke = i === ranks.length || ranks[i] == null || ranks[i - 1] == null || ranks[i] >= ranks[i - 1];
        if (broke) {
          const streakLen = i - streakStart;
          if (streakLen >= MOMENTUM_MIN_STREAK && ranks[streakStart] != null && ranks[i - 1] != null) {
            const climbed = ranks[streakStart] - ranks[i - 1];
            const pct = climbed / chartSize;
            if (pct > bestPct) {
              const latestRow = weekEndRows.find((r) => trackKey(r) === key);
              if (latestRow) {
                bestPct = pct;
                best = { cur: latestRow, ranks: ranks.slice(streakStart, i), pct, chartSize, chartKey };
              }
            }
          }
          streakStart = i;
        }
      }
    }
    if (best) result.momentum = best;
  }

  return result;
}

function buildSignalRow(type, group, cand, today) {
  const cur = cand.cur;
  const name = [cur.track_name, cur.artist_name].filter(Boolean).join(" — ") || cur.artist_name || cur.track_name;
  let title, description;

  if (type === "劇烈變動") {
    title = `〈${name}〉在 ${group.label} 名次跳升`;
    description = `第 ${cand.prev.rank} 名 → 第 ${cand.cur.rank} 名`;
  } else if (type === "新進榜") {
    const isChampion = cand.cur.rank === 1;
    title = `〈${name}〉在 ${group.label} ${isChampion ? "空降冠軍" : "空降"}`;
    description = isChampion ? `首次登場即空降冠軍` : `首次登場即拿下第 ${cand.cur.rank} 名`;
  } else {
    title = `〈${name}〉在 ${group.label} 持續上升`;
    description = `本週名次 ${cand.ranks.join(" → ")}`;
  }

  return {
    日期: today,
    signal_type: type,
    title,
    description,
    artist_name: cur.artist_name,
    track_name: cur.track_name,
    sources: [cand.chartKey],
    metrics: {
      group_id: group.groupId,
      group_label: group.label,
      tier: group.tier,
      chart_key: cand.chartKey,
      strength: cand.score ?? cand.pct ?? null,
    },
    image_url: imageOf(cur),
  };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("找不到 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，先確認 .env 有填好。");
    process.exit(1);
  }

  console.log("讀取 chart_snapshots...");
  const snapshots = await fetchAllSnapshots();
  console.log(`共 ${snapshots.length} 筆快照`);

  const byChart = groupByChartAndPeriod(snapshots);
  console.log(`共 ${byChart.size} 個不同的榜（chart_key）`);

  const perChartBest = new Map();
  for (const [chartKey, periodsMap] of byChart) {
    const best = bestCandidatesForChart(chartKey, periodsMap);
    if (Object.keys(best).length) perChartBest.set(chartKey, best);
  }
  console.log(`${perChartBest.size} 個榜本週有可比較的候選訊號`);

  const groups = new Map();
  for (const [chartKey, best] of perChartBest) {
    const info = getGroupInfo(chartKey);
    if (!groups.has(info.groupId)) groups.set(info.groupId, { info, jump: [], newEntry: [], momentum: [] });
    const g = groups.get(info.groupId);
    if (best.jump) g.jump.push(best.jump);
    if (best.newEntry) g.newEntry.push(best.newEntry);
    if (best.momentum) g.momentum.push(best.momentum);
  }

  const groupBest = new Map();
  for (const [groupId, g] of groups) {
    const pick = (arr, scoreFn) => (arr.length ? arr.reduce((a, b) => (scoreFn(b) > scoreFn(a) ? b : a)) : null);
    groupBest.set(groupId, {
      info: g.info,
      jump: pick(g.jump, (c) => c.score),
      newEntry: pick(g.newEntry, (c) => c.pct),
      momentum: pick(g.momentum, (c) => c.pct),
    });
  }

  const today = todayDateString();
  const finalSignals = [];

  for (const [, gb] of groupBest) {
    if (gb.info.tier !== 1) continue;
    const candidates = [];
    if (gb.jump) candidates.push({ type: "劇烈變動", cand: gb.jump, score: gb.jump.score });
    if (gb.newEntry) candidates.push({ type: "新進榜", cand: gb.newEntry, score: gb.newEntry.pct * 3 });
    if (gb.momentum) candidates.push({ type: "動能延續", cand: gb.momentum, score: gb.momentum.pct * 3 });
    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates.slice(0, TIER1_MAX_PER_GROUP)) {
      finalSignals.push(buildSignalRow(c.type, gb.info, c.cand, today));
    }
  }

  // Tier 2：國際大廠偶像／西洋大牌在這幾個市場正常表現好是常態，要漲更多才算數，
  // 不然池子裡永遠是同一批巨星，擠掉真正值得注意的在地藝人
  function passesMajorActGate(cand) {
    const name = cand.cur.artist_name;
    if (!isMajorAct(name)) return true;
    const floor = jumpFloorFor(cand.chartKey);
    return cand.jump >= floor * MAJOR_ACT_FLOOR_MULTIPLIER;
  }

  const tier2Pool = [];
  for (const [, gb] of groupBest) {
    if (gb.info.tier !== 2) continue;
    if (gb.jump && passesMajorActGate(gb.jump)) tier2Pool.push({ type: "劇烈變動", info: gb.info, cand: gb.jump, score: gb.jump.score });
    if (gb.newEntry) tier2Pool.push({ type: "新進榜", info: gb.info, cand: gb.newEntry, score: gb.newEntry.pct * 3 });
    if (gb.momentum) tier2Pool.push({ type: "動能延續", info: gb.info, cand: gb.momentum, score: gb.momentum.pct * 3 });
  }
  tier2Pool.sort((a, b) => b.score - a.score);
  for (const c of tier2Pool.slice(0, TIER2_POOL_SIZE)) {
    finalSignals.push(buildSignalRow(c.type, c.info, c.cand, today));
  }

  const tier3Pool = [];
  for (const [, gb] of groupBest) {
    if (gb.info.tier !== 3) continue;
    // 劇烈變動改用「相對這個來源自己門檻的倍數」，不是原始跳動幅度，
    // 不然波動天生就小的來源（例如 Cashbox）永遠比不過波動大的來源
    if (gb.jump) tier3Pool.push({ type: "劇烈變動", info: gb.info, cand: gb.jump, score: gb.jump.jump / jumpFloorFor(gb.jump.chartKey) });
    if (gb.newEntry) tier3Pool.push({ type: "新進榜", info: gb.info, cand: gb.newEntry, score: gb.newEntry.pct * 3 });
    if (gb.momentum) tier3Pool.push({ type: "動能延續", info: gb.info, cand: gb.momentum, score: gb.momentum.pct * 3 });
  }
  if (tier3Pool.length >= 10) {
    const scores = tier3Pool.map((c) => c.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      for (const c of tier3Pool) {
        if ((c.score - mean) / stdDev >= TIER3_ZSCORE_THRESHOLD) {
          finalSignals.push(buildSignalRow(c.type, c.info, c.cand, today));
        }
      }
    }
  }

  console.log(`Tier 1: ${finalSignals.filter((s) => s.metrics.tier === 1).length} 則`);
  console.log(`Tier 2: ${finalSignals.filter((s) => s.metrics.tier === 2).length} 則`);
  console.log(`Tier 3: ${finalSignals.filter((s) => s.metrics.tier === 3).length} 則`);
  console.log(`本次總計 ${finalSignals.length} 則訊號`);

  const BATCH = 300;
  let written = 0;
  for (let i = 0; i < finalSignals.length; i += BATCH) {
    const batch = finalSignals.slice(i, i + BATCH);
    try {
      await insertSignals(batch);
      written += batch.length;
    } catch (e) {
      console.warn(`[warn] 寫入第 ${i}-${i + batch.length} 筆失敗：${e.message}`);
    }
  }
  console.log(`寫入 chart_signals：${written} 筆`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
