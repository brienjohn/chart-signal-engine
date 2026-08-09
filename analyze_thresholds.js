// 一次性分析工具：算出各榜單「正常的漲跌幅度」「歌曲平均在榜多久」，
// 幫助校準訊號門檻該設多少才合理，不是憑感覺猜
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function fetchAllSnapshots() {
  const all = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/chart_snapshots?select=chart_key,rank,artist_name,track_name,captured_at&order=chart_key.asc,captured_at.asc&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) throw new Error(`讀取失敗：HTTP ${res.status}`);
    const page = await res.json();
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function trackKey(row) {
  return `${(row.artist_name || "").trim()}|||${(row.track_name || "").trim()}`;
}
function hasIdentity(row) {
  return (row.artist_name || "").trim() !== "" || (row.track_name || "").trim() !== "";
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("找不到 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，先確認 .env 有填好。");
    process.exit(1);
  }

  console.log("讀取 chart_snapshots...");
  const snapshots = await fetchAllSnapshots();
  console.log(`共 ${snapshots.length} 筆快照\n`);

  const byChart = new Map();
  for (const s of snapshots) {
    if (!hasIdentity(s)) continue;
    if (!byChart.has(s.chart_key)) byChart.set(s.chart_key, new Map());
    const periods = byChart.get(s.chart_key);
    if (!periods.has(s.captured_at)) periods.set(s.captured_at, []);
    periods.get(s.captured_at).push(s);
  }

  const allJumps = []; // { chartKey, jump, finalRank, chartSize }
  const chartingDurations = new Map(); // chart_key -> [每首歌出現的期數]

  for (const [chartKey, periodsMap] of byChart) {
    const periodsSorted = [...periodsMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (periodsSorted.length < 2) continue;

    // 漲跌幅度：每一期跟上一期比
    for (let i = 1; i < periodsSorted.length; i++) {
      const prevMap = new Map(periodsSorted[i - 1][1].map((r) => [trackKey(r), r.rank]));
      const chartSize = periodsSorted[i][1].length;
      for (const cur of periodsSorted[i][1]) {
        const prevRank = prevMap.get(trackKey(cur));
        if (prevRank != null && cur.rank != null && prevRank !== cur.rank) {
          allJumps.push({ chartKey, jump: prevRank - cur.rank, finalRank: cur.rank, chartSize });
        }
      }
    }

    // 在榜時長：這首歌總共出現在幾個不同期別裡
    const appearCount = new Map();
    for (const [, rows] of periodsSorted) {
      const seen = new Set();
      for (const r of rows) {
        const k = trackKey(r);
        if (seen.has(k)) continue;
        seen.add(k);
        appearCount.set(k, (appearCount.get(k) || 0) + 1);
      }
    }
    chartingDurations.set(chartKey, [...appearCount.values()]);
  }

  // ---- 統計 1：全部榜單混在一起看，正向跳動（名次進步）的分布 ----
  const risingJumps = allJumps.filter((j) => j.jump > 0).map((j) => j.jump).sort((a, b) => a - b);
  console.log("=== 全部榜單合併：名次進步幅度分布（只看變好的） ===");
  console.log(`樣本數：${risingJumps.length}`);
  console.log(`中位數：${percentile(risingJumps, 50)}`);
  console.log(`75百分位：${percentile(risingJumps, 75)}`);
  console.log(`90百分位：${percentile(risingJumps, 90)}`);
  console.log(`95百分位：${percentile(risingJumps, 95)}`);
  console.log(`99百分位：${percentile(risingJumps, 99)}`);
  console.log(`最大值：${risingJumps[risingJumps.length - 1]}\n`);

  // ---- 統計 2：分不同來源類型看（避免大小榜混在一起失真）----
  const bySourceType = new Map();
  for (const j of allJumps) {
    if (j.jump <= 0) continue;
    const prefix = j.chartKey.split("_").slice(0, 2).join("_");
    if (!bySourceType.has(prefix)) bySourceType.set(prefix, []);
    bySourceType.get(prefix).push(j.jump);
  }
  console.log("=== 分來源類型看進步幅度（樣本數 >= 20 才列出）===");
  for (const [prefix, jumps] of bySourceType) {
    if (jumps.length < 20) continue;
    const sorted = jumps.slice().sort((a, b) => a - b);
    console.log(`${prefix}｜樣本${sorted.length}｜中位數${percentile(sorted, 50)}｜90百分位${percentile(sorted, 90)}｜95百分位${percentile(sorted, 95)}`);
  }
  console.log("");

  // ---- 統計 3：在榜時長分布 ----
  const allDurations = [...chartingDurations.values()].flat().sort((a, b) => a - b);
  console.log("=== 在榜時長分布（單位：出現在幾個不同快照期別裡）===");
  console.log(`樣本數：${allDurations.length}`);
  console.log(`中位數：${percentile(allDurations, 50)}`);
  console.log(`75百分位：${percentile(allDurations, 75)}`);
  console.log(`90百分位：${percentile(allDurations, 90)}`);
  console.log(`最大值：${allDurations[allDurations.length - 1]}\n`);

  // ---- 統計 4：跳動幅度 vs 最終名次的關聯，抽樣看幾筆真實案例 ----
  console.log("=== 進步幅度前 20 名的真實案例（讓你有感覺什麼叫「真的誇張」）===");
  const topJumps = allJumps.filter((j) => j.jump > 0).sort((a, b) => b.jump - a.jump).slice(0, 20);
  for (const j of topJumps) {
    console.log(`${j.chartKey}｜跳 ${j.jump} 名｜最終第 ${j.finalRank} 名（榜單共 ${j.chartSize} 首）`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
