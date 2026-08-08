// 訊號引擎 - 第 1 層：資料進來（ingestion）
// 從六個來源 repo 抓最新的 CSV，各自轉成統一格式，寫進 Supabase 的 chart_snapshots
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const GITHUB_OWNER = "brienjohn";

// ---- 各來源設定：repo 名稱、要抓哪個檔名前綴、怎麼把一列資料轉成統一格式 ----

function toEpoch(v) {
  const t = Date.parse(v);
  return isNaN(t) ? null : new Date(t).toISOString();
}

const SOURCES = [
  {
    source: "spotify_daily_songs",
    repo: "spotify-daily-scraper",
    prefix: "data/spotify_daily_songs_",
    parseRow: (r) => ({
      chart_key: `spotify_daily_songs_${r.market}`,
      rank: parseInt(r.rank, 10) || null,
      artist_name: r.primary_artist_name || "",
      track_name: r.track_name || "",
      captured_at: toEpoch(r.captured_date),
      metrics: {
        market: r.market,
        rank_change: r.rank_change,
        streams: r.streams,
        spotify_track_id: r.track_spotify_id,
        spotify_artist_id: r.primary_artist_spotify_id,
      },
    }),
  },
  {
    source: "spotify_weekly_artists",
    repo: "spotify-daily-scraper",
    prefix: "data/spotify_weekly_artists_",
    parseRow: (r) => ({
      chart_key: `spotify_weekly_artists_${r.market}`,
      rank: parseInt(r.rank, 10) || null,
      artist_name: r.artist_name || "",
      track_name: "",
      captured_at: toEpoch(r.captured_week_end),
      metrics: { market: r.market, rank_change: r.rank_change, spotify_artist_id: r.artist_spotify_id },
    }),
  },
  {
    source: "kkbox_official",
    repo: "kkbox-charts-scraper",
    prefix: "data/kkbox_",
    excludePrefix: "data/kkbox_kma_",
    parseRow: (r) => ({
      chart_key: `kkbox_${r.genre}_${r.chart_type}_daily`,
      rank: parseInt(r.rank, 10) || null,
      artist_name: r.artist_name || "",
      track_name: r.track_name || "",
      captured_at: toEpoch(r.captured_date),
      metrics: { genre: r.genre, chart_type: r.chart_type, kkbox_artist_id: r.artist_id, kkbox_track_id: r.track_id },
    }),
  },
  {
    source: "kkbox_kma",
    repo: "kkbox-charts-scraper",
    prefix: "data/kkbox_kma_",
    parseRow: (r) => ({
      chart_key: `kkbox_kma_${r.genre}_${r.chart_type}_${r.timeframe}`,
      rank: parseInt(r.rank_this_period, 10) || null,
      artist_name: r.artist_name || "",
      track_name: r.song_name || r.album_name || "",
      captured_at: toEpoch(r.captured_date),
      metrics: {
        genre: r.genre,
        chart_type: r.chart_type,
        timeframe: r.timeframe,
        rank_last_period: r.rank_last_period,
        period_suffix: r.period_suffix,
        artist_url: r.artist_url,
      },
    }),
  },
  {
    source: "streetvoice_realtime",
    repo: "streetvoice-realtime-scraper",
    prefix: "data/streetvoice_realtime_",
    parseRow: (r) => ({
      chart_key: `streetvoice_${r.chart_timeframe}_${r.chart_genre}`,
      rank: parseInt(r.rank, 10) || null,
      artist_name: r.artist_name || "",
      track_name: r.song_title || "",
      captured_at: toEpoch(r.snapshot_time),
      metrics: {
        play_count: r.play_count,
        likes_count: r.likes_count,
        honors: r.honors,
        artist_url: r.artist_url,
        song_url: r.song_url,
      },
    }),
  },
  {
    source: "streetvoice_weekly",
    repo: "streetvoice-realtime-scraper",
    prefix: "data/streetvoice_weekly_",
    parseRow: (r) => ({
      chart_key: `streetvoice_${r.chart_timeframe}_${r.chart_genre}`,
      rank: parseInt(r.rank, 10) || null,
      artist_name: r.artist_name || "",
      track_name: r.song_title || "",
      captured_at: toEpoch(r.snapshot_time),
      metrics: {
        play_count: r.play_count,
        likes_count: r.likes_count,
        honors: r.honors,
        artist_url: r.artist_url,
        song_url: r.song_url,
      },
    }),
  },
  {
    source: "cashbox",
    repo: "cashbox-ktv-weekly",
    prefix: "data/cashbox_ktv_weekly_top30_",
    // 這個來源的 rank 欄位存的是「↑／↓／－」升降符號，不是名次數字，
    // 真正的名次要用「同一個榜（國語／台語）裡排第幾行」來算，兩個榜的計數要分開
    statefulRank: true,
    parseRow: (r, index, counters) => {
      const key = r.chart || "unknown";
      counters[key] = (counters[key] || 0) + 1;
      return {
        chart_key: `cashbox_${r.chart}`,
        rank: counters[key],
        artist_name: r.artist || "",
        track_name: r.title || "",
        captured_at: toEpoch(r.captured_at),
        metrics: {
          rank_change_symbol: r.rank,
          last_week_rank: r.last_week_rank,
          is_new_entry: r.is_new_entry,
          weeks_on_chart: r.weeks_on_chart,
        },
      };
    },
  },
  {
    source: "youtube",
    repo: "youtube-charts-scraper",
    prefix: "data/youtube_",
    parseRow: (r) => ({
      chart_key: `youtube_${r.chart}_${r.market}`,
      rank: parseInt(r.rank, 10) || null,
      artist_name: r.secondary_name || "",
      track_name: r.primary_name || "",
      captured_at: toEpoch(r.captured_date),
      metrics: { market: r.market, release_date: r.release_date, metric_value: r.metric_value, raw_text: r.raw_text },
    }),
  },
];

