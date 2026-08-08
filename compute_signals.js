// 訊號引擎 - 第 3 層（先做前三種，不依賴 crosswalk）：
// 劇烈變動 / 新進榜 / 動能延續，讀 chart_snapshots，算出訊號寫進 chart_signals
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 歷史筆數少於這個門檻時，用保守固定門檻；多於這個門檻才用該榜自己的歷史波動算門檻
const MIN_PERIODS_FOR_ADAPTIVE_THRESHOLD = 8;
const CONSERVATIVE_JUMP_THRESHOLD = 25; // 保守模式下，名次至少要跳這麼多才算「劇烈變動」
const MOMENTUM_MIN_STREAK = 3; // 連續幾期都在上升，才算「動能延續」

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

// ---- 把快照分組：chart_key -> 期別（captured_at）-> [snapshot rows] ----

function groupByChartAndPeriod(snapshots) {
  const byChart = new Map();
  for (const s of snapshots) {
    if (!byChart.has(s.chart_key)) byChart.set(s.chart_key, new Map());
    const periods = byChart.get(s.chart_key);
    if (!periods.has(s.captured_at)) periods.set(s.captured_at, []);
    periods.get(s.captured_at).push(s);
  }
  return byChart;
}

function trackKey(row) {
  return `${(row.artist_name || "").trim()}|||${(row.track_name || "").trim()}`;
}

function hasIdentity(row) {
  return (row.artist_name || "").trim() !== "" || (row.track_name || "").trim() !== "";
}

// 保守模式或自適應模式，決定「名次跳動要多大才算劇烈變動」
function computeJumpThreshold(periodsSorted) {
  if (periodsSorted.length < MIN_PERIODS_FOR_ADAPTIVE_THRESHOLD) {
    return { threshold: CONSERVATIVE_JUMP_THRESHOLD, mode: "conservative_fixed" };
  }
  // 自適應：算出這個榜過去每一期、每首歌名次變動的絕對值，取其標準差，
  // 門檻設在「平均 + 3 個標準差」，統計上算是明顯的離群值
  const changes = [];
  for (let i = 1; i < periodsSorted.length; i++) {
    const prevMap = new Map(periodsSorted[i - 1][1].map((r) => [trackKey(r), r.rank]));
    for (const cur of periodsSorted[i][1]) {
      const prevRank = prevMap.get(trackKey(cur));
      if (prevRank != null && cur.rank != null) {
        changes.push(Math.abs(prevRank - cur.rank));
      }
    }
  }
  if (changes.length < 10) return { threshold: CONSERVATIVE_JUMP_THRESHOLD, mode: "conservative_fixed" };

  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((a, b) => a + (b - mean) ** 2, 0) / changes.length;
  const stdDev = Math.sqrt(variance);
  const adaptive = mean + 3 * stdDev;
  // 自適應門檻不低於一個基本值，避免波動極小的榜隨便跳 3、5 名就觸發
  return { threshold: Math.max(adaptive, 10), mode: "adaptive" };
}

