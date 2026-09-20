// 資料新鮮度巡邏：每天固定檢查一次每個榜（依 chart_key 前綴分類）最新一筆是哪天，
// 跟這個榜「該多久更新一次」的預期值比對，太久沒更新就在 GitHub 開 issue 通知。
//
// 設計原則：
// - 檢查的是 chart_snapshots（原始爬蟲資料），不是 chart_signals（每週才算一次的訊號結果）——
//   後者本來就是每週更新，拿來判斷「爬蟲有沒有斷」時間粒度太粗，看不出來。
// - 每個來源各自查一次「最新一筆是哪天」（order + limit=1），不是把一段時間範圍內的
//   所有原始列都撈下來、拉到自己這邊再排序——chart_snapshots 半年多下來累積的資料量，
//   撈整段時間範圍容易在資料庫那邊逾時（之前就是這樣才失敗的），
//   逐一查、每次只要資料庫吐一筆就好，負擔小很多。
// - 同一批持續發生的問題只會維護同一個 issue（用固定標題比對），用留言累加，
//   不會每天開一個新 issue 洗版；問題消失後自動把 issue 關閉。
// - 這支只負責偵測、通知，不做任何自動修正——不同來源斷掉的原因差異很大
//   （程式邏輯、網站改版、本機權限……），需要人工或另外開對話個別排查。
//
// 環境變數：SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GITHUB_TOKEN（GitHub Actions 內建提供，不用自己設）

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPOSITORY; // GitHub Actions 會自動帶入，格式 "owner/repo"
const ISSUE_TITLE = "⚠️ 資料抓取新鮮度異常";
const ISSUE_LABEL = "data-freshness";

// 每個要巡邏的來源：prefix 用來比對 chart_key 開頭（涵蓋該來源底下所有市場／類型），
// days 是「超過幾天沒更新算異常」的門檻，label 是顯示用的名稱。
const SOURCES = [
  { prefix: "spotify_daily_songs_", days: 3, label: "Spotify 每日榜" },
  { prefix: "spotify_weekly_artists_", days: 9, label: "Spotify 週榜（藝人）" },
  { prefix: "kkbox_", days: 3, label: "KKBOX（含官方榜與 kma）" }, // kkbox_kma_ 本身也是 kkbox_ 開頭，兩者用同一個 chart_key 前綴系統無法完全切開，合併成一項檢查
  { prefix: "streetvoice_realtime_", days: 3, label: "StreetVoice 即時榜" },
  { prefix: "streetvoice_weekly_", days: 9, label: "StreetVoice 週榜" },
  { prefix: "cashbox_", days: 9, label: "Cashbox 週榜" },
  { prefix: "youtube_trending_videos_", days: 3, label: "YouTube 發燒影片" },
  { prefix: "youtube_top_videos_daily_", days: 3, label: "YouTube 每日影片榜" },
  { prefix: "youtube_top_videos_weekly_", days: 9, label: "YouTube 週影片榜" },
  { prefix: "youtube_top_songs_weekly_", days: 9, label: "YouTube 週歌曲榜" },
  { prefix: "youtube_top_artists_weekly_", days: 9, label: "YouTube 週藝人榜" },
];

function daysSince(dateStr) {
  const then = new Date(dateStr).getTime();
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

// 查單一來源最新一筆的 captured_at；完全沒有資料回傳 null（不是拋錯，讓呼叫端自己判斷）
async function fetchLatest(prefix) {
  const url = `${SUPABASE_URL}/rest/v1/chart_snapshots?select=captured_at&chart_key=like.${encodeURIComponent(prefix + "*")}&order=captured_at.desc&limit=1`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`查詢 ${prefix} 失敗：HTTP ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rows[0].captured_at : null;
}

async function checkAll() {
  const problems = [];
  for (const source of SOURCES) {
    const latest = await fetchLatest(source.prefix);
    if (!latest) {
      problems.push({ ...source, latest: null, ageDays: null });
      continue;
    }
    const age = daysSince(latest);
    if (age > source.days) {
      problems.push({ ...source, latest, ageDays: Math.floor(age) });
    }
  }
  return problems;
}

function formatIssueBody(problems, checkedAt) {
  const lines = [
    `巡邏時間：${checkedAt}（台北時間）`,
    "",
    "| 來源 | 最新資料 | 落後天數 | 門檻 |",
    "|---|---|---|---|",
    ...problems.map((p) =>
      p.latest
        ? `| ${p.label} | ${p.latest.slice(0, 10)} | ${p.ageDays} 天 | ${p.days} 天 |`
        : `| ${p.label} | 完全沒有資料 | — | — |`
    ),
    "",
    "這個 issue 是自動巡邏產生的，只負責偵測，不會自動修正。之後每次巡邏如果問題還在，會在下面留言更新；問題消失後會自動關閉。",
  ];
  return lines.join("\n");
}

async function ghApi(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API 失敗：${path} -> HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function findOpenIssue() {
  const issues = await ghApi(`/issues?state=open&labels=${encodeURIComponent(ISSUE_LABEL)}&per_page=10`);
  return issues.find((i) => i.title === ISSUE_TITLE) || null;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GITHUB_TOKEN || !GITHUB_REPO) {
    throw new Error("缺少必要的環境變數（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GITHUB_TOKEN / GITHUB_REPOSITORY）");
  }

  const checkedAt = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  const problems = await checkAll();
  const existingIssue = await findOpenIssue();

  if (!problems.length) {
    console.log("[OK] 所有來源都在正常更新範圍內。");
    if (existingIssue) {
      await ghApi(`/issues/${existingIssue.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `巡邏時間：${checkedAt}（台北時間）\n\n所有來源都恢復正常更新了，關閉這個 issue。` }),
      });
      await ghApi(`/issues/${existingIssue.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
      console.log(`[OK] 已關閉先前的 issue #${existingIssue.number}`);
    }
    return;
  }

  console.log(`[異常] 發現 ${problems.length} 個來源超過更新門檻：`);
  problems.forEach((p) => console.log(`  - ${p.label}：最新 ${p.latest || "無"}`));

  const body = formatIssueBody(problems, checkedAt);

  if (existingIssue) {
    await ghApi(`/issues/${existingIssue.number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    console.log(`[OK] 已更新既有 issue #${existingIssue.number}`);
  } else {
    const created = await ghApi(`/issues`, {
      method: "POST",
      body: JSON.stringify({ title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] }),
    });
    console.log(`[OK] 已建立新 issue #${created.number}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
