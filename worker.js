/*
 * BSE RSS READER
 * V4 - Improved BSE Corporate Announcement Categories
 *       + Watchlist Alerts / Special Bundle + Push Notifications via Telegram Bot & ntfy
 *
 * KV binding: BSE_DATA
 * Secrets required in Cloudflare Worker:
 *   - TELEGRAM_BOT_TOKEN
 *   - TELEGRAM_CHAT_ID
 *   - NTFY_TOPIC
 */

const FINANCIAL_RESULTS_URL =
  "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml";

const CORPORATE_ANNOUNCEMENTS_URL =
  "https://beta.bseindia.com/data/xml/announcements.xml";

const MAX_SEEN = 10000;
const MAX_ALERTS = 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/* ============================================================
   HELPERS & UTILS
   ============================================================ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function normalizeBseLink(rawLink) {
  var clean = String(rawLink || "").trim();
  if (!clean) return "https://www.bseindia.com";

  if (clean.indexOf("AttachLive") !== -1 || clean.indexOf("AttachHis") !== -1) {
    var fileName = clean.split("/").pop();
    if (fileName) {
      return "https://www.bseindia.com/xml-data/corpfiling/AttachLive/" + fileName;
    }
  }

  if (clean.indexOf("http") !== 0) {
    if (clean.indexOf("/") === 0) {
      return "https://www.bseindia.com" + clean;
    }
    return "https://www.bseindia.com/" + clean;
  }

  return clean;
}

function escapeTelegramHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegramAlert(title, body, scrip, link, fetchedAt, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("Telegram credentials missing in Worker environment variables.");
    return;
  }

  var pdfLink = normalizeBseLink(link);
  var targetLink = (pdfLink && pdfLink !== "https://www.bseindia.com")
    ? pdfLink
    : (scrip ? "https://www.bseindia.com/stock-share-price/" + scrip : "https://www.bseindia.com");

  const cleanTitle = escapeTelegramHtml(title);
  const cleanBody = escapeTelegramHtml(body);
  const formattedFetchTime = fetchedAt ? new Date(fetchedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : "N/A";

  const messageText = `🚨 <b>${cleanTitle}</b>\n\n${cleanBody}\n\n⚡ <b>Fetched:</b> ${formattedFetchTime}\n🔗 <a href="${targetLink}">View Attachment / Details</a>`;

  try {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: messageText,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });
  } catch (err) {
    console.error("Failed to send Telegram alert:", err);
  }
}

async function sendNtfyAlert(title, body, scrip, link, fetchedAt, env) {
  if (!env.NTFY_TOPIC) {
    console.error("NTFY_TOPIC missing in Worker environment variables.");
    return;
  }

  var pdfLink = normalizeBseLink(link);
  var targetLink = (pdfLink && pdfLink !== "https://www.bseindia.com")
    ? pdfLink
    : (scrip ? "https://www.bseindia.com/stock-share-price/" + scrip : "https://www.bseindia.com");

  const formattedFetchTime = fetchedAt ? new Date(fetchedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : "N/A";
  const messageBody = `${body}\nFetched: ${formattedFetchTime}`;

  try {
    const url = `https://ntfy.sh/${env.NTFY_TOPIC}`;
    await fetch(url, {
      method: "POST",
      headers: {
        "Title": title,
        "Click": targetLink,
        "Tags": "chart_with_upwards_trend,warning"
      },
      body: messageBody
    });
  } catch (err) {
    console.error("Failed to send ntfy alert:", err);
  }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function stripHtml(value) {
  return decodeHtml(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlTag(xml, tag) {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(regex);
  return match ? stripHtml(match[1]) : "";
}

async function fetchXML(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; BSE-RSS-Reader/4.0)",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
      "Cache-Control": "no-cache",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!response.ok) {
    throw new Error(`BSE feed HTTP ${response.status}`);
  }
  return await response.text();
}

/* ============================================================
   CLASSIFICATION RULES
   ============================================================ */

