// Yahoo Feed Quick View - polls 247wallst.com/feed/yahoo-feed and displays items

interface Env {
  FEED_KV: KVNamespace;
}

// Shape of a parsed feed item
interface FeedItem {
  guid: string;
  title: string;
  link: string;
  pubDate: string; // ISO string
  author: string;
  category: string;
  tickers: { symbol: string; exchange: string }[];
  firstSeen: string; // ISO string - when our poller first spotted it
}

const FEED_URL = "https://247wallst.com/feed/yahoo-feed";

// Parse the RSS XML and extract items
function parseFeed(xml: string): Omit<FeedItem, "firstSeen">[] {
  const items: Omit<FeedItem, "firstSeen">[] = [];

  // Split on <item> tags
  const itemBlocks = xml.split("<item>").slice(1);

  for (const block of itemBlocks) {
    const itemXml = block.split("</item>")[0];

    const guid = extractTag(itemXml, "guid") || "";
    const title = extractCdata(itemXml, "title") || extractTag(itemXml, "title") || "";
    const link = extractTag(itemXml, "link") || "";
    const pubDateRaw = extractTag(itemXml, "pubDate") || "";
    const author = extractCdata(itemXml, "dc:creator") || extractTag(itemXml, "dc:creator") || "";
    const category = extractCdata(itemXml, "category") || extractTag(itemXml, "category") || "";

    // Parse tickers from <Metadata> blocks
    const tickers: { symbol: string; exchange: string }[] = [];
    const metadataBlocks = itemXml.split("<Metadata>").slice(1);
    for (const meta of metadataBlocks) {
      const metaContent = meta.split("</Metadata>")[0];
      const tickerMatch = metaContent.match(/FormalName="Ticker Symbol"\s+Value="([^"]+)"/);
      const exchangeMatch = metaContent.match(/FormalName="Exchange"\s+Value="([^"]+)"/);
      if (tickerMatch) {
        tickers.push({
          symbol: tickerMatch[1],
          exchange: exchangeMatch ? exchangeMatch[1] : "",
        });
      }
    }

    // Convert pubDate to ISO
    const pubDate = pubDateRaw ? new Date(pubDateRaw).toISOString() : "";

    items.push({ guid, title, link, pubDate, author, category, tickers });
  }

  return items;
}

