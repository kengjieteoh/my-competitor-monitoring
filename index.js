// ─── Klook MY Competitor Monitor ─────────────────────────────────────────────
const nodemailer = require("nodemailer");
const cheerio    = require("cheerio");
const { chromium } = require("playwright");

const CONFIG = {
  groqKey:     process.env.GROQ_API_KEY,
  larkWebhook: process.env.LARK_WEBHOOK_URL,
  gmailUser:   process.env.GMAIL_USER,
  gmailPass:   process.env.GMAIL_APP_PASSWORD,
  recipient:   process.env.RECIPIENT_EMAIL || "kengjie.teoh@klook.com",
  groqModel:   "llama-3.3-70b-versatile",
  competitors: {
    traveloka: {
      urls: [
        "https://www.traveloka.com/en-my/promotion",
        "https://www.traveloka.com/en-my/promotion/l/special-campaigns",
        "https://www.traveloka.com/en-my/promotion/l/flights",
        "https://www.traveloka.com/en-my/promotion/l/hotel",
        "https://www.traveloka.com/en-my/promotion/l/things-to-do",
      ],
      useBrowser: false,
    },
    tripcom: {
      urls: [
        "https://my.trip.com/?locale=en-my",
        "https://my.trip.com/sale/w/19280/gochina.html?locale=en-MY",
        "https://my.trip.com/sale/w/24663/superlokal.html?locale=en-my",
      ],
      useBrowser: false,
    },
    kkday: {
      urls: [
        "https://www.kkday.com/en-my",
        "https://www.kkday.com/en-my/hot-campaigns",
      ],
      useBrowser: true,   // JS-rendered — needs real browser
    },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getWeekLabel() {
  const now = new Date();
  const mon = new Date(now);
  mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt = (d) =>
    d.toLocaleDateString("en-MY", { day: "numeric", month: "short", timeZone: "Asia/Kuala_Lumpur" });
  const wn = Math.ceil(
    (((now - new Date(now.getFullYear(), 0, 1)) / 86400000) +
      new Date(now.getFullYear(), 0, 1).getDay() + 1) / 7
  );
  return `W${wn} · ${fmt(mon)}–${fmt(sun)} ${sun.getFullYear()}`;
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s >= 0 && e >= 0) return JSON.parse(clean.slice(s, e + 1));
  throw new Error("No JSON found");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cleanText(raw) {
  return raw.replace(/\s+/g, " ").replace(/\n+/g, " ").trim().slice(0, 10000);
}

// ─── Fetch with simple HTTP (fast, for SSR pages) ─────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-MY,en;q=0.9",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);
  $("script,style,noscript,nav,footer,header,iframe,svg").remove();
  $("[class*='cookie'],[class*='popup'],[class*='modal'],[id*='cookie']").remove();
  return cleanText($("body").text());
}

// ─── Fetch with Playwright (for JS-rendered SPA pages) ────────────────────────
async function fetchPageWithBrowser(url) {
  console.log(`    → Browser fetch: ${url}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale:    "en-MY",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Wait for key content to appear
    await page.waitForTimeout(3000);
    const text = await page.evaluate(() => document.body.innerText);
    return cleanText(text);
  } finally {
    await browser.close();
  }
}

// ─── Groq API call ────────────────────────────────────────────────────────────
async function callGroq(prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.groqKey}` },
    body: JSON.stringify({
      model:       CONFIG.groqModel,
      messages:    [{ role: "user", content: prompt }],
      max_tokens:  3000,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices[0]?.message?.content || "";
}

// ─── Scrape one competitor ────────────────────────────────────────────────────
async function scrapeCompetitor(name, cfg) {
  console.log(`  Fetching ${name} (${cfg.urls.length} pages, browser=${cfg.useBrowser})…`);

  const fetchFn = cfg.useBrowser ? fetchPageWithBrowser : fetchPage;
  const pages   = await Promise.allSettled(cfg.urls.map((u) => fetchFn(u)));
  const text    = pages
    .filter((p) => p.status === "fulfilled")
    .map((p) => p.value)
    .join("\n\n---PAGE BREAK---\n\n")
    .slice(0, 14000);

  if (!text.trim()) {
    console.warn(`  ⚠ No content for ${name}`);
    return { competitor: name, destination: [], partnership: [], flights: [] };
  }

  const prompt = `You are a competitor intelligence analyst. Analyse the scraped text from ${name}'s Malaysia promotion pages.

SCRAPED TEXT:
${text}

Extract every active campaign, deal, and promotion. Return ONLY valid JSON:
{
  "competitor": "${name}",
  "destination": [
    {
      "name": "exact campaign name",
      "dates": "dates e.g. Until 30 Jun 2026 / Ongoing / Every Tuesday",
      "type": "sale|destination|domestic|event|flash|partnership|flights",
      "promo": "full promo — ALL discount amounts, codes, min spend e.g. Up to 50% off · RM200 coupon · min RM500",
      "detail": "how it works, restrictions, stacking rules"
    }
  ],
  "partnership": [...same...],
  "flights": [...same...]
}

Types: sale=time-limited sales, destination=country/city pushes, domestic=Malaysia domestic, event=event-tied, flash=recurring time-locked deals, partnership=bank/BNPL/app/loyalty, flights=flight-specific.
Extract EVERY campaign. Include exact discount amounts, promo codes, day-of-week triggers (e.g. "every Monday").`;

  try {
    const result = parseJSON(await callGroq(prompt));
    const total  = (result.destination?.length||0)+(result.partnership?.length||0)+(result.flights?.length||0);
    console.log(`  ✓ ${name}: ${total} campaigns`);
    return result;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    return { competitor: name, destination: [], partnership: [], flights: [] };
  }
}

// ─── Generate summary + calendar ──────────────────────────────────────────────
async function generateSummary(allData, weekLabel) {
  console.log("  Generating summary…");

  const flat = Object.entries(allData).map(([name, d]) => ({
    name,
    total: (d.destination?.length||0)+(d.partnership?.length||0)+(d.flights?.length||0),
    campaigns: [...(d.destination||[]),...(d.partnership||[]),...(d.flights||[])],
  }));

  const prompt = `You are writing the weekly competitor intelligence Lark message for a travel marketing team.

WEEK: ${weekLabel}
DATA: ${JSON.stringify(flat, null, 2)}

Produce the message in EXACTLY this format. Fill in real data. Do NOT mention or reference Klook at all.

🔍 *Competitor Campaign Monitor — ${weekLabel}*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔵 *Traveloka* · {N} campaigns
• *{top campaign name}* — {full promo with exact discounts and dates}
• *{top campaign name}* — {full promo with exact discounts and dates}
• *{top campaign name}* — {full promo with exact discounts and dates}

🟢 *Trip.com* · {N} campaigns
• *{top campaign name}* — {full promo with exact discounts and dates}
• *{top campaign name}* — {full promo with exact discounts and dates}
• *{top campaign name}* — {full promo with exact discounts and dates}

🔴 *KKday* · {N} campaigns
• *{top campaign name}* — {full promo with exact discounts and dates}
• *{top campaign name}* — {full promo with exact discounts and dates}
• *{top campaign name}* — {full promo with exact discounts and dates}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 *Daily flash deal calendar*

*Mon*  🔵 {Traveloka Mon deal or —}  ·  🟢 {Trip.com Mon deal or —}  ·  🔴 {KKday Mon deal or —}
*Tue*  🔵 {Traveloka Tue deal or —}  ·  🟢 {Trip.com Tue deal or —}  ·  🔴 {KKday Tue deal or —}
*Wed*  🔵 {Traveloka Wed deal or —}  ·  🟢 {Trip.com Wed deal or —}  ·  🔴 {KKday Wed deal or —}
*Thu*  🔵 {Traveloka Thu deal or —}  ·  🟢 {Trip.com Thu deal or —}  ·  🔴 {KKday Thu deal or —}
*Fri*  🔵 {Traveloka Fri deal or —}  ·  🟢 {Trip.com Fri deal or —}  ·  🔴 {KKday Fri deal or —}
*Sat*  🔵 {Traveloka Sat deal or —}  ·  🟢 {Trip.com Sat deal or —}  ·  🔴 {KKday Sat deal or —}
*Sun*  🔵 {Traveloka Sun deal or —}  ·  🟢 {Trip.com Sun deal or —}  ·  🔴 {KKday Sun deal or —}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ *Key insights*
🔥 {specific insight about flash deal frequency with numbers e.g. "Traveloka runs deals 7/7 days, Trip.com 4/7"}
📅 {specific insight about sale calendar strategy}
🌏 {specific insight about destination or market focus}
🤝 {specific insight about partnership or payment strategy}
⚡ {specific insight about biggest competitive threat}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Auto-generated · GitHub Actions + Groq · ${weekLabel}_

Rules:
- Pick the 3 most impactful campaigns per competitor
- Include real discount amounts (RM amounts, percentages, promo codes)
- Be specific about timing (Every Monday, Until 30 Jun, 12AM–2AM)
- For the calendar: look for any campaign with day-of-week triggers; use — if no deal that day
- Do NOT mention or reference Klook anywhere in the message
- Insights must be specific observations with numbers, not generic statements

Return ONLY valid JSON:
{
  "lark_message": "full message above with \\n for newlines",
  "key_insights": ["insight 1","insight 2","insight 3","insight 4","insight 5"]
}`;

  try {
    const result = parseJSON(await callGroq(prompt));
    console.log("  ✓ Summary generated");
    return result;
  } catch (e) {
    console.error(`  ✗ Summary failed: ${e.message}`);
    return {
      lark_message: `Competitor Monitor — ${weekLabel}\nSummary generation failed. Check GitHub Actions logs.`,
      key_insights: [],
    };
  }
}

// ─── Send to Lark ─────────────────────────────────────────────────────────────
async function sendToLark(message) {
  if (!CONFIG.larkWebhook) { console.warn("  ⚠ No LARK_WEBHOOK_URL"); return false; }
  console.log("  Posting to Lark…");
  const res = await fetch(CONFIG.larkWebhook, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text: message } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Lark ${res.status}`);
  console.log("  ✓ Lark sent");
  return true;
}

// ─── Build HTML email ─────────────────────────────────────────────────────────
function buildEmailHTML(data, summary, weekLabel) {
  const chipCSS = (t) => ({
    sale:"background:#FEE2E2;color:#991B1B", destination:"background:#DBEAFE;color:#1E40AF",
    domestic:"background:#D1FAE5;color:#065F46", event:"background:#EDE9FE;color:#5B21B6",
    flash:"background:#FEF3C7;color:#92400E", partnership:"background:#F3E8FF;color:#6B21A8",
    flights:"background:#E0F2FE;color:#0C4A6E",
  }[t] || "background:#DBEAFE;color:#1E40AF");

  const compSection = (cId, cName, cHex) => {
    const d   = data[cId] || {};
    const all = [...(d.destination||[]),...(d.partnership||[]),...(d.flights||[])].slice(0,6);
    const total = (d.destination?.length||0)+(d.partnership?.length||0)+(d.flights?.length||0);
    const rows = all.map((c,i) => `
      <tr style="${i%2===0?"background:#f7f8fa":""}">
        <td style="padding:9px 12px;font-size:13px;font-weight:700;color:#111;border-bottom:1px solid #f0f0f0;width:32%;">${c.name||"—"}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f0f0f0;width:14%;">
          <span style="border-radius:20px;padding:2px 8px;font-size:10px;font-weight:700;${chipCSS(c.type)}">${c.type||"—"}</span>
        </td>
        <td style="padding:9px 12px;font-size:12px;color:#555;border-bottom:1px solid #f0f0f0;">${(c.promo||"").split("·")[0].trim()}${(c.promo||"").includes("·")?"…":""}</td>
        <td style="padding:9px 12px;font-size:11px;color:#999;border-bottom:1px solid #f0f0f0;width:18%;">${c.dates||""}</td>
      </tr>`).join("");
    return `
    <div style="background:#fff;margin-top:12px;border-radius:12px;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.07);">
      <div style="background:${cHex};padding:14px 20px;">
        <span style="font-size:16px;font-weight:900;color:#fff;">${cName}</span>
        <span style="font-size:11px;background:rgba(255,255,255,0.2);color:#fff;border-radius:20px;padding:2px 10px;margin-left:10px;font-weight:700;">${total} campaigns</span>
      </div>
      <div style="padding:16px 18px;">
        <table style="width:100%;border-collapse:collapse;">${rows||"<tr><td colspan='4' style='padding:12px;font-size:13px;color:#888;'>No campaigns extracted</td></tr>"}</table>
      </div>
    </div>`;
  };

  // Calendar section from lark_message
  const calendarLines = (summary.lark_message||"")
    .split("\n")
    .filter(l => /^\*?(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\*?/.test(l.trim()));

  const calendarRows = calendarLines.map((line, i) => {
    const day = line.trim().replace(/\*/g,"").split(/\s+/)[0];
    const rest = line.trim().replace(/^\*?\w{3}\*?\s+/,"");
    const parts = rest.split("·").map(p => p.trim());
    const bg = i%2===0 ? "background:#f7f8fa" : "";
    return `<tr style="${bg}">
      <td style="padding:9px 12px;font-size:13px;font-weight:700;color:#333;width:60px;border-bottom:1px solid #f0f0f0;">${day}</td>
      ${parts.map(p=>`<td style="padding:9px 12px;font-size:12px;color:#555;border-bottom:1px solid #f0f0f0;border-left:1px solid #f0f0f0;">${p||"—"}</td>`).join("")}
    </tr>`;
  }).join("");

  const insightRows = (summary.key_insights||[]).map((ins,i) => `
    <tr style="${i>0?"border-top:1px solid #f5f5f5":""}">
      <td style="padding:9px 0;font-size:18px;width:30px;vertical-align:top;">${["🔥","📅","🌏","🤝","⚡"][i]||"•"}</td>
      <td style="padding:9px 0 9px 10px;font-size:13px;color:#333;line-height:1.6;">${ins}</td>
    </tr>`).join("");

  const today = new Date().toLocaleDateString("en-MY",{timeZone:"Asia/Kuala_Lumpur",day:"numeric",month:"short",year:"numeric"});

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:700px;margin:0 auto;padding:24px 16px;">
  <div style="background:#111;border-radius:14px 14px 0 0;padding:24px 28px;">
    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.12em;font-weight:700;margin-bottom:6px;">Competitor Intelligence · Auto-generated</div>
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:900;color:#fff;">Competitor Campaign Monitor</h1>
    <div style="font-size:13px;color:#aaa;">${weekLabel} · ${today}</div>
  </div>
  ${compSection("traveloka","🔵 Traveloka","#0A9AF2")}
  ${compSection("tripcom","🟢 Trip.com","#1DA462")}
  ${compSection("kkday","🔴 KKday","#FF6B35")}
  ${calendarRows ? `
  <div style="background:#fff;margin-top:12px;border-radius:12px;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.07);">
    <div style="background:#1E3A8A;padding:13px 18px;">
      <span style="font-size:14px;font-weight:800;color:#fff;">📅 Daily flash deal calendar</span>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <tr style="background:#111;">
        <th style="padding:10px 12px;font-size:11px;font-weight:700;color:#999;text-align:left;width:60px;">Day</th>
        <th style="padding:10px 12px;font-size:11px;font-weight:700;color:#0A9AF2;text-align:left;border-left:1px solid #333;">🔵 Traveloka</th>
        <th style="padding:10px 12px;font-size:11px;font-weight:700;color:#1DA462;text-align:left;border-left:1px solid #333;">🟢 Trip.com</th>
        <th style="padding:10px 12px;font-size:11px;font-weight:700;color:#FF6B35;text-align:left;border-left:1px solid #333;">🔴 KKday</th>
      </tr>
      ${calendarRows}
    </table>
  </div>` : ""}
  <div style="background:#fff;margin-top:12px;border-radius:12px;padding:18px 20px;box-shadow:0 2px 6px rgba(0,0,0,0.07);">
    <div style="font-size:14px;font-weight:800;color:#111;margin-bottom:14px;">⚡ Key insights</div>
    <table style="width:100%;border-collapse:collapse;">${insightRows||"<tr><td style='font-size:13px;color:#888;padding:8px 0;'>No insights generated.</td></tr>"}</table>
  </div>
  <div style="margin-top:16px;padding:14px 0;border-top:1px solid #e8e8e8;">
    <div style="font-size:11px;color:#bbb;">Auto-generated · GitHub Actions + Groq (${CONFIG.groqModel}) · ${weekLabel}</div>
  </div>
</div></body></html>`;
}

// ─── Send email ───────────────────────────────────────────────────────────────
async function sendEmail(html, subject) {
  if (!CONFIG.gmailUser || !CONFIG.gmailPass) { console.warn("  ⚠ Gmail not configured"); return false; }
  console.log("  Sending email…");
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: CONFIG.gmailUser, pass: CONFIG.gmailPass },
  });
  await transporter.sendMail({
    from: `"Competitor Intel" <${CONFIG.gmailUser}>`,
    to: CONFIG.recipient, subject, html,
  });
  console.log(`  ✓ Email → ${CONFIG.recipient}`);
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const weekLabel = getWeekLabel();
  const t0 = Date.now();
  console.log(`\n🚀 Competitor Monitor — ${weekLabel}\n   Model: ${CONFIG.groqModel}\n`);

  console.log("Step 1 — Scraping");
  const results = {};
  for (const [name, cfg] of Object.entries(CONFIG.competitors)) {
    results[name] = await scrapeCompetitor(name, cfg);
    await sleep(1500);
  }

  console.log("\nStep 2 — Summary");
  const summary = await generateSummary(results, weekLabel);

  console.log("\nStep 3 — Lark");
  await sendToLark(summary.lark_message);

  console.log("\nStep 4 — Email");
  const html = buildEmailHTML(results, summary, weekLabel);
  await sendEmail(html, `🔍 Competitor Monitor — ${weekLabel} | Traveloka · Trip.com · KKday`);

  console.log(`\n✅ Done in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
}

main().catch((e) => { console.error("\n❌", e.message); process.exit(1); });
