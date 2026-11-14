// 每週修剪：只保留 chart_snapshots 最近 PRUNE_RETAIN_DAYS 天（預設 60 天）的資料，
// 讓資料庫維持在 Supabase 免費方案 500 MB 以內。
//
// 做法：重複呼叫資料庫函式 prune_chart_snapshots(retain_days, batch_size)，
// 每次刪一批（5000 筆），直到回傳 0 為止。分批是因為經由 API 呼叫時每個請求有 8 秒上限。
// 每一批在同一個指令裡先把要刪的歌寫進 track_first_seen（保住「以前上過榜」的判斷），再刪除，
// 所以就算中途失敗，也不會出現「刪了但沒登記」的狀況，下次重跑會接著做。
//
// 刪掉的空間會由 Postgres 自動回收給之後的新資料使用，所以資料庫大小會大致持平，
// 不會因為修剪就立刻變小。
//
// 環境變數：SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PRUNE_RETAIN_DAYS（選填，預設 60）

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RETAIN_DAYS = Number(process.env.PRUNE_RETAIN_DAYS || "60");
const BATCH_SIZE = 5000;
const MAX_BATCHES = 400; // 安全上限：最多刪 200 萬筆就停，避免任何意外造成無限迴圈

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpc(name, body, attempt = 1) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 4xx 是參數或權限錯誤，重試沒用，直接中止
      if (res.status < 500 || attempt >= 3) throw new Error(`呼叫 ${name} 失敗：HTTP ${res.status} ${text}`);
      console.log(`  呼叫 ${name} 失敗（HTTP ${res.status}），${attempt * 5} 秒後重試……`);
      await sleep(attempt * 5000);
      return rpc(name, body, attempt + 1);
    }
    return res.json();
  } catch (e) {
    if (e.message.startsWith(`呼叫 ${name} 失敗`) || attempt >= 3) throw e;
    console.log(`  連線錯誤（${e.message}），${attempt * 5} 秒後重試……`);
    await sleep(attempt * 5000);
    return rpc(name, body, attempt + 1);
  }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("缺少必要的環境變數（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）");
  }
  if (!Number.isInteger(RETAIN_DAYS) || RETAIN_DAYS < 14) {
    throw new Error(`PRUNE_RETAIN_DAYS 要是 14 以上的整數，收到「${process.env.PRUNE_RETAIN_DAYS}」`);
  }

  const sizeBefore = await rpc("get_database_size", {});
  console.log(`修剪前資料庫大小：${(sizeBefore / 1024 / 1024).toFixed(1)} MB`);
  console.log(`保留最近 ${RETAIN_DAYS} 天，每批 ${BATCH_SIZE} 筆`);

  let total = 0;
  for (let i = 1; i <= MAX_BATCHES; i++) {
    const deleted = await rpc("prune_chart_snapshots", { retain_days: RETAIN_DAYS, batch_size: BATCH_SIZE });
    if (typeof deleted !== "number") throw new Error(`prune_chart_snapshots 回傳了非預期的內容：${JSON.stringify(deleted)}`);
    if (deleted === 0) break;
    total += deleted;
    console.log(`  第 ${i} 批：刪除 ${deleted} 筆（累計 ${total} 筆）`);
    if (i === MAX_BATCHES) throw new Error(`已達安全上限 ${MAX_BATCHES} 批仍未刪完，請人工檢查`);
  }

  const sizeAfter = await rpc("get_database_size", {});
  console.log(`完成：共刪除 ${total} 筆。資料庫大小：${(sizeAfter / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
