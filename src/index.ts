// Feed Comparison Viewer - polls Yahoo + Robinhood feeds from 247wallst.com
// Matches articles across feeds by post ID to debug timing delays

interface Env {
  FEED_KV: KVNamespace;
}

// A parsed item from either feed
interface FeedItem {
  postId: string;       // extracted from guid (?p=XXXXX)
  guid: string;
  title: string;
  link: string;
  pubDate: string;      // ISO string
  author: string;
  tickers: string[];    // just symbols
}

// Combined article with data from both feeds
interface MergedArticle {
  postId: string;
  title: string;
  link: string;
  pubDate: string;
  author: string;
  tickers: string[];
  // Per-feed tracking: when our poller first saw it in each feed
  robinhoodFirstSeen: string | null;
  yahooFirstSeen: string | null;
}

const FEEDS = {
  robinhood: "https://247wallst.com/feed/?feed=fwp-robinhood-articles",
  yahoo: "https://247wallst.com/feed/yahoo-feed",
} as const;

// Extract post ID from guid like "https://247wallst.com/?p=1563629&preview=true..."
function extractPostId(guid: string): string {
  const match = guid.match(/[?&]p=(\d+)/);
  return match ? match[1] : guid;
}

// Parse Yahoo feed (uses <Metadata> blocks for tickers)
function parseYahooFeed(xml: string): FeedItem[] {
  return parseItems(xml, (itemXml) => {
    const tickers: string[] = [];
    const metadataBlocks = itemXml.split("<Metadata>").slice(1);
    for (const meta of metadataBlocks) {
      const metaContent = meta.split("</Metadata>")[0];
      const tickerMatch = metaContent.match(/FormalName="Ticker Symbol"\s+Value="([^"]+)"/);
      if (tickerMatch) tickers.push(tickerMatch[1]);
    }
    return tickers;
  });
}

// Parse Robinhood feed (uses <company:symbol> tags for tickers)
function parseRobinhoodFeed(xml: string): FeedItem[] {
  return parseItems(xml, (itemXml) => {
    const tickers: string[] = [];
    const regex = /<company:symbol>([^<]+)<\/company:symbol>/g;
    let match;
    while ((match = regex.exec(itemXml)) !== null) {
      tickers.push(match[1].trim());
    }
    return tickers;
  });
}

// Shared item parsing, with a pluggable ticker extractor
function parseItems(xml: string, extractTickers: (xml: string) => string[]): FeedItem[] {
  const items: FeedItem[] = [];
  const itemBlocks = xml.split("<item>").slice(1);

  for (const block of itemBlocks) {
    const itemXml = block.split("</item>")[0];

    const guid = extractTag(itemXml, "guid") || "";
    const postId = extractPostId(guid);
    const title = extractCdata(itemXml, "title") || extractTag(itemXml, "title") || "";
    const link = extractTag(itemXml, "link") || "";
    const pubDateRaw = extractTag(itemXml, "pubDate") || "";
    const author =
      extractCdata(itemXml, "dc:creator") ||
      extractTag(itemXml, "dc:creator") ||
      extractTag(itemXml, "author") ||
      "";

    const tickers = extractTickers(itemXml);
    const pubDate = pubDateRaw ? new Date(pubDateRaw).toISOString() : "";

    items.push({ postId, guid, title, link, pubDate, author, tickers });
  }

  return items;
}

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

