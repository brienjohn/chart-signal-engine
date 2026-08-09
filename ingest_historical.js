// 訊號引擎 - 歷史資料補匯入
// 跟 ingest_snapshots.js 不一樣：那支只看「最新一次 commit」，這支會把整個 data/
// 資料夾裡「所有」符合條件的歷史檔案都掃過去匯入，用來吃掉之前已經爬到、
// 但資料庫還沒真正收進去的回溯資料。可以重複執行，已經進去的不會重複寫入。
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const GITHUB_OWNER = "brienjohn";

function githubHeaders() {
  const headers = { Accept: "application/vnd.github+json" };
  if (GITHUB_TOKEN) headers.Authorization = `token ${GITHUB_TOKEN}`;
  return headers;
}

function toEpoch(v) {
  const t = Date.parse(v);
  return isNaN(t) ? null : new Date(t).toISOString();
}

// 這三個來源已經確認有回溯資料堆在 GitHub 上、檔案數量也不大（幾十個以內），
// 直接列整個資料夾就好，不會遇到大型 repo（像 StreetVoice 即時榜）目錄列表被截斷的問題
const HISTORICAL_SOURCES = [
  {
    source: "cashbox",
    repo: "cashbox-ktv-weekly",
    prefix: "cashbox_ktv_weekly_top30_",
    perFile: true,
    // rank 欄位存的是升降符號不是名次，真正名次要用「同一個榜裡排第幾行」來算，
    // 國語／台語兩個榜混在同一個檔案裡，計數要分開
    parseRow: (records) => {
      const counters = {};
      return records.map((r) => {
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
      });
    },
  },
  {
    source: "iradio",
    repo: "iradio-scraper",
    prefix: "iradio_",
    perFile: true,
    // 原始資料是播出紀錄，沒有名次，用「當天播放次數」自己算出一個排名
    // （播越多次代表當天越熱門），今天播放的檔案（iradio_today.csv）先跳過，
    // 只吃有明確日期、已經播完一整天的檔案
    excludeExact: "iradio_today.csv",
    parseRow: (records) => {
      const counts = new Map(); // key -> { count, artist, song, date }
      for (const r of records) {
        const artist = (r["演唱(奏)者"] || "").trim();
        const song = (r["歌曲名稱"] || "").trim();
        const date = r["日期"];
        if (!song && !artist) continue;
        const key = `${artist}|||${song}`;
        if (!counts.has(key)) counts.set(key, { count: 0, artist, song, date });
        counts.get(key).count += 1;
      }
      const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
      return ranked.map((item, idx) => ({
        chart_key: "iradio_playlist",
        rank: idx + 1,
        artist_name: item.artist,
        track_name: item.song,
        captured_at: toEpoch(item.date),
        metrics: { play_count_that_day: item.count },
      }));
    },
  },
  {
    source: "streetvoice_weekly",
    repo: "streetvoice-realtime-scraper",
    prefix: "streetvoice_weekly_",
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
        image_url: r.cover_image_url || "",
      },
    }),
  },
  {
    source: "kkbox_kma",
    repo: "kkbox-charts-scraper",
    prefix: "kkbox_kma_",
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
        image_url: r.cover_image_url || "",
      },
    }),
  },
  {
    source: "spotify_daily_songs",
    repo: "spotify-daily-scraper",
    prefix: "spotify_daily_songs_",
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
        image_url: r.image_url || "",
      },
    }),
  },
];

async function listAllDataFiles(repo) {
  // StreetVoice 這種大型 repo，data 資料夾裡混著即時榜長期累積下來的大量檔案，
  // 用一般的目錄列表 API 會被 GitHub 默默截斷（跟之前踩過的坑一樣），
  // 改用 Git Trees API 一次拿到完整的檔案樹，不會有這個問題
  const repoInfoRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}`, { headers: githubHeaders() });
  if (!repoInfoRes.ok) throw new Error(`讀取 repo 資訊失敗：HTTP ${repoInfoRes.status}`);
  const repoInfo = await repoInfoRes.json();
  const defaultBranch = repoInfo.default_branch || "main";

  const treeRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/git/trees/${defaultBranch}?recursive=1`,
    { headers: githubHeaders() }
  );
  if (!treeRes.ok) throw new Error(`讀取檔案樹失敗：HTTP ${treeRes.status}`);
  const treeData = await treeRes.json();
  if (treeData.truncated) {
    console.warn(`[warn] ${repo} 的檔案樹太大，Git Trees API 也被截斷了，可能還是會漏掉部分檔案`);
  }
  return (treeData.tree || [])
    .filter((item) => item.type === "blob" && item.path.startsWith("data/"))
    .map((item) => ({
      name: item.path.replace(/^data\//, ""),
      download_url: `https://raw.githubusercontent.com/${GITHUB_OWNER}/${repo}/${defaultBranch}/${item.path}`,
    }));
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

async function upsertSnapshots(rows) {
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

  for (const src of HISTORICAL_SOURCES) {
    console.log(`\n=== ${src.source}（repo: ${src.repo}）===`);
    let allFiles;
    try {
      allFiles = await listAllDataFiles(src.repo);
    } catch (e) {
      console.warn(`[warn] 列出檔案失敗：${e.message}`);
      continue;
    }
    const matched = allFiles
      .filter((f) => f.name.startsWith(src.prefix))
      .filter((f) => !src.excludeExact || f.name !== src.excludeExact);
    console.log(`找到 ${matched.length} 個檔案`);

    let sourceRows = [];
    for (const f of matched) {
      try {
        const res = await fetch(f.download_url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const records = parseCsv(text);
        if (src.perFile) {
          // 這個來源要看完整個檔案才能算（例如要先數完當天播幾次才知道排名）
          const mappedRows = src.parseRow(records);
          for (const mapped of mappedRows) sourceRows.push({ source: src.source, ...mapped });
        } else {
          for (const r of records) {
            const mapped = src.parseRow(r);
            sourceRows.push({ source: src.source, ...mapped });
          }
        }
      } catch (e) {
        console.warn(`[warn] 讀取 ${f.name} 失敗：${e.message}`);
      }
    }

    // 同一批裡去重，避免同個自然鍵在同一個 upsert 指令裡出現兩次而整批失敗
    const dedupMap = new Map();
    for (const row of sourceRows) {
      const key = `${row.source}|||${row.chart_key}|||${row.captured_at}|||${row.artist_name}|||${row.track_name}`;
      dedupMap.set(key, row);
    }
    sourceRows = [...dedupMap.values()];
    console.log(`共 ${sourceRows.length} 筆待寫入`);

    const BATCH = 500;
    for (let i = 0; i < sourceRows.length; i += BATCH) {
      const batch = sourceRows.slice(i, i + BATCH);
      try {
        await upsertSnapshots(batch);
        totalInserted += batch.length;
        console.log(`  已寫入第 ${i}-${i + batch.length} 筆`);
      } catch (e) {
        console.warn(`[warn] 寫入第 ${i}-${i + batch.length} 筆失敗：${e.message}`);
      }
    }
  }

  console.log(`\n本次總計處理 ${totalInserted} 筆（已存在的會被覆蓋更新，不會重複）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
