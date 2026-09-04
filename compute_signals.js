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
// 新進榜／動能延續原本用「佔榜單百分比」計分，最高封頂在固定值，
// 一旦好幾個候選同時衝到頂，會全部黏在天花板上，讓後面的離群值比較失去意義。
// 改成沒有上限的算法：新進榜用「榜單總長度 ÷ 名次」（大榜衝進前面分數更高，
// 不會跟小榜衝第一名拿一樣的分數）；動能延續用實際爬升的名次數（不除以榜單大小封頂）
function newEntryScore(cand) {
  return cand.chartSize / cand.cur.rank;
}
function momentumScore(cand) {
  return cand.climbed;
}

const ASIA_POOL_MARKETS = ["vn", "th", "id", "in", "sg", "my", "jp", "kr"];
const MARKET_LABELS = { global: "全球", tw: "台灣", jp: "日本", kr: "韓國", vn: "越南", th: "泰國", id: "印尼", in: "印度", sg: "新加坡", my: "馬來西亞" };
const GENRE_LABELS = { mandarin: "華語", western: "西洋", korean: "韓語", taiwanese: "台語", japanese: "日語",
  all: "總榜", rock: "搖滾", folk: "民謠", hip_hop: "嘻哈", urban: "都會", electronic: "電子", explore: "探索", ai_generated: "AI生成" };

function todayDateString() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

// 對 Supabase 的請求加上自動重試：資料庫現在量已經很大（40 萬筆以上），
// 連續發出大量請求時，中途被斷線（ECONNRESET 這類網路層錯誤）的機率會提高，
// 重試 3 次、每次間隔拉長，網路層失敗才重試，HTTP 4xx/5xx 這種真正的錯誤不重試（重試也沒用）
async function fetchWithRetry(url, options, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (e) {
      if (attempt === retries) throw new Error(`連線失敗（已重試 ${retries} 次）：${e.message}`);
      const wait = attempt * 1500;
      console.warn(`[warn] 連線被中斷（${e.message}），${wait}ms 後重試第 ${attempt + 1} 次...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function fetchAllSnapshots() {
  const all = [];
  let lastId = -1;
  const pageSize = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/chart_snapshots?select=id,source,chart_key,rank,artist_name,track_name,captured_at,metrics&id=gt.${lastId}&order=id.asc&limit=${pageSize}`;
    const res = await fetchWithRetry(url, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`讀取 chart_snapshots 失敗：HTTP ${res.status} ${body.slice(0, 300)}`);
    }
    const page = await res.json();
    if (page.length === 0) break;
    all.push(...page);
    lastId = page[page.length - 1].id;
    console.log(`已讀取 ${all.length} 筆快照...`);
    if (page.length < pageSize) break;
  }
  return all;
}

async function clearExistingSignals() {
  const url = `${SUPABASE_URL}/rest/v1/chart_signals?id=gte.0`; // gte.0 當條件是因為 REST 介面要求 DELETE 一定要帶篩選條件，這裡等於「全部都刪」
  const res = await fetchWithRetry(url, {
    method: "DELETE",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`清除舊的 chart_signals 失敗：HTTP ${res.status} ${body.slice(0, 300)}`);
  }
}

async function insertSignals(rows) {
  if (!rows.length) return;
  const url = `${SUPABASE_URL}/rest/v1/chart_signals`;
  const res = await fetchWithRetry(url, {
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

// 從 chart_snapshots 裡已經存在的欄位組出可以直接點擊收聽的連結：
// Spotify 用歌曲/藝人 ID 組網址，KKBOX 直接就有現成的完整網址；
// YouTube 目前爬蟲沒有抓連結，這裡會是 null，前端要處理「沒有連結」的情況
function linkOf(row) {
  const m = row?.metrics || {};
  const src = row?.source || "";
  if (src.startsWith("spotify")) {
    if (m.spotify_track_id) return `https://open.spotify.com/track/${m.spotify_track_id}`;
    if (m.spotify_artist_id) return `https://open.spotify.com/artist/${m.spotify_artist_id}`;
    return null;
  }
  if (src.startsWith("kkbox")) {
    return m.song_url || m.album_url || m.artist_url || null;
  }
  if (src.startsWith("streetvoice")) {
    return m.song_url || null;
  }
  return null;
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
  if (chartKey.startsWith("iradio")) {
    return { groupId: "iradio", tier: 3, label: "iRadio 中廣" };
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
// 新進榜門檻：首次登場的名次百分比（1=衝進榜首）要達到這個來源歷史上的 95 百分位才算數，
// 用 2026-09-04 分析（403,277 筆快照）的結果；樣本數太少（<100）的不信任算出來的數字，
// 用同類型裡樣本數足夠的數字當備援
const NEW_ENTRY_FLOOR = {
  cashbox_台語點播週榜: 0.90, // 原始 0.933，樣本僅 55，稍微保守
  cashbox_國語點播週榜: 0.90, // 原始 0.967，樣本僅 50，稍微保守
  kkbox_japanese: 0.950,
  kkbox_kma: 0.986,
  kkbox_korean: 0.950,
  kkbox_mandarin: 0.960,
  kkbox_taiwanese: 0.960,
  kkbox_western: 0.960,
  spotify_daily: 0.940,
  spotify_weekly: 0.925,
  streetvoice_realtime: 0.960,
  streetvoice_weekly: 0.960, // 原始 1.000（樣本 495 但幾乎都要衝第一才算），實務上太嚴格，放寬到跟 realtime 一致
  youtube_top: 0.940,
  youtube_trending: 0.933,
};
const DEFAULT_NEW_ENTRY_FLOOR = 0.9; // 沒對應到上面任何一種來源時的保守備援值
function newEntryFloorFor(chartKey) {
  return NEW_ENTRY_FLOOR[sourceTypeOf(chartKey)] ?? DEFAULT_NEW_ENTRY_FLOOR;
}

// 動能延續門檻：連續上升區段爬升的名次數，要達到這個來源歷史上的 95 百分位才算數。
// KKBOX 除了 kma 之外都是週榜，一個 7 天窗口湊不到連續 3 期資料，結構上不可能有動能延續，
// 這些類型不會走到這個函式（bestCandidatesForChart 本身就湊不出候選），不用列在表裡
const MOMENTUM_FLOOR = {
  cashbox_台語點播週榜: 7,
  cashbox_國語點播週榜: 11,
  kkbox_kma: 21,
  spotify_daily: 74,
  spotify_weekly: 65,
  streetvoice_realtime: 23,
  streetvoice_weekly: 17, // 原始 95 百分位是 16，但樣本只有 7 筆不可信，改用跟 realtime 接近的保守值
  youtube_top: 38,
  youtube_trending: 20,
};
const DEFAULT_MOMENTUM_FLOOR = 15; // 沒對應到上面任何一種來源時的保守備援值
function momentumFloorFor(chartKey) {
  return MOMENTUM_FLOOR[sourceTypeOf(chartKey)] ?? DEFAULT_MOMENTUM_FLOOR;
}

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

  // ---- 新進榜：本週窗口內首次出現、且名次最高（佔榜單百分比最深）的一首。
  // 這裡先不套歷史門檻——Tier 1 靠這個保底，門檻改成只在組 Tier 2/3 池子時才檢查 ----
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

  // ---- 動能延續：本週窗口內，連續上升區間（持平不算中斷，只有真的退步或缺席才算中斷）
  // 爬升幅度最大的一段，要過這個來源歷史上的 95 百分位門檻才算數 ----
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
        // 只有真的退步或缺席才算中斷，持平不算——持平代表這幾天沒有輸給任何人，
        // 不該因為單一天沒有「更進一步」就把前後兩段本來是同一段的連續上升拆開
        const broke = i === ranks.length || ranks[i] == null || ranks[i - 1] == null || ranks[i] > ranks[i - 1];
        if (broke) {
          const streakLen = i - streakStart;
          if (streakLen >= MOMENTUM_MIN_STREAK && ranks[streakStart] != null && ranks[i - 1] != null) {
            const climbed = ranks[streakStart] - ranks[i - 1];
            const pct = climbed / chartSize;
            if (pct > bestPct) {
              const latestRow = weekEndRows.find((r) => trackKey(r) === key);
              if (latestRow) {
                bestPct = pct;
                best = { cur: latestRow, ranks: ranks.slice(streakStart, i), pct, climbed, chartSize, chartKey };
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
  let title, description, extraMetrics = {};

  if (type === "劇烈變動") {
    title = `〈${name}〉在 ${group.label} 名次跳升`;
    description = `第 ${cand.prev.rank} 名 → 第 ${cand.cur.rank} 名`;
    extraMetrics = { rank_before: cand.prev.rank, rank_after: cand.cur.rank };
  } else if (type === "新進榜") {
    const isChampion = cand.cur.rank === 1;
    title = `〈${name}〉在 ${group.label} ${isChampion ? "空降冠軍" : "空降"}`;
    description = isChampion ? `首次登場即空降冠軍` : `首次登場即拿下第 ${cand.cur.rank} 名`;
    extraMetrics = { rank: cand.cur.rank, is_champion: isChampion };
  } else {
    title = `〈${name}〉在 ${group.label} 持續上升`;
    description = `本週名次 ${cand.ranks.join(" → ")}`;
    extraMetrics = { rank_history: cand.ranks, climbed: cand.climbed };
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
      ...extraMetrics,
    },
    image_url: imageOf(cur),
    link_url: linkOf(cur),
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
    if (chartKey.startsWith("iradio")) continue; // iRadio 另外用「本週播放次數排行」處理，不進入這套比較邏輯
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
    if (gb.newEntry) candidates.push({ type: "新進榜", cand: gb.newEntry, score: newEntryScore(gb.newEntry) });
    if (gb.momentum) candidates.push({ type: "動能延續", cand: gb.momentum, score: momentumScore(gb.momentum) });
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
    if (gb.newEntry && gb.newEntry.pct >= newEntryFloorFor(gb.newEntry.chartKey)) tier2Pool.push({ type: "新進榜", info: gb.info, cand: gb.newEntry, score: newEntryScore(gb.newEntry) });
    if (gb.momentum && gb.momentum.climbed >= momentumFloorFor(gb.momentum.chartKey)) tier2Pool.push({ type: "動能延續", info: gb.info, cand: gb.momentum, score: momentumScore(gb.momentum) });
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
    if (gb.newEntry && gb.newEntry.pct >= newEntryFloorFor(gb.newEntry.chartKey)) tier3Pool.push({ type: "新進榜", info: gb.info, cand: gb.newEntry, score: newEntryScore(gb.newEntry) });
    if (gb.momentum && gb.momentum.climbed >= momentumFloorFor(gb.momentum.chartKey)) tier3Pool.push({ type: "動能延續", info: gb.info, cand: gb.momentum, score: momentumScore(gb.momentum) });
  }
  console.log(`Tier 3 候選池：${tier3Pool.length} 個（要 >= 10 才會開始比較離群值）`);
  if (tier3Pool.length >= 10) {
    const scores = tier3Pool.map((c) => c.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    const stdDev = Math.sqrt(variance);
    console.log(`平均值 ${mean.toFixed(2)}，標準差 ${stdDev.toFixed(2)}，門檻是 ${TIER3_ZSCORE_THRESHOLD} 個標準差`);
    const sortedDebug = tier3Pool
      .map((c) => ({ type: c.type, group: c.info.label, score: c.score, z: stdDev > 0 ? (c.score - mean) / stdDev : null }))
      .sort((a, b) => b.score - a.score);
    console.log("分數由高到低：");
    for (const s of sortedDebug) console.log(`  ${s.type}/${s.group}：分數 ${s.score.toFixed(2)}（z=${s.z?.toFixed(2)}）`);
    if (stdDev > 0) {
      for (const c of tier3Pool) {
        if ((c.score - mean) / stdDev >= TIER3_ZSCORE_THRESHOLD) {
          finalSignals.push(buildSignalRow(c.type, c.info, c.cand, today));
        }
      }
    }
  }

  // ---- iRadio 獨立處理：不跟其他來源比較異常，單純算「本週播放次數」加總取前幾名 ----
  const IRADIO_TOP_N = 5;
  {
    const iradioPeriods = byChart.get("iradio_playlist");
    if (iradioPeriods) {
      const now = Date.now();
      const totals = new Map(); // trackKey -> { artist, track, count, image }
      for (const [t, rows] of iradioPeriods) {
        if (now - new Date(t).getTime() > WEEK_MS) continue;
        for (const r of rows) {
          const key = trackKey(r);
          const plays = parseInt(r.metrics?.play_count_that_day, 10) || 0;
          if (!totals.has(key)) totals.set(key, { artist: r.artist_name, track: r.track_name, count: 0 });
          totals.get(key).count += plays;
        }
      }
      const ranked = [...totals.values()].sort((a, b) => b.count - a.count).slice(0, IRADIO_TOP_N);
      ranked.forEach((item, i) => {
        const name = [item.track, item.artist].filter(Boolean).join(" — ") || item.artist || item.track;
        finalSignals.push({
          日期: today,
          signal_type: "本週播放排行",
          title: `〈${name}〉本週播放第 ${i + 1} 名`,
          description: `本週累計播放 ${item.count} 次`,
          artist_name: item.artist,
          track_name: item.track,
          sources: ["iradio_playlist"],
          metrics: { group_id: "iradio", group_label: "iRadio 中廣", tier: 0, chart_key: "iradio_playlist", rank: i + 1, weekly_plays: item.count },
          image_url: null,
          link_url: null,
        });
      });
    }
  }

  console.log(`Tier 1: ${finalSignals.filter((s) => s.metrics.tier === 1).length} 則`);
  console.log(`Tier 2: ${finalSignals.filter((s) => s.metrics.tier === 2).length} 則`);
  console.log(`Tier 3: ${finalSignals.filter((s) => s.metrics.tier === 3).length} 則`);
  console.log(`iRadio 本週播放排行: ${finalSignals.filter((s) => s.metrics.tier === 0).length} 則`);
  console.log(`本次總計 ${finalSignals.length} 則訊號`);

  const BATCH = 300;
  let written = 0;
  if (finalSignals.length > 0) {
    console.log("清除舊的 chart_signals...");
    await clearExistingSignals();
    for (let i = 0; i < finalSignals.length; i += BATCH) {
      const batch = finalSignals.slice(i, i + BATCH);
      try {
        await insertSignals(batch);
        written += batch.length;
      } catch (e) {
        console.warn(`[warn] 寫入第 ${i}-${i + batch.length} 筆失敗：${e.message}`);
      }
    }
  } else {
    console.warn("[warn] 這次沒算出任何訊號，跳過清除／寫入，避免把資料庫清空卻沒有新資料可以補上");
  }
  console.log(`寫入 chart_signals：${written} 筆`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
