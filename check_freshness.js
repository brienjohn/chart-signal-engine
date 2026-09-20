// 資料新鮮度巡邏：每天固定檢查一次 chart_snapshots 裡每個榜（chart_key）最新一筆
// 是哪天，跟這個榜「該多久更新一次」的預期值比對，太久沒更新就在 GitHub 開 issue 通知。
//
// 設計原則：
// - 檢查的是 chart_snapshots（原始爬蟲資料），不是 chart_signals（每週才算一次的訊號結果）——
//   後者本來就是每週更新，拿來判斷「爬蟲有沒有斷」時間粒度太粗，看不出來。
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

// 每一種榜「多久沒更新算異常」的門檻（天）。用 chart_key 的字串特徵去比對，
// 不用每個 market/genre 都列一行——同一種榜不管哪個市場，正常更新頻率都一樣。
// 順序有意義：由上而下比對，第一個符合的規則生效。
const RULES = [
  { test: (k) => k.startsWith("cashbox_"), days: 9, label: "Cashbox 週榜" },
  { test: (k) => k.includes("trending_videos"), days: 3, label: "YouTube 發燒影片" },
  { test: (k) => k.includes("weekly"), days: 9, label: "週榜" },
  { test: (k) => k.includes("daily") || k.includes("realtime"), days: 3, label: "日榜／即時榜" },
  { test: () => true, days: 3, label: "（未分類，預設當日榜處理）" }, // 保底：新出現、沒對到規則的來源，寧可誤報也不要漏掉
];

// 目前所有應該要在跑的榜單前綴，用來抓「完全沒有任何一筆最近資料」的情況
// （如果某個來源徹底斷了，Supabase 查詢視窗內可能連一筆都撈不到，不會自然出現在結果裡，
// 所以要另外拿這份清單去對照，抓出「查詢結果裡完全沒出現」的項目）
const EXPECTED_PREFIXES = [
  "spotify_daily_songs_",
  "spotify_weekly_artists_",
  "kkbox_",
  "streetvoice_realtime_",
  "streetvoice_weekly_",
  "cashbox_",
  "youtube_trending_videos_",
  "youtube_top_videos_daily_",
  "youtube_top_videos_weekly_",
  "youtube_top_songs_weekly_",
  "youtube_top_artists_weekly_",
];

function ruleFor(chartKey) {
  return RULES.find((r) => r.test(chartKey));
}

function daysSince(dateStr) {
  const then = new Date(dateStr).getTime();
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

async function fetchRecentSnapshots() {
  // 只抓最近 15 天的資料就夠判斷新鮮度，不用整張表撈下來
  const since = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/chart_snapshots?select=chart_key,captured_at&captured_at=gte.${encodeURIComponent(since)}&order=captured_at.desc`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`查詢 Supabase 失敗：HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

function summarize(rows) {
  // 每個 chart_key 只留最新一筆
  const latestByKey = new Map();
  for (const row of rows) {
    const prev = latestByKey.get(row.chart_key);
    if (!prev || row.captured_at > prev) latestByKey.set(row.chart_key, row.captured_at);
  }

  const problems = [];

  for (const [chartKey, latest] of latestByKey.entries()) {
    const rule = ruleFor(chartKey);
    const age = daysSince(latest);
    if (age > rule.days) {
      problems.push({ chartKey, latest, ageDays: Math.floor(age), thresholdDays: rule.days, label: rule.label });
    }
  }

  // 完全沒出現在最近 15 天資料裡的來源，額外抓出來（比上面「有資料但太舊」更嚴重）
  for (const prefix of EXPECTED_PREFIXES) {
    const seen = [...latestByKey.keys()].some((k) => k.startsWith(prefix));
    if (!seen) {
      problems.push({ chartKey: prefix + "*", latest: null, ageDays: null, thresholdDays: null, label: "近 15 天完全沒有任何資料" });
    }
  }

  return problems;
}

function formatIssueBody(problems, checkedAt) {
  if (!problems.length) return null;
  const lines = [
    `巡邏時間：${checkedAt}（台北時間）`,
    "",
    "| chart_key | 狀態 | 最新資料 | 落後天數 | 門檻 |",
    "|---|---|---|---|---|",
    ...problems.map((p) =>
      p.latest
        ? `| \`${p.chartKey}\` | ${p.label} | ${p.latest.slice(0, 10)} | ${p.ageDays} 天 | ${p.thresholdDays} 天 |`
        : `| \`${p.chartKey}\` | ${p.label} | — | — | — |`
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
  const rows = await fetchRecentSnapshots();
  const problems = summarize(rows);
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
  problems.forEach((p) => console.log(`  - ${p.chartKey}：${p.label}，最新 ${p.latest || "無"}`));

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
