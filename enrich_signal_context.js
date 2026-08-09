// 訊號引擎 - 背景資料補充
// 對每則還沒有背景說明的訊號，用 Claude（帶網路搜尋）查作品/藝人脈絡，寫進 context_blurb 欄位
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const MODEL = "claude-haiku-4-5-20251001";
const MAX_ITEMS_PER_RUN = 20; // 一次最多處理幾則，避免單次執行時間/花費失控

async function fetchSignalsNeedingContext() {
  const url = `${SUPABASE_URL}/rest/v1/chart_signals?select=id,signal_type,title,description,artist_name,track_name,metrics&context_blurb=is.null&order=created_at.desc&limit=${MAX_ITEMS_PER_RUN}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`讀取待補充訊號失敗：HTTP ${res.status}`);
  return res.json();
}

async function updateContextBlurb(id, blurb) {
  const url = `${SUPABASE_URL}/rest/v1/chart_signals?id=eq.${id}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ context_blurb: blurb }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`寫入 context_blurb 失敗：HTTP ${res.status} ${body.slice(0, 300)}`);
  }
}

// 這份 prompt 是照使用者提供、參考自 ChatGPT 建議的完整版判斷邏輯精簡而來：
// 保留「查證範圍寬、寫入標準窄」「不對知名藝人寫廢話、對冷門藝人補脈絡」「避免空泛形容詞」
// 這幾條核心原則，但把輸出砍到只剩最終一句話（原版的可用面向/不宜誇大/資料來源三段，
// 這裡用不到，卡片版面只有一行空間）
function buildPrompt(signal) {
  const groupLabel = signal.metrics?.group_label || "";
  const name = [signal.track_name, signal.artist_name].filter(Boolean).join(" — ") || signal.artist_name || signal.track_name || "";

  return `你是一位資深流行音樂產業記者，正在為榜單訊號撰寫一句話背景說明，給熟悉音樂產業的讀者看。

這不是樂評，也不是宣傳文案，而是解釋這則榜單訊號背後的脈絡：這首歌／這位藝人為什麼值得注意，它代表什麼市場動向、職涯位置、類型趨勢或產業現象。

讀者已經熟悉多數華語與歐美主流藝人，不需要基本介紹（例如「美國歌手」這種任何人都知道的資訊沒有價值，不要寫）。但對不熟悉的新進藝人、非台灣／非英美市場藝人，需要補上能幫助快速理解的背景。

請優先查詢「這首作品本身」的脈絡，而不只是「這個人是誰」：這次上榜代表什麼（新歌發行、回榜、短影音帶動、影視／戲劇連動、地區市場突破、remix／合作版本等）、是否有可驗證的其他榜單成績或重要媒體報導。查詢範圍可以寬（可以查詢多個來源），但最終只寫真正有助於理解這則榜單訊號的內容。

請避免：
- 空泛形容詞（震撼、療癒、洗腦、令人驚艷、直擊人心等）
- 對知名藝人重複寫「OO國歌手」這種基本資訊
- 資料不足時硬掰市場現象或誇大平台曝光，查不到具體脈絡就如實反映資訊有限，不要瞎猜

只輸出最終的一句話背景說明本身，控制在 40-70 字以內，不要任何前言、說明文字或引號，不要在句尾附註資料來源。如果實在查不到任何有意義的背景資訊，只回覆「NO_CONTEXT」四個字，不要輸出其他內容。

---
榜單訊號資訊：
類型：${signal.signal_type}
${groupLabel ? `榜單：${groupLabel}` : ""}
作品／藝人：${name}
說明：${signal.description || ""}`;
}

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API 失敗：HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
  return textBlocks.join("\n").trim();
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("找不到 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，先確認 .env 有填好。");
    process.exit(1);
  }
  if (!ANTHROPIC_API_KEY) {
    console.error("找不到 ANTHROPIC_API_KEY，先確認 .env 有填好。");
    process.exit(1);
  }

  console.log("查詢還沒有背景說明的訊號...");
  const signals = await fetchSignalsNeedingContext();
  console.log(`共 ${signals.length} 則需要補充`);

  let done = 0, skipped = 0, failed = 0;

  for (const signal of signals) {
    const name = [signal.track_name, signal.artist_name].filter(Boolean).join(" — ") || signal.artist_name || signal.track_name || "";
    console.log(`[查詢中] ${name}`);
    try {
      const prompt = buildPrompt(signal);
      const result = await callClaude(prompt);
      if (!result || result.includes("NO_CONTEXT")) {
        await updateContextBlurb(signal.id, "");
        skipped++;
        console.log(`  -> 查無有效背景，留空`);
      } else {
        await updateContextBlurb(signal.id, result);
        done++;
        console.log(`  -> ${result}`);
      }
    } catch (e) {
      failed++;
      console.warn(`[warn] ${name} 查詢失敗：${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`完成：${done} 則寫入背景說明，${skipped} 則查無資料留空，${failed} 則失敗`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
