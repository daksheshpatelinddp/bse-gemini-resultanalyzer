/*
 * BSE GEMINI RESULT ANALYZER (BASIC)
 *
 * KV Binding: BSE_GEMINI_DATA
 * Worker Secrets Required (Add in Cloudflare Dashboard):
 *   - TELEGRAM_BOT_TOKEN
 *   - TELEGRAM_CHAT_ID
 *   - NTFY_TOPIC
 *   - GEMINI_API_KEY
 */

const FINANCIAL_RESULTS_URL = "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml";
const CORPORATE_ANNOUNCEMENTS_URL = "https://beta.bseindia.com/data/xml/announcements.xml";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/* ============================================================
   GEMINI AI ANALYSIS
   ============================================================ */

async function analyzeFinancialPdf(pdfUrl, env) {
  if (!env.GEMINI_API_KEY) return null;

  try {
    const pdfResponse = await fetch(pdfUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (!pdfResponse.ok) return null;

    const arrayBuffer = await pdfResponse.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(arrayBuffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Pdf = btoa(binary);

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    const prompt = `Analyze this BSE financial result PDF attachment. Extract and provide a clear, concise bullet-point summary in simple text format containing:
- Period (e.g. Standalone / Consolidated)
- Total Revenue from Operations (YoY & QoQ % change if mentioned)
- Net Profit / Loss after Tax (YoY & QoQ % change if mentioned)
- Operating Profit / EBITDA & Margins
- Key Highlights / Exceptional items (if any, max 3 bullet points)

Keep output under 180 words, mobile readable.`;

    const aiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "application/pdf", data: base64Pdf } }
          ]
        }]
      }),
    });

    if (!aiRes.ok) return null;
    const resultData = await aiRes.json();
    return resultData?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    console.error("PDF Analysis Error:", err);
    return null;
  }
}

/* ============================================================
   TELEGRAM & NOTIFICATION HELPERS
   ============================================================ */

async function sendTelegramAlert(title, scrip, link, fetchedAt, aiSummary, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const formattedTime = fetchedAt ? new Date(fetchedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : "N/A";
  let message = ` <b>${title}</b>\n <b>Fetched:</b> ${formattedTime}`;

  if (aiSummary) {
    message += `\n\n <b>AI Financial Analysis:</b>\n${aiSummary}`;
  }

  message += `\n\n <a href="${link}">View Filing PDF</a>`;

  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML"
      }),
    });
  } catch (err) {
    console.error("Telegram Alert Failed:", err);
  }
}

/* ============================================================
   FEED PARSER & MONITOR
   ============================================================ */

async function fetchXML(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (BSE-Gemini-Analyzer/1.0)" }
  });
  return await res.text();
}

function parseItems(xml) {
  const items = [];
  const matches = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  for (const itemXML of matches) {
    const titleMatch = itemXML.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = itemXML.match(/<link>([\s\S]*?)<\/link>/i);

    const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
    const link = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";

    if (title && link) {
      items.push({ id: link, title, link });
    }
  }
  return items;
}

async function monitorFeeds(env) {
  const xml = await fetchXML(FINANCIAL_RESULTS_URL);
  const items = parseItems(xml);
  const fetchedAt = new Date().toISOString();

  // Get seen array from KV
  const seenRaw = await env.BSE_GEMINI_DATA.get("seen", "json");
  const seen = Array.isArray(seenRaw) ? seenRaw : [];

  if (seen.length === 0) {
    await env.BSE_GEMINI_DATA.put("seen", JSON.stringify(items.map(i => i.id)));
    return { status: "initialized", count: items.length };
  }

  const seenSet = new Set(seen);
  const newItems = items.filter(i => !seenSet.has(i.id));

  for (const item of newItems) {
    const fullText = item.title.toLowerCase();
    const isActualResult = (fullText.includes("financial result") || fullText.includes("quarterly result")) &&
                           !fullText.includes("newspaper") && !fullText.includes("publication");

    let aiSummary = null;
    if (isActualResult && item.link.toLowerCase().includes(".pdf")) {
      aiSummary = await analyzeFinancialPdf(item.link, env);
    }

    if (isActualResult) {
      await sendTelegramAlert(item.title, "", item.link, fetchedAt, aiSummary, env);
    }
  }

  const updatedSeen = Array.from(new Set([...newItems.map(i => i.id), ...seen])).slice(0, 5000);
  await env.BSE_GEMINI_DATA.put("seen", JSON.stringify(updatedSeen));

  return { status: "success", newAlerts: newItems.length };
}

/* ============================================================
   EXPORTS & CRON
   ============================================================ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    if (url.pathname === "/") {
      return new Response(JSON.stringify({ app: "BSE Gemini Analyzer", status: "running" }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    if (url.pathname === "/monitor") {
      const result = await monitorFeeds(env);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(monitorFeeds(env));
  }
};