// ---- GitHub：用「最近幾次 commit 各自動了哪些檔案」找出每個來源最新的一批檔案，
// 不去列整個 data 資料夾（大型 repo 檔案數會超過 GitHub 目錄列表 API 的上限，被默默截斷）----

async function listRecentCommits(repo, pathPrefix, perPage = 15) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/commits?path=${encodeURIComponent(pathPrefix)}&per_page=${perPage}`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`列出 ${repo} 最近 commit 失敗：HTTP ${res.status}`);
  return res.json();
}

async function getCommitFiles(repo, sha) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/commits/${sha}`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`讀取 commit ${sha} 失敗：HTTP ${res.status}`);
  const data = await res.json();
  return (data.files || [])
    .filter((f) => f.status !== "removed")
    .map((f) => ({
      name: f.filename.split("/").pop(),
      path: f.filename,
      sha,
    }));
}

// 針對某個來源的檔名前綴，在最近幾次 commit 裡找「第一次（最新一次）真的有動到符合前綴檔案」的那次，
// 回傳那次 commit 裡符合前綴的所有檔案
async function findLatestMatchingCommitFiles(repo, prefix, excludePrefix, commitsCache) {
  if (!commitsCache[repo]) {
    commitsCache[repo] = await listRecentCommits(repo, "data", 15);
  }
  const commits = commitsCache[repo];

  for (const c of commits) {
    let files;
    try {
      files = await getCommitFiles(repo, c.sha);
    } catch (e) {
      console.warn(`[warn] 讀取 ${repo}@${c.sha.slice(0, 7)} 檔案清單失敗：${e.message}`);
      continue;
    }
    let matched = files.filter((f) => f.path.startsWith(prefix));
    if (excludePrefix) matched = matched.filter((f) => !f.path.startsWith(excludePrefix));
    if (matched.length) {
      return matched.map((f) => ({
        name: f.name,
        download_url: `https://raw.githubusercontent.com/${GITHUB_OWNER}/${repo}/${f.sha}/${f.path}`,
      }));
    }
  }
  return [];
}

function parseCsv(text) {
  const cleaned = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = cleaned.length;

  while (i < n) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // 檔案結尾沒有換行的話，把最後累積的欄位／列補進去
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (!rows.length) return [];
  const headers = rows[0];
  return rows
    .slice(1)
    .filter((r) => !(r.length === 1 && r[0] === ""))
    .map((values) => {
      const obj = {};
      headers.forEach((h, idx) => (obj[h] = values[idx] ?? ""));
      return obj;
    });
}

async function insertSnapshots(rows) {
  if (!rows.length) return;
  const url = `${SUPABASE_URL}/rest/v1/chart_snapshots?on_conflict=source,chart_key,captured_at,artist_name,track_name`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase 寫入失敗：HTTP ${res.status} ${body.slice(0, 300)}`);
  }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("找不到 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，先確認 .env 有填好。");
    process.exit(1);
  }

  let totalInserted = 0;

  // 同一個 repo 的 commit 清單快取起來，避免每個來源重複打 API
  const commitsCache = {};

  for (const src of SOURCES) {
    let files;
    try {
      files = await findLatestMatchingCommitFiles(src.repo, src.prefix, src.excludePrefix, commitsCache);
    } catch (e) {
      console.warn(`[warn] ${src.source} 找檔案失敗：${e.message}`);
      files = [];
    }
    if (!files.length) {
      console.warn(`[warn] ${src.source}：最近幾次 commit 裡都找不到符合的檔案`);
      continue;
    }

    let sourceRows = [];
    for (const f of files) {
      try {
        const res = await fetch(f.download_url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const records = parseCsv(text);
        const counters = {};
        records.forEach((r, index) => {
          const mapped = src.parseRow(r, index, counters);
          sourceRows.push({ source: src.source, ...mapped });
        });
      } catch (e) {
        console.warn(`[warn] ${src.source} 讀取 ${f.name} 失敗：${e.message}`);
      }
    }

    // Supabase 一次寫入筆數太多容易超時，切成小批
    const BATCH = 500;
    for (let i = 0; i < sourceRows.length; i += BATCH) {
      const batch = sourceRows.slice(i, i + BATCH);
      try {
        await insertSnapshots(batch);
        totalInserted += batch.length;
      } catch (e) {
        console.warn(`[warn] ${src.source} 寫入 Supabase 失敗（第 ${i}-${i + batch.length} 筆）：${e.message}`);
      }
    }

    console.log(`[${src.source}] ${files.length} 個檔案 -> ${sourceRows.length} 筆`);
  }

  console.log(`本次總計寫入 ${totalInserted} 筆到 chart_snapshots`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