function extractCdata(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

// Fetch both feeds, merge by post ID, track first-seen per feed in KV
async function fetchBothFeeds(env: Env): Promise<MergedArticle[]> {
  const [robinhoodRes, yahooRes] = await Promise.all([
    fetch(FEEDS.robinhood, { headers: { "User-Agent": "FeedCompare/1.0" } }),
    fetch(FEEDS.yahoo, { headers: { "User-Agent": "FeedCompare/1.0" } }),
  ]);

  if (!robinhoodRes.ok) throw new Error(`Robinhood feed failed: ${robinhoodRes.status}`);
  if (!yahooRes.ok) throw new Error(`Yahoo feed failed: ${yahooRes.status}`);

  const [robinhoodXml, yahooXml] = await Promise.all([
    robinhoodRes.text(),
    yahooRes.text(),
  ]);

  const robinhoodItems = parseRobinhoodFeed(robinhoodXml);
  const yahooItems = parseYahooFeed(yahooXml);
  const now = new Date().toISOString();

  // Index by postId
  const robinhoodMap = new Map<string, FeedItem>();
  for (const item of robinhoodItems) robinhoodMap.set(item.postId, item);

  const yahooMap = new Map<string, FeedItem>();
  for (const item of yahooItems) yahooMap.set(item.postId, item);

  // All unique post IDs across both feeds
  const allPostIds = new Set([...robinhoodMap.keys(), ...yahooMap.keys()]);

  const merged: MergedArticle[] = [];

  for (const postId of allPostIds) {
    const rh = robinhoodMap.get(postId);
    const yh = yahooMap.get(postId);

    // Use whichever feed has the article for title/link/etc
    const source = rh || yh!;

    // Check/store first-seen for each feed
    let robinhoodFirstSeen: string | null = null;
    let yahooFirstSeen: string | null = null;

    if (rh) {
      const key = `rh:${postId}`;
      robinhoodFirstSeen = await env.FEED_KV.get(key);
      if (!robinhoodFirstSeen) {
        robinhoodFirstSeen = now;
        await env.FEED_KV.put(key, now, { expirationTtl: 86400 * 3 });
      }
    }

    if (yh) {
      const key = `yh:${postId}`;
      yahooFirstSeen = await env.FEED_KV.get(key);
      if (!yahooFirstSeen) {
        yahooFirstSeen = now;
        await env.FEED_KV.put(key, now, { expirationTtl: 86400 * 3 });
      }
    }

    // Merge tickers from both feeds (dedupe)
    const tickers = [...new Set([...(rh?.tickers || []), ...(yh?.tickers || [])])];

    merged.push({
      postId,
      title: source.title,
      link: source.link,
      pubDate: source.pubDate,
      author: source.author,
      tickers,
      robinhoodFirstSeen,
      yahooFirstSeen,
    });
  }

  // Sort by pubDate descending (newest first)
  merged.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

  return merged;
}

function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Feed Comparison Viewer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1117;
      color: #e1e4e8;
      padding: 20px;
      max-width: 1400px;
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid #21262d;
    }
    h1 { font-size: 20px; font-weight: 600; color: #f0f6fc; }
    .status { font-size: 13px; color: #8b949e; }
    .status .dot {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      background: #3fb950; margin-right: 6px; animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

    /* Summary stats bar */
    .stats {
      display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap;
    }
    .stat-card {
      background: #161b22; border: 1px solid #21262d; border-radius: 8px;
      padding: 12px 18px; min-width: 140px;
    }
    .stat-card .label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-card .value { font-size: 22px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .stat-card .value.green { color: #3fb950; }
    .stat-card .value.yellow { color: #d29922; }
    .stat-card .value.red { color: #f85149; }
    .stat-card .value.blue { color: #58a6ff; }

    /* Filter tabs */
    .filters {
      display: flex; gap: 8px; margin-bottom: 16px;
    }
    .filter-btn {
      background: #161b22; border: 1px solid #21262d; color: #8b949e;
      padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;
      transition: all 0.15s;
    }
    .filter-btn:hover { border-color: #388bfd; color: #e1e4e8; }
    .filter-btn.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }

    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left; font-size: 11px; font-weight: 600; color: #8b949e;
      text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 10px;
      border-bottom: 1px solid #21262d; position: sticky; top: 0; background: #0f1117;
      z-index: 1;
    }
    td {
      padding: 8px 10px; border-bottom: 1px solid #161b22;
      font-size: 13px; vertical-align: top;
    }
    tr:hover { background: #161b22; }
    tr.new-item { animation: highlight 3s ease-out; }
    @keyframes highlight { 0%{background:rgba(56,139,253,0.15)} 100%{background:transparent} }

    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }

    .ticker {
      display: inline-block; background: #1f2937; color: #60a5fa;
      padding: 2px 6px; border-radius: 4px; font-size: 11px;
      font-weight: 600; font-family: monospace; margin: 1px 2px 1px 0;
    }
    .time { white-space: nowrap; font-size: 12px; color: #8b949e; font-variant-numeric: tabular-nums; }
    .time-label { font-size: 10px; color: #484f58; display: block; }

    /* Feed presence badges */
    .feed-badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 11px; font-weight: 600; margin-right: 4px;
    }
    .badge-rh { background: #1a2e1a; color: #3fb950; }
    .badge-yh { background: #1a1e2e; color: #a371f7; }
    .badge-missing { background: #2d1a1a; color: #f85149; font-weight: 400; }

    /* Delay column */
    .delay { font-weight: 700; font-variant-numeric: tabular-nums; font-size: 13px; }
    .delay.waiting { color: #d29922; }
    .delay.arrived { color: #3fb950; }
    .delay.only-yahoo { color: #a371f7; }

    .loading { text-align: center; padding: 60px 20px; color: #8b949e; }
    .error-msg {
      background: #3d1f28; color: #f85149; padding: 12px 16px;
      border-radius: 8px; margin-bottom: 16px; font-size: 13px;
    }
  </style>
</head>
<body>
  <header>
    <h1>247 Wall St Feed Comparison</h1>
    <div class="status">
      <span class="dot"></span>
      <span id="last-poll">Loading...</span>
    </div>
  </header>

  <div id="stats" class="stats"></div>
  <div class="filters">
    <button class="filter-btn active" data-filter="all">All</button>
    <button class="filter-btn" data-filter="both">In Both</button>
    <button class="filter-btn" data-filter="rh-only">Robinhood Only</button>
    <button class="filter-btn" data-filter="yh-only">Yahoo Only</button>
    <button class="filter-btn" data-filter="waiting">Waiting for Yahoo</button>
  </div>

  <div id="error"></div>
  <div id="content"><div class="loading">Fetching both feeds...</div></div>

  <script>
    const knownPostIds = new Set();
    let firstLoad = true;
    let currentFilter = "all";
    let lastData = [];

    // Format ISO to Eastern
    function toET(iso) {
      if (!iso) return "";
      return new Date(iso).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
      });
    }

    function timeAgo(iso) {
      if (!iso) return "";
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return mins + "m ago";
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + "h " + (mins % 60) + "m ago";
      return Math.floor(hrs / 24) + "d ago";
    }

    // Compute delay between two ISO timestamps in minutes
    function delayMins(earlier, later) {
      if (!earlier || !later) return null;
      return Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / 60000);
    }

    function formatDelay(mins) {
      if (mins === null) return "";
      if (mins < 0) return Math.abs(mins) + "m earlier";
      if (mins < 60) return mins + "m";
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h + "h " + m + "m";
    }

    function escHtml(s) {
      if (!s) return "";
      return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }

    function classify(item) {
      const hasRh = !!item.robinhoodFirstSeen;
      const hasYh = !!item.yahooFirstSeen;
      if (hasRh && hasYh) return "both";
      if (hasRh && !hasYh) return "rh-only";
      return "yh-only";
    }

    function renderStats(items) {
      const total = items.length;
      const inBoth = items.filter(i => i.robinhoodFirstSeen && i.yahooFirstSeen).length;
      const rhOnly = items.filter(i => i.robinhoodFirstSeen && !i.yahooFirstSeen).length;
      const yhOnly = items.filter(i => !i.robinhoodFirstSeen && i.yahooFirstSeen).length;

      // Average delay for items in both feeds (RH first-seen to YH first-seen)
      let delays = [];
      for (const i of items) {
        if (i.robinhoodFirstSeen && i.yahooFirstSeen) {
          delays.push(delayMins(i.robinhoodFirstSeen, i.yahooFirstSeen));
        }
      }
      const avgDelay = delays.length > 0
        ? Math.round(delays.reduce((a,b) => a+b, 0) / delays.length)
        : null;

      let html = '';
      html += '<div class="stat-card"><div class="label">Total Articles</div><div class="value blue">' + total + '</div></div>';
      html += '<div class="stat-card"><div class="label">In Both Feeds</div><div class="value green">' + inBoth + '</div></div>';
      html += '<div class="stat-card"><div class="label">Robinhood Only</div><div class="value yellow">' + rhOnly + '</div></div>';
      html += '<div class="stat-card"><div class="label">Yahoo Only</div><div class="value">' + yhOnly + '</div></div>';
      html += '<div class="stat-card"><div class="label">Avg Yahoo Delay</div><div class="value red">'
        + (avgDelay !== null ? formatDelay(avgDelay) : "N/A") + '</div></div>';
      document.getElementById("stats").innerHTML = html;
    }

    function renderTable(items) {
      // Apply filter
      let filtered = items;
      if (currentFilter === "both") filtered = items.filter(i => i.robinhoodFirstSeen && i.yahooFirstSeen);
      else if (currentFilter === "rh-only") filtered = items.filter(i => i.robinhoodFirstSeen && !i.yahooFirstSeen);
      else if (currentFilter === "yh-only") filtered = items.filter(i => !i.robinhoodFirstSeen && i.yahooFirstSeen);
      else if (currentFilter === "waiting") filtered = items.filter(i => i.robinhoodFirstSeen && !i.yahooFirstSeen);

      const newPostIds = new Set();
      if (!firstLoad) {
        for (const item of items) {
          if (!knownPostIds.has(item.postId)) newPostIds.add(item.postId);
        }
      }
      for (const item of items) knownPostIds.add(item.postId);
      firstLoad = false;

      let html = '<table><thead><tr>';
      html += '<th style="width:30%">Headline</th>';
      html += '<th style="width:10%">Tickers</th>';
      html += '<th style="width:12%">Published</th>';
      html += '<th style="width:8%">Feeds</th>';
      html += '<th style="width:14%">RH First Seen</th>';
      html += '<th style="width:14%">Yahoo First Seen</th>';
      html += '<th style="width:12%">Yahoo Delay</th>';
      html += '</tr></thead><tbody>';

      for (const item of filtered) {
        const isNew = newPostIds.has(item.postId);
        const cat = classify(item);
        html += '<tr class="' + (isNew ? "new-item" : "") + '">';

        // Headline
        html += '<td><a href="' + escHtml(item.link) + '" target="_blank">'
          + escHtml(item.title) + '</a></td>';

        // Tickers
        html += '<td>';
        if (item.tickers.length > 0) {
          for (const t of item.tickers) html += '<span class="ticker">' + escHtml(t) + '</span>';
        } else {
          html += '<span style="color:#484f58">-</span>';
        }
        html += '</td>';

        // Published
        html += '<td class="time">' + toET(item.pubDate)
          + '<span class="time-label">' + timeAgo(item.pubDate) + '</span></td>';

        // Feed badges
        html += '<td>';
        if (item.robinhoodFirstSeen) html += '<span class="feed-badge badge-rh">RH</span>';
        if (item.yahooFirstSeen) html += '<span class="feed-badge badge-yh">YH</span>';
        html += '</td>';

        // RH first seen
        html += '<td class="time">';
        if (item.robinhoodFirstSeen) {
          html += toET(item.robinhoodFirstSeen)
            + '<span class="time-label">' + timeAgo(item.robinhoodFirstSeen) + '</span>';
        } else {
          html += '<span class="feed-badge badge-missing">not in feed</span>';
        }
        html += '</td>';

        // Yahoo first seen
        html += '<td class="time">';
        if (item.yahooFirstSeen) {
          html += toET(item.yahooFirstSeen)
            + '<span class="time-label">' + timeAgo(item.yahooFirstSeen) + '</span>';
        } else {
          html += '<span class="feed-badge badge-missing">not yet</span>';
        }
        html += '</td>';

        // Delay column
        html += '<td>';
        if (item.robinhoodFirstSeen && item.yahooFirstSeen) {
          const d = delayMins(item.robinhoodFirstSeen, item.yahooFirstSeen);
          html += '<span class="delay arrived">+' + formatDelay(d) + '</span>';
        } else if (item.robinhoodFirstSeen && !item.yahooFirstSeen) {
          // Still waiting, show how long since RH first seen
          const waiting = delayMins(item.robinhoodFirstSeen, new Date().toISOString());
          html += '<span class="delay waiting">waiting ' + formatDelay(waiting) + '</span>';
        } else if (!item.robinhoodFirstSeen && item.yahooFirstSeen) {
          html += '<span class="delay only-yahoo">YH only</span>';
        }
        html += '</td>';

        html += '</tr>';
      }

      html += '</tbody></table>';
      document.getElementById("content").innerHTML = html;
    }

    async function poll() {
      try {
        const res = await fetch("/api/feeds");
        if (!res.ok) throw new Error("HTTP " + res.status);
        lastData = await res.json();

        document.getElementById("error").innerHTML = "";
        document.getElementById("last-poll").textContent =
          "Last poll: " + toET(new Date().toISOString());

        renderStats(lastData);
        renderTable(lastData);
      } catch (err) {
        document.getElementById("error").innerHTML =
          '<div class="error-msg">Poll failed: ' + err.message + '</div>';
      }
    }

    // Filter buttons
    document.querySelectorAll(".filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentFilter = btn.dataset.filter;
        if (lastData.length) renderTable(lastData);
      });
    });

    poll();
    setInterval(poll, 60000);
  </script>
</body>
</html>`;
}

// Basic auth check - returns 401 if invalid
function checkAuth(request: Request): Response | null {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Basic ")) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Feed Viewer"' },
    });
  }
  const decoded = atob(auth.slice(6));
  const [user, pass] = decoded.split(":");
  if (user !== "dog" || pass !== "dog") {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Feed Viewer"' },
    });
  }
  return null; // auth OK
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Check basic auth on every request
    const authFail = checkAuth(request);
    if (authFail) return authFail;

    try {
      // New combined endpoint
      if (url.pathname === "/api/feeds") {
        const items = await fetchBothFeeds(env);
        return Response.json(items, {
          headers: { "Cache-Control": "no-store" },
        });
      }

      // Serve viewer
      return new Response(renderPage(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });

    } catch (err) {
      console.error("Handler failed:", err);
      return Response.json(
        { error: "Internal error", code: "INTERNAL_ERROR" },
        { status: 500 }
      );
    }
  },
} satisfies ExportedHandler<Env>;
