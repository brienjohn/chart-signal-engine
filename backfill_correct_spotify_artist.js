// 一次性腳本：Spotify 每日歌曲榜的歷史資料，當初 ingest_snapshots.js 欄位名稱寫錯
// （抓的是不存在的 primary_artist_name，不是爬蟲實際輸出的 artist_names），
// 導致 2026-08-30 之前的資料，藝人名全部是空的。
//
// 因為 chart_snapshots 判斷「是不是同一筆」的組合鍵裡包含 artist_name 本身，
// 修好欄位名稱、重新 ingest 最近幾天的資料時，不會覆蓋舊的空白版本，
// 只會另外插入一筆新的、藝人名正確的版本——舊資料還在，變成兩筆並存。
//
// 這支腳本把全部歷史 CSV 用正確欄位重新跑一次 upsert，補上正確版本；
// 跑完之後，要另外用 SQL 把舊的空白藝人名版本刪掉（見下方 console 提示）。
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
        if (cleaned[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); field = ""; rows.push(row); row = []; i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).filter((r) => !(r.length === 1 && r[0] === "")).map((values) => {
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
  const repo = "spotify-daily-scraper";
  let listing;
  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/data`;
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    listing = await res.json();
  } catch (e) {
    console.error(`列出檔案失敗：${e.message}`);
    process.exit(1);
  }

  const files = listing.filter((f) => /^spotify_daily_songs_\d{4}-\d{2}-\d{2}\.csv$/.test(f.name));
  console.log(`共 ${files.length} 個歷史檔案要重新處理`);

  let totalRows = 0;
  for (const f of files) {
    let rows;
    try {
      const res = await fetch(f.download_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rows = parseCsv(await res.text());
    } catch (e) {
      console.warn(`[warn] 讀取 ${f.name} 失敗：${e.message}`);
      continue;
    }

    const mapped = rows.map((r) => ({
      source: "spotify_daily_songs",
      chart_key: `spotify_daily_songs_${r.market}`,
      rank: parseInt(r.rank, 10) || null,
      artist_name: r.artist_names || "",
      track_name: r.track_name || "",
      captured_at: toEpoch(r.captured_date),
      metrics: {
        market: r.market,
        rank_change: r.rank_change,
        streams: r.streams,
        spotify_track_id: r.track_spotify_id,
        spotify_artist_id: (r.artist_spotify_ids || "").split(";")[0]?.trim() || "",
        image_url: r.image_url || "",
      },
    })).filter((r) => r.artist_name && r.captured_at);

    const BATCH = 500;
    for (let i = 0; i < mapped.length; i += BATCH) {
      try {
        await insertSnapshots(mapped.slice(i, i + BATCH));
      } catch (e) {
        console.warn(`[warn] ${f.name} 第 ${i}-${i + BATCH} 筆寫入失敗：${e.message}`);
      }
    }
    totalRows += mapped.length;
    console.log(`[${f.name}] 補上 ${mapped.length} 筆正確藝人名的版本`);
  }

  console.log(`\n完成，共補上 ${totalRows} 筆。`);
  console.log(`接下來去 Supabase SQL Editor 跑這條，把舊的空白藝人名版本清掉：`);
  console.log(`  delete from chart_snapshots where source = 'spotify_daily_songs' and artist_name = '';`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