// Extract text content from a simple XML tag
function extractTag(xml: string, tag: string): string | null {
  // Handle self-closing or tags with attributes
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

// Extract CDATA content from a tag
function extractCdata(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

// Fetch feed, reconcile with KV for first-seen times, return items
async function fetchAndReconcile(env: Env): Promise<FeedItem[]> {
  const response = await fetch(FEED_URL, {
    headers: { "User-Agent": "YahooFeedQuickView/1.0" },
  });

  if (!response.ok) {
    throw new Error(`Feed fetch failed: ${response.status}`);
  }

  const xml = await response.text();
  const parsed = parseFeed(xml);
  const now = new Date().toISOString();

  // Reconcile with KV: check if we've seen each guid before
  const items: FeedItem[] = [];
  for (const item of parsed) {
    const kvKey = `seen:${item.guid}`;
    let firstSeen = await env.FEED_KV.get(kvKey);

    if (!firstSeen) {
      // New item, store current time as first-seen
      firstSeen = now;
      await env.FEED_KV.put(kvKey, firstSeen, { expirationTtl: 86400 * 3 }); // 3 day TTL
    }

    items.push({ ...item, firstSeen });
  }

  return items;
}

// HTML page with auto-polling JS
function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Yahoo Feed Quick View</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1117;
      color: #e1e4e8;
      padding: 20px;
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #21262d;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      color: #f0f6fc;
    }
    .status {
      font-size: 13px;
      color: #8b949e;
    }
    .status .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #3fb950;
      margin-right: 6px;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .count-badge {
      background: #21262d;
      color: #8b949e;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      margin-left: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      text-align: left;
      font-size: 11px;
      font-weight: 600;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 8px 12px;
      border-bottom: 1px solid #21262d;
      position: sticky;
      top: 0;
      background: #0f1117;
    }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid #161b22;
      font-size: 14px;
      vertical-align: top;
    }
    tr:hover {
      background: #161b22;
    }
    tr.new-item {
      animation: highlight 3s ease-out;
    }
    @keyframes highlight {
      0% { background: rgba(56, 139, 253, 0.15); }
      100% { background: transparent; }
    }
    a {
      color: #58a6ff;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    .ticker {
      display: inline-block;
      background: #1f2937;
      color: #60a5fa;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      font-family: monospace;
      margin: 1px 3px 1px 0;
    }
    .time {
      white-space: nowrap;
      font-size: 13px;
      color: #8b949e;
      font-variant-numeric: tabular-nums;
    }
    .time-label {
      font-size: 11px;
      color: #484f58;
      display: block;
    }
    .fresh {
      color: #3fb950;
    }
    .loading {
      text-align: center;
      padding: 60px 20px;
      color: #8b949e;
    }
    .error-msg {
      background: #3d1f28;
      color: #f85149;
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 16px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>247 Wall St Yahoo Feed <span class="count-badge" id="count">0 items</span></h1>
    </div>
    <div class="status">
      <span class="dot"></span>
      <span id="last-poll">Loading...</span>
    </div>
  </header>

  <div id="error"></div>
  <div id="content">
    <div class="loading">Fetching feed...</div>
  </div>

  <script>
    // Track known GUIDs so we can highlight new ones
    const knownGuids = new Set();
    let firstLoad = true;

    // Format ISO date to Eastern Time
    function toEastern(isoStr) {
      if (!isoStr) return "N/A";
      const d = new Date(isoStr);
      return d.toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      });
    }

    // How long ago in human terms
    function timeAgo(isoStr) {
      if (!isoStr) return "";
      const diff = Date.now() - new Date(isoStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return mins + "m ago";
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + "h " + (mins % 60) + "m ago";
      return Math.floor(hrs / 24) + "d ago";
    }

    async function poll() {
      try {
        const res = await fetch("/api/feed");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const items = await res.json();

        document.getElementById("error").innerHTML = "";
        document.getElementById("count").textContent = items.length + " items";
        document.getElementById("last-poll").textContent =
          "Last poll: " + toEastern(new Date().toISOString());

        // Find new items (not in our known set)
        const newGuids = new Set();
        if (!firstLoad) {
          for (const item of items) {
            if (!knownGuids.has(item.guid)) {
              newGuids.add(item.guid);
            }
          }
        }

        // Update known set
        for (const item of items) {
          knownGuids.add(item.guid);
        }
        firstLoad = false;

        // Render table
        let html = '<table><thead><tr>';
        html += '<th style="width:45%">Headline</th>';
        html += '<th style="width:15%">Tickers</th>';
        html += '<th style="width:20%">Published</th>';
        html += '<th style="width:20%">First Seen</th>';
        html += '</tr></thead><tbody>';

        for (const item of items) {
          const isNew = newGuids.has(item.guid);
          html += '<tr class="' + (isNew ? "new-item" : "") + '">';

          // Headline
          html += '<td><a href="' + escHtml(item.link) + '" target="_blank">'
            + escHtml(item.title) + '</a></td>';

          // Tickers
          html += '<td>';
          if (item.tickers && item.tickers.length > 0) {
            for (const t of item.tickers) {
              html += '<span class="ticker">' + escHtml(t.symbol) + '</span>';
            }
          } else {
            html += '<span style="color:#484f58">none</span>';
          }
          html += '</td>';

          // Published time
          html += '<td class="time">' + toEastern(item.pubDate)
            + '<span class="time-label">' + timeAgo(item.pubDate) + '</span></td>';

          // First seen
          const seenRecently = (Date.now() - new Date(item.firstSeen).getTime()) < 120000;
          html += '<td class="time' + (seenRecently ? ' fresh' : '') + '">'
            + toEastern(item.firstSeen)
            + '<span class="time-label">' + timeAgo(item.firstSeen) + '</span></td>';

          html += '</tr>';
        }

        html += '</tbody></table>';
        document.getElementById("content").innerHTML = html;

      } catch (err) {
        document.getElementById("error").innerHTML =
          '<div class="error-msg">Poll failed: ' + err.message + '</div>';
      }
    }

    function escHtml(s) {
      if (!s) return "";
      return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }

    // Initial fetch, then every 60 seconds
    poll();
    setInterval(poll, 60000);
  </script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      // API endpoint: fetch feed and return JSON
      if (url.pathname === "/api/feed") {
        const items = await fetchAndReconcile(env);
        return Response.json(items, {
          headers: { "Cache-Control": "no-store" },
        });
      }

      // Everything else: serve the viewer page
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
