// 追加分析：把「新進榜」「動能延續」的歷史分布也算出來，
// 方法比照原本「劇烈變動」門檻的算法（歷史百分位），這樣三種訊號才有同一套「這是不是真的
// 比大部分同類情況突出」的判斷基準，不是只有劇烈變動有門檻、其他兩種來者不拒。
//
// 動能延續這邊，連續上升的判斷改成「只有真的退步（或缺席）才算中斷，持平不算」，
// 這是配合同一輪要對 compute_signals.js 做的邏輯調整，用新邏輯回測才準。
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MOMENTUM_MIN_STREAK = 3;

async function fetchAllSnapshots() {
  const all = [];
  let lastId = -1;
  const pageSize = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/chart_snapshots?select=id,chart_key,rank,artist_name,track_name,captured_at&id=gt.${lastId}&order=id.asc&limit=${pageSize}`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`讀取失敗：HTTP ${res.status} ${body.slice(0, 300)}`);
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
function sourceTypeOf(chartKey) {
  return chartKey.split("_").slice(0, 2).join("_");
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("找不到 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，先確認環境變數有填好。");
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

  const newEntryBySrc = new Map(); // sourceType -> [首次登場名次百分比...]
  const momentumBySrc = new Map(); // sourceType -> [連續上升區段的爬升名次數...]

  for (const [chartKey, periodsMap] of byChart) {
    const srcType = sourceTypeOf(chartKey);
    const periods = [...periodsMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (periods.length < 2) continue;

    // ---- 新進榜：逐期比對，第一次出現的記錄它當時的名次百分比 ----
    const seenEver = new Set();
    for (const [, rows] of periods) {
      const chartSize = rows.length;
      for (const r of rows) {
        const key = trackKey(r);
        if (!seenEver.has(key) && r.rank != null) {
          const pct = 1 - (r.rank - 1) / chartSize;
          if (!newEntryBySrc.has(srcType)) newEntryBySrc.set(srcType, []);
          newEntryBySrc.get(srcType).push(pct);
        }
        seenEver.add(key);
      }
    }

    // ---- 動能延續：每首歌的完整名次序列（缺席記 null），找出所有滿足最短長度的
    // 連續上升區段（只有真的退步或缺席才算中斷，持平不算），記錄每段的爬升名次數 ----
    const trackHistory = new Map();
    for (const [, rows] of periods) {
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
    for (const [, ranks] of trackHistory) {
      if (ranks.length < MOMENTUM_MIN_STREAK + 1) continue;
      let streakStart = 0;
      for (let i = 1; i <= ranks.length; i++) {
        const broke = i === ranks.length || ranks[i] == null || ranks[i - 1] == null || ranks[i] > ranks[i - 1];
        if (broke) {
          const streakLen = i - streakStart;
          if (streakLen >= MOMENTUM_MIN_STREAK && ranks[streakStart] != null && ranks[i - 1] != null) {
            const climbed = ranks[streakStart] - ranks[i - 1];
            if (climbed > 0) {
              if (!momentumBySrc.has(srcType)) momentumBySrc.set(srcType, []);
              momentumBySrc.get(srcType).push(climbed);
            }
          }
          streakStart = i;
        }
      }
    }
  }

  console.log("=== 新進榜：首次登場名次百分比分布（1 = 衝進榜首，0 = 吊車尾）===");
  for (const [src, arr] of [...newEntryBySrc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...arr].sort((a, b) => a - b);
    console.log(
      `${src}｜樣本${sorted.length}｜中位數${percentile(sorted, 50)?.toFixed(3)}｜90百分位${percentile(sorted, 90)?.toFixed(3)}｜95百分位${percentile(sorted, 95)?.toFixed(3)}`
    );
  }

  console.log("\n=== 動能延續：連續上升區段的爬升名次數分布 ===");
  for (const [src, arr] of [...momentumBySrc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...arr].sort((a, b) => a - b);
    console.log(
      `${src}｜樣本${sorted.length}｜中位數${percentile(sorted, 50)}｜90百分位${percentile(sorted, 90)}｜95百分位${percentile(sorted, 95)}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
