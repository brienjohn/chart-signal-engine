// 追加診斷：查每個 chart_key 各自有多少期資料（樣本夠不夠拆更細），
// 以及同一個來源類型底下，不同市場的漲跌分布是不是真的不一樣
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

  // ---- 問題 2：每個 chart_key 各自有幾期資料 ----
  console.log("=== 每個 chart_key 的期數（樣本夠不夠拆更細的關鍵）===");
  const periodCounts = [...byChart.entries()].map(([key, periods]) => ({ key, periods: periods.size }));
  periodCounts.sort((a, b) => a.periods - b.periods);
  const counts = periodCounts.map((p) => p.periods);
  console.log(`chart_key 總數：${periodCounts.length}`);
  console.log(`期數最少：${counts[0]}，最多：${counts[counts.length - 1]}`);
  console.log(`期數中位數：${percentile(counts, 50)}`);
  console.log(`期數 <= 3 的 chart_key 有幾個：${counts.filter((c) => c <= 3).length}`);
  console.log(`期數 >= 10 的 chart_key 有幾個：${counts.filter((c) => c >= 10).length}\n`);

  console.log("--- 期數最少的 15 個 chart_key（樣本太少，任何統計都不可靠）---");
  for (const p of periodCounts.slice(0, 15)) console.log(`  ${p.key}：${p.periods} 期`);
  console.log("");
  console.log("--- 期數最多的 15 個 chart_key ---");
  for (const p of periodCounts.slice(-15).reverse()) console.log(`  ${p.key}：${p.periods} 期`);
  console.log("");

  // ---- 問題 1：spotify_daily_songs 底下，不同市場的漲跌分布真的不一樣嗎 ----
  console.log("=== spotify_daily_songs 拆到「各市場」，漲跌分布還一樣嗎 ===");
  const byMarketJumps = new Map();
  for (const [chartKey, periodsMap] of byChart) {
    if (!chartKey.startsWith("spotify_daily_songs_")) continue;
    const periodsSorted = [...periodsMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (periodsSorted.length < 2) continue;
    if (!byMarketJumps.has(chartKey)) byMarketJumps.set(chartKey, []);
    for (let i = 1; i < periodsSorted.length; i++) {
      const prevMap = new Map(periodsSorted[i - 1][1].map((r) => [trackKey(r), r.rank]));
      for (const cur of periodsSorted[i][1]) {
        const prevRank = prevMap.get(trackKey(cur));
        if (prevRank != null && cur.rank != null && prevRank > cur.rank) {
          byMarketJumps.get(chartKey).push(prevRank - cur.rank);
        }
      }
    }
  }
  for (const [chartKey, jumps] of byMarketJumps) {
    const sorted = jumps.slice().sort((a, b) => a - b);
    console.log(`${chartKey}｜期數樣本${sorted.length}｜中位數${percentile(sorted, 50)}｜90百分位${percentile(sorted, 90)}｜95百分位${percentile(sorted, 95)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