const CATEGORY_RULES = [
  {
    name: "Financial Results",
    words: [
      "financial results", "financial result", "unaudited financial results",
      "audited financial results", "quarterly results", "quarterly result",
      "results for the quarter", "standalone financial results", "consolidated financial results"
    ],
  },
  {
    name: "Board Meeting",
    words: ["board meeting", "meeting of the board", "outcome of board meeting"],
  },
  {
    name: "Dividend",
    words: ["dividend", "interim dividend", "final dividend", "special dividend"],
  },
  {
    name: "Bonus",
    words: ["bonus issue", "bonus shares", "issue of bonus shares"],
  },
  {
    name: "Fund Raising",
    words: ["fund raising", "fundraising", "qip", "private placement", "preferential issue"],
  },
  {
    name: "Acquisition",
    words: ["acquisition", "acquire", "acquired", "takeover"],
  },
  {
    name: "Order / Contract",
    words: ["order received", "order win", "work order", "contract awarded"],
  },
  {
    name: "Credit Rating",
    words: ["credit rating", "rating reaffirmed", "rating upgrade", "rating downgrade"],
  },
  {
    name: "Appointment / Resignation",
    words: ["appointment", "resignation", "cessation", "change in management"],
  }
];

function classifyAnnouncement(title, description) {
  const text = `${title || ""} ${description || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
  const categories = [];

  for (const rule of CATEGORY_RULES) {
    if (rule.words.some(word => text.includes(word))) {
      categories.push(rule.name);
    }
  }

  if (categories.length === 0) categories.push("Other");
  const isFinancialResult = categories.includes("Financial Results");

  return { category: categories[0], categories, isFinancialResult };
}

/* ============================================================
   PARSERS
   ============================================================ */

function parseFinancialResults(xml, fetchedAt) {
  const items = [];
  const matches = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  for (const itemXML of matches) {
    const title = xmlTag(itemXML, "title");
    const rawLink = xmlTag(itemXML, "link");
    const link = normalizeBseLink(rawLink);
    const description = xmlTag(itemXML, "description");
    const pubDate = xmlTag(itemXML, "pubDate") || new Date().toUTCString();

    if (!title) continue;

    let company = title;
    let scrip = "";

    const titleMatch = title.match(/^(.*?)\s*\((\d+)\)\s*$/);
    if (titleMatch) {
      company = titleMatch[1].trim();
      scrip = titleMatch[2].trim();
    }

    const stableId = link || `${title}|${description}`;

    items.push({
      feed: "Financial Results",
      company,
      scrip,
      category: "Financial Results",
      categories: ["Financial Results"],
      isFinancialResult: true,
      title,
      link,
      description,
      pubDate,
      fetchedAt,
      guid: stableId,
      id: stableId,
    });
  }

  return items;
}

function parseCorporateAnnouncements(xml, fetchedAt) {
  const items = [];
  const matches = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  for (const itemXML of matches) {
    const title = xmlTag(itemXML, "title");
    const rawLink = xmlTag(itemXML, "link");
    const link = normalizeBseLink(rawLink);
    const description = xmlTag(itemXML, "description");
    const pubDate = xmlTag(itemXML, "pubDate") || new Date().toUTCString();
    const guid = xmlTag(itemXML, "guid");

    if (!title && !description) continue;

    let company = "";
    let scrip = "";

    const titleMatch = title.match(/^(.*?)\s*\((\d{6})\)/);
    if (titleMatch) {
      company = titleMatch[1].trim();
      scrip = titleMatch[2].trim();
    }

    if (!scrip) {
      const scripMatch = `${title} ${description}`.match(/\b(\d{6})\b/);
      if (scripMatch) scrip = scripMatch[1];
    }

    const classification = classifyAnnouncement(title, description);
    const stableId = guid || link || `${title}|${description}|${pubDate}`;

    items.push({
      feed: "Corporate Announcements",
      company: company || "Unknown Company",
      scrip,
      category: classification.category,
      categories: classification.categories,
      isFinancialResult: classification.isFinancialResult,
      title,
      link,
      description,
      pubDate,
      fetchedAt,
      guid: stableId,
      id: stableId,
    });
  }

  return items;
}

/* ============================================================
   KV STORAGE OPERATIONS
   ============================================================ */

async function getWatchlist(env) {
  if (!env.BSE_DATA) return [];
  const data = await env.BSE_DATA.get("watchlist", "json");
  return Array.isArray(data) ? data : [];
}

async function setWatchlist(env, watchlist) {
  if (!env.BSE_DATA) throw new Error("BSE_DATA KV is not bound.");
  await env.BSE_DATA.put("watchlist", JSON.stringify(watchlist));
}

async function getNotificationSettings(env) {
  if (!env.BSE_DATA) return { telegram: true, ntfy: true };
  const data = await env.BSE_DATA.get("notificationSettings", "json");
  return data || { telegram: true, ntfy: true };
}

async function setNotificationSettings(env, settings) {
  if (!env.BSE_DATA) throw new Error("BSE_DATA KV is not bound.");
  await env.BSE_DATA.put("notificationSettings", JSON.stringify(settings));
}

async function getSeen(env) {
  if (!env.BSE_DATA) return [];
  const data = await env.BSE_DATA.get("announcementSeen", "json");
  return Array.isArray(data) ? data : [];
}

async function saveSeen(env, ids) {
  if (!env.BSE_DATA) return;
  await env.BSE_DATA.put("announcementSeen", JSON.stringify(ids.slice(0, MAX_SEEN)));
}

async function getAlerts(env) {
  if (!env.BSE_DATA) return [];
  const data = await env.BSE_DATA.get("specialAlerts", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlerts(env, alerts) {
  if (!env.BSE_DATA) return;
  await env.BSE_DATA.put("specialAlerts", JSON.stringify(alerts.slice(0, MAX_ALERTS)));
}

async function getTimestampMap(env) {
  if (!env.BSE_DATA) return {};
  const data = await env.BSE_DATA.get("announcementTimestamps", "json");
  return data || {};
}

async function saveTimestampMap(env, map) {
  if (!env.BSE_DATA) return;
  const keys = Object.keys(map);
  if (keys.length > 5000) {
    const trimmedMap = {};
    keys.slice(keys.length - 5000).forEach(k => {
      trimmedMap[k] = map[k];
    });
    await env.BSE_DATA.put("announcementTimestamps", JSON.stringify(trimmedMap));
  } else {
    await env.BSE_DATA.put("announcementTimestamps", JSON.stringify(map));
  }
}

async function attachPersistentTimestamps(items, env) {
  const map = await getTimestampMap(env);
  const now = new Date().toISOString();
  let updated = false;

  const results = items.map(item => {
    if (map[item.id]) {
      return { ...item, fetchedAt: map[item.id] };
    } else {
      map[item.id] = now;
      updated = true;
      return { ...item, fetchedAt: now };
    }
  });

  if (updated) {
    await saveTimestampMap(env, map);
  }

  return results;
}

/* ============================================================
   HYBRID MATCHING ENGINE
   ============================================================ */

function matchesWatchlist(item, watchlist) {
  if (!Array.isArray(watchlist) || watchlist.length === 0) return false;

  const itemScripRaw = String(item.scrip || "");
  const itemScripMatch = itemScripRaw.match(/\b(\d{6})\b/);
  const itemScrip = itemScripMatch ? itemScripMatch[1] : itemScripRaw.trim();

  const itemCompany = String(item.company || "").toLowerCase().trim();

  return watchlist.some(watch => {
    const watchScripRaw = String(watch.scrip || "");
    const watchScripMatch = watchScripRaw.match(/\b(\d{6})\b/);
    const watchScrip = watchScripMatch ? watchScripMatch[1] : watchScripRaw.trim();

    if (watchScrip && itemScrip && watchScrip === itemScrip) {
      return true;
    }

    const watchNameRaw = String(watch.name || "");
    const watchNameScripMatch = watchNameRaw.match(/\b(\d{6})\b/);
    if (watchNameScripMatch && itemScrip && watchNameScripMatch[1] === itemScrip) {
      return true;
    }

    const watchName = watchNameRaw.toLowerCase().trim();

    if (watchName && watchName.length >= 3 && itemCompany) {
      if (itemCompany.includes(watchName)) {
        return true;
      }
    }

    return false;
  });
}

/* ============================================================
   MONITOR CRON WORKER
   ============================================================ */

async function monitorFeeds(env) {
  const fetchedAt = new Date().toISOString();
  const [finResRaw, corpAnnRaw] = await Promise.all([
    fetchXML(FINANCIAL_RESULTS_URL).then(xml => parseFinancialResults(xml, fetchedAt)).catch(() => []),
    fetchXML(CORPORATE_ANNOUNCEMENTS_URL).then(xml => parseCorporateAnnouncements(xml, fetchedAt)).catch(() => []),
  ]);

  const rawItems = [...finResRaw, ...corpAnnRaw];
  const items = await attachPersistentTimestamps(rawItems, env);
  const watchlist = await getWatchlist(env);
  const settings = await getNotificationSettings(env);
  const seen = await getSeen(env);
  const alerts = await getAlerts(env);

  if (seen.length === 0) {
    const ids = items.map(item => item.id).filter(Boolean);
    await saveSeen(env, ids);
    return { status: "initialized baseline", count: items.length };
  }

  const seenSet = new Set(seen);
  const newItems = items.filter(item => item.id && !seenSet.has(item.id));
  let newAlertCount = 0;

  for (const item of newItems) {
    if (matchesWatchlist(item, watchlist)) {
      if (!alerts.some(a => a.id === item.id)) {

        // Send Telegram notification if enabled
        if (settings.telegram !== false) {
          await sendTelegramAlert(
            `${item.company || "Whitelisted Scrip"} (${item.scrip || ""})`,
            item.title || "New Announcement",
            item.scrip,
            item.link,
            item.fetchedAt,
            env
          );
        }

        // Send ntfy notification if enabled
        if (settings.ntfy !== false) {
          await sendNtfyAlert(
            `${item.company || "Whitelisted Scrip"} (${item.scrip || ""})`,
            item.title || "New Announcement",
            item.scrip,
            item.link,
            item.fetchedAt,
            env
          );
        }

        alerts.unshift({
          ...item,
          alert: true,
          alertCreatedAt: new Date().toISOString(),
        });
        newAlertCount++;
      }
    }
  }

  const updatedSeen = Array.from(new Set([...newItems.map(i => i.id), ...seen])).slice(0, MAX_SEEN);
  await saveSeen(env, updatedSeen);
  await saveAlerts(env, alerts);

  return { ok: true, newAnnouncements: newItems.length, newAlerts: newAlertCount };
}

/* ============================================================
   ROUTER & EXPORTS
   ============================================================ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      if (url.pathname === "/") return json({ status: "running", app: "BSE RSS Reader" });

      if (url.pathname === "/bse-announcements") {
        const fetchedAt = new Date().toISOString();
        const xml = await fetchXML(CORPORATE_ANNOUNCEMENTS_URL);
        const rawItems = parseCorporateAnnouncements(xml, fetchedAt);
        const items = await attachPersistentTimestamps(rawItems, env);
        return json({ ok: true, count: items.length, items });
      }

      if (url.pathname === "/categories") {
        const fetchedAt = new Date().toISOString();
        const xml = await fetchXML(CORPORATE_ANNOUNCEMENTS_URL);
        const rawItems = parseCorporateAnnouncements(xml, fetchedAt);
        const items = await attachPersistentTimestamps(rawItems, env);
        const map = new Map();
        items.forEach(i => i.categories.forEach(c => map.set(c, (map.get(c) || 0) + 1)));
        const categories = Array.from(map.entries()).map(([name, count]) => ({ name, count }));
        return json({ ok: true, categories });
      }

      if (url.pathname === "/watchlist") {
        if (request.method === "GET") return json({ ok: true, watchlist: await getWatchlist(env) });
        if (request.method === "POST") {
          const body = await request.json();
          await setWatchlist(env, body.watchlist || []);
          return json({ ok: true, watchlist: body.watchlist });
        }
      }

      if (url.pathname === "/notification-settings") {
        if (request.method === "GET") {
          return json({ ok: true, settings: await getNotificationSettings(env) });
        }
        if (request.method === "POST") {
          const body = await request.json();
          await setNotificationSettings(env, body);
          return json({ ok: true, settings: body });
        }
      }

      if (url.pathname === "/alerts") {
        return json({ ok: true, items: await getAlerts(env) });
      }

      if (url.pathname === "/monitor") {
        const res = await monitorFeeds(env);
        return json(res);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(monitorFeeds(env));
  },
};