function detectSignalsForChart(chartKey, periodsMap) {
  const signals = [];
  // 藝人名跟曲名都是空的資料無法辨識身分，直接濾掉，避免它們互相冒充同一個人
  const periodsSorted = [...periodsMap.entries()]
    .map(([period, rows]) => [period, rows.filter(hasIdentity)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (periodsSorted.length < 2) return signals; // 只有一期，沒有東西可以比

  const [, latestRows] = periodsSorted[periodsSorted.length - 1];
  const [, prevRows] = periodsSorted[periodsSorted.length - 2];
  const prevMap = new Map(prevRows.map((r) => [trackKey(r), r]));

  // 這個榜過去有沒有出現過這首歌／這個藝人（用來判斷「新進榜」，看全部歷史期別，不是只看上一期）
  const everAppearedBefore = new Set();
  for (let i = 0; i < periodsSorted.length - 1; i++) {
    for (const r of periodsSorted[i][1]) everAppearedBefore.add(trackKey(r));
  }

  const { threshold: jumpThreshold, mode: thresholdMode } = computeJumpThreshold(periodsSorted);

  const today = todayDateString();
  const source = latestRows[0]?.source || "";

  for (const cur of latestRows) {
    const key = trackKey(cur);
    const prev = prevMap.get(key);

    // ---- 新進榜：這次出現，過去所有期別都沒出現過 ----
    if (!everAppearedBefore.has(key) && cur.rank != null && cur.rank <= 20) {
      signals.push({
        日期: today,
        signal_type: "新進榜",
        title: `〈${cur.track_name || cur.artist_name}〉首度登上 ${chartKey}`,
        description: `${cur.artist_name}${cur.track_name ? `《${cur.track_name}》` : ""} 首次出現在 ${chartKey}，名次 ${cur.rank}`,
        artist_name: cur.artist_name,
        track_name: cur.track_name,
        sources: [source],
        metrics: { chart_key: chartKey, rank: cur.rank, threshold_mode: thresholdMode },
        image_url: null,
      });
      continue; // 新進榜跟劇烈變動不重複算
    }

    // ---- 劇烈變動：名次跳動超過門檻 ----
    if (prev && prev.rank != null && cur.rank != null) {
      const jump = prev.rank - cur.rank; // 正值代表名次上升（數字變小）
      if (jump >= jumpThreshold) {
        signals.push({
          日期: today,
          signal_type: "劇烈變動",
          title: `〈${cur.track_name || cur.artist_name}〉在 ${chartKey} 名次跳升 ${jump} 名`,
          description: `${cur.artist_name}${cur.track_name ? `《${cur.track_name}》` : ""} 從第 ${prev.rank} 名衝到第 ${cur.rank} 名（門檻：${thresholdMode === "adaptive" ? "依此榜歷史波動自動計算" : "保守固定值"} ${Math.round(jumpThreshold)}）`,
          artist_name: cur.artist_name,
          track_name: cur.track_name,
          sources: [source],
          metrics: { chart_key: chartKey, rank_before: prev.rank, rank_after: cur.rank, jump, threshold_mode: thresholdMode },
          image_url: null,
        });
      }
    }
  }

  // ---- 動能延續：連續 MOMENTUM_MIN_STREAK 期名次都在上升（不是只看首尾） ----
  if (periodsSorted.length >= MOMENTUM_MIN_STREAK + 1) {
    const recentPeriods = periodsSorted.slice(-(MOMENTUM_MIN_STREAK + 1));
    const trackRankHistory = new Map(); // key -> [rank in each of the recent periods, oldest to newest]

    for (const [, rows] of recentPeriods) {
      const seen = new Set();
      for (const r of rows) {
        const key = trackKey(r);
        seen.add(key);
        if (!trackRankHistory.has(key)) trackRankHistory.set(key, []);
        trackRankHistory.get(key).push(r.rank);
      }
      // 這期沒出現的歌，補 null，讓長度對齊，之後判斷時會自然被排除（中斷連續上榜）
      for (const [key, arr] of trackRankHistory) {
        if (!seen.has(key)) arr.push(null);
      }
    }

    for (const [key, ranks] of trackRankHistory) {
      if (ranks.length < MOMENTUM_MIN_STREAK + 1) continue;
      if (ranks.some((r) => r == null)) continue; // 中間有中斷就不算持續動能
      let isConsistentlyRising = true;
      for (let i = 1; i < ranks.length; i++) {
        if (ranks[i] >= ranks[i - 1]) {
          isConsistentlyRising = false;
          break;
        }
      }
      if (isConsistentlyRising) {
        const latest = latestRows.find((r) => trackKey(r) === key);
        if (latest) {
          signals.push({
            日期: today,
            signal_type: "動能延續",
            title: `〈${latest.track_name || latest.artist_name}〉在 ${chartKey} 連續 ${MOMENTUM_MIN_STREAK} 期上升`,
            description: `${latest.artist_name}${latest.track_name ? `《${latest.track_name}》` : ""} 過去 ${MOMENTUM_MIN_STREAK} 期名次持續往上（${ranks.join(" → ")}），不是單次空降`,
            artist_name: latest.artist_name,
            track_name: latest.track_name,
            sources: [source],
            metrics: { chart_key: chartKey, rank_history: ranks },
            image_url: null,
          });
        }
      }
    }
  }

  return signals;
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

  let allSignals = [];
  let chartsWithEnoughHistory = 0;

  for (const [chartKey, periodsMap] of byChart) {
    if (periodsMap.size >= 2) chartsWithEnoughHistory++;
    const signals = detectSignalsForChart(chartKey, periodsMap);
    allSignals.push(...signals);
  }

  console.log(`${chartsWithEnoughHistory} / ${byChart.size} 個榜有至少 2 期快照可以比較`);
  console.log(`本次算出 ${allSignals.length} 個候選訊號`);

  const byType = {};
  for (const s of allSignals) byType[s.signal_type] = (byType[s.signal_type] || 0) + 1;
  console.log("分類統計：", byType);

  const BATCH = 300;
  let written = 0;
  for (let i = 0; i < allSignals.length; i += BATCH) {
    const batch = allSignals.slice(i, i + BATCH);
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
