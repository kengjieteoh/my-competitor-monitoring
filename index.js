// ─── Klook MY Competitor Monitor (Groq Edition) ───────────────────────────────
const nodemailer = require("nodemailer");
const cheerio    = require("cheerio");

const CONFIG = {
  groqKey:     process.env.GROQ_API_KEY,
  larkWebhook: process.env.LARK_WEBHOOK_URL,
  gmailUser:   process.env.GMAIL_USER,
  gmailPass:   process.env.GMAIL_APP_PASSWORD,
  recipient:   process.env.RECIPIENT_EMAIL || "kengjie.teoh@klook.com",
  groqModel:   "llama-3.3-70b-versatile",
  competitors: {
    traveloka: [
      "https://www.traveloka.com/en-my/promotion",
      "https://www.traveloka.com/en-my/promotion/l/special-campaigns",
      "https://www.traveloka.com/en-my/promotion/l/flights",
      "https://www.traveloka.com/en-my/promotion/l/hotel",
      "https://www.traveloka.com/en-my/promotion/l/things-to-do",
    ],
    tripcom: [
      "https://my.trip.com/?locale=en-my",
      "https://my.trip.com/sale/w/19280/gochina.html?locale=en-MY",
      "https://my.trip.com/sale/w/24663/superlokal.html?locale=en-my",
    ],
    kkday: [
      "https://www.kkday.com/en-my",
      "https://www.kkday.com/en-my/hot-campaigns",
      "https://www.kkday.com/en-my/campaign/mid-year-sale",
    ],
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
    d.toLocaleDateString("en-MY", { day:"numeric", month:"short", timeZone:"Asia/Kuala_Lumpur" });
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

// ─── Fetch + clean one page ───────────────────────────────────────────────────
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
  $("script, style, noscript, nav, footer, header, iframe, svg").remove();
  $("[class*='cookie'],[class*='popup'],[class*='modal'],[id*='cookie']").remove();
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, 10000);
}

// ─── Groq API call ────────────────────────────────────────────────────────────
async function callGroq(prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${CONFIG.groqKey}`,
    },
    body: JSON.stringify({
      model:       CONFIG.groqModel,
      messages:    [{ role: "user", content: prompt }],
      max_tokens:  3000,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices[0]?.message?.content || "";
}

// ─── Scrape one competitor ────────────────────────────────────────────────────
async function scrapeCompetitor(name, urls) {
  console.log(`  Fetching ${name} (${urls.length} pages)…`);

  const pages = await Promise.allSettled(urls.map((u) => fetchPage(u)));
  const text  = pages
    .filter((p) => p.status === "fulfilled")
    .map((p) => p.value)
    .join("\n\n---PAGE BREAK---\n\n")
    .slice(0, 14000);

  if (!text.trim()) {
    console.warn(`  ⚠ No content fetched for ${name}`);
    return { competitor: name, destination: [], partnership: [], flights: [] };
  }

  const prompt = `You are a competitor intelligence analyst for Klook Malaysia.

Analyse the scraped text from ${name}'s Malaysia promotion pages and extract every active campaign.

SCRAPED TEXT:
${text}

Return ONLY valid JSON — no markdown, no explanation, no extra text:
{
  "competitor": "${name}",
  "destination": [
    {
      "name": "exact campaign name from page",
      "dates": "dates shown e.g. Until 30 Jun 2026 or Ongoing or Every Tuesday",
      "type": "sale|destination|domestic|event|flash|partnership|flights",
      "promo": "full promo text — include ALL discount amounts, promo codes, min spend e.g. Up to 50% off hotels · RM200 coupon · FREE cancellation",
      "detail": "mechanic details — how it works, restrictions, stacking rules"
    }
  ],
  "partnership": [ ...same schema... ],
  "flights": [ ...same schema... ]
}

Classification guide:
- destination: country/city pushes, sitewide activity deals
- partnership: bank cards, BNPL, loyalty programmes, app promos, co-branded deals
- flights: flight-specific prices or discounts
- sale: time-limited % off events (Mid Year Sale, 6.6, etc.)
- flash: recurring time-locked deals (daily flash, weekly flash)
- domestic: Malaysia domestic travel deals
- event: event-tied deals (concerts, F1, World Cup)

Extract EVERY campaign. Include exact discount amounts, promo codes, and minimum spend values where shown.`;

  try {
    const response = await callGroq(prompt);
    const result   = parseJSON(response);
    const total    = (result.destination?.length || 0) + (result.partnership?.length || 0) + (result.flights?.length || 0);
    console.log(`  ✓ ${name}: ${total} campaigns extracted`);
    return result;
  } catch (e) {
    console.error(`  ✗ ${name} extraction failed: ${e.message}`);
    return { competitor: name, destination: [], partnership: [], flights: [] };
  }
}

// ─── Generate summary ─────────────────────────────────────────────────────────
async function generateSummary(allData, weekLabel) {
  console.log("  Generating summary with Groq…");

  // Flatten all campaigns for context
  const summary = Object.entries(allData).map(([name, d]) => ({
    name,
    total: (d.destination?.length||0) + (d.partnership?.length||0) + (d.flights?.length||0),
    all: [...(d.destination||[]), ...(d.partnership||[]), ...(d.flights||[])],
  }));

  const prompt = `You are a senior marketing analyst at Klook Malaysia writing the weekly competitor intelligence report.

WEEK: ${weekLabel}
DATA: ${JSON.stringify(summary, null, 2)}

Produce the Lark message in EXACTLY this format — copy the structure precisely, fill in the real data:

🔍 *Competitor Campaign Monitor — ${weekLabel}*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔵 *Traveloka* · {N} campaigns this week
• *{campaign name}* — {full promo detail with discount amounts and dates}
• *{campaign name}* — {full promo detail}
• *{campaign name}* — {full promo detail}

🟢 *Trip.com* · {N} campaigns this week
• *{campaign name}* — {full promo detail with discount amounts and dates}
• *{campaign name}* — {full promo detail}
• *{campaign name}* — {full promo detail}

🔴 *KKday* · {N} campaigns this week
• *{campaign name}* — {full promo detail with discount amounts and dates}
• *{campaign name}* — {full promo detail}
• *{campaign name}* — {full promo detail}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 *Flash deal calendar*
{List which competitor runs deals on which days e.g. Traveloka: Mon–Sun (7/7) · Trip.com: Tue+Thu (2/7) etc.}
⚠️ Klook MY: 0 recurring flash deals

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ *Key insights*
🔥 {Insight about flash deal gap}
📅 {Insight about sale calendar or timing strategy}
🌏 {Insight about destination or market focus}
🤝 {Insight about partnership or payment strategy}
⚡ {Insight about biggest threat to Klook}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Auto-generated · GitHub Actions + Groq · ${weekLabel}_

Rules:
- Pick the TOP 3 most impactful campaigns per competitor
- Include real discount amounts (e.g. RM120 off, 50% off, B1G1) not generic descriptions
- Be specific about dates (e.g. Every Tuesday, Until 30 Jun, Ongoing)
- Insights must be specific observations, not generic advice
- Do NOT add action items

Return ONLY valid JSON:
{
  "lark_message": "the full message above with real data filled in, all newlines as \\n",
  "key_insights": ["insight 1","insight 2","insight 3","insight 4","insight 5"]
}`;

  try {
    const response = await callGroq(prompt);
    const result   = parseJSON(response);
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
  if (!CONFIG.larkWebhook) { console.warn("  ⚠ LARK_WEBHOOK_URL not set"); return false; }
  console.log("  Posting to Lark…");
  const res = await fetch(CONFIG.larkWebhook, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ msg_type: "text", content: { text: message } }),
    signal:  AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Lark webhook ${res.status}`);
  console.log("  ✓ Lark message sent");
  return true;
}

// ─── Build HTML email ─────────────────────────────────────────────────────────
function buildEmailHTML(data, summary, weekLabel) {
  const chipCSS = (t) => ({
    sale:        "background:#FEE2E2;color:#991B1B",
    destination: "background:#DBEAFE;color:#1E40AF",
    domestic:    "background:#D1FAE5;color:#065F46",
    event:       "background:#EDE9FE;color:#5B21B6",
    flash:       "background:#FEF3C7;color:#92400E",
    partnership: "background:#F3E8FF;color:#6B21A8",
    flights:     "background:#E0F2FE;color:#0C4A6E",
  }[t] || "background:#DBEAFE;color:#1E40AF");

  const compSection = (cId, cName, cHex) => {
    const d   = data[cId] || {};
    const all = [...(d.destination||[]),...(d.partnership||[]),...(d.flights||[])].slice(0, 6);
    const total = (d.destination?.length||0)+(d.partnership?.length||0)+(d.flights?.length||0);
    const rows = all.map((c, i) => `
      <tr style="${i%2===0?"background:#f7f8fa":""}">
        <td style="padding:9px 12px;font-size:13px;font-weight:700;color:#111;border-bottom:1px solid #f0f0f0;width:34%;">${c.name||"—"}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f0f0f0;width:14%;">
          <span style="border-radius:20px;padding:2px 8px;font-size:10px;font-weight:700;${chipCSS(c.type)}">${c.type||"—"}</span>
        </td>
        <td style="padding:9px 12px;font-size:12px;color:#555;border-bottom:1px solid #f0f0f0;">${(c.promo||"").split("·")[0].trim()}${(c.promo||"").includes("·")?"…":""}</td>
        <td style="padding:9px 12px;font-size:11px;color:#999;border-bottom:1px solid #f0f0f0;width:16%;">${c.dates||""}</td>
      </tr>`).join("");

    return `
    <div style="background:#fff;margin-top:12px;border-radius:12px;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.07);">
      <div style="background:${cHex};padding:14px 20px;">
        <span style="font-size:16px;font-weight:900;color:#fff;">${cName}</span>
        <span style="font-size:11px;background:rgba(255,255,255,0.2);color:#fff;border-radius:20px;padding:2px 10px;margin-left:10px;font-weight:700;">${total} campaigns</span>
      </div>
      <div style="padding:16px 18px;">
        <table style="width:100%;border-collapse:collapse;">${rows||"<tr><td colspan='4' style='padding:12px;font-size:13px;color:#888;'>No campaigns extracted this week</td></tr>"}</table>
      </div>
    </div>`;
  };

  const insightRows = (summary.key_insights||[]).map((ins, i) => `
    <tr style="${i>0?"border-top:1px solid #f5f5f5":""}">
      <td style="padding:9px 0;font-size:18px;width:30px;vertical-align:top;">${["🔥","📅","🌏","🤝","⚡"][i]||"•"}</td>
      <td style="padding:9px 0 9px 10px;font-size:13px;color:#333;line-height:1.6;">${ins}</td>
    </tr>`).join("");

  const today = new Date().toLocaleDateString("en-MY",{timeZone:"Asia/Kuala_Lumpur",day:"numeric",month:"short",year:"numeric"});

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:680px;margin:0 auto;padding:24px 16px;">
  <div style="background:#111;border-radius:14px 14px 0 0;padding:24px 28px;">
    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.12em;font-weight:700;margin-bottom:6px;">Klook Marketing · Competitor Intelligence · Auto-generated</div>
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:900;color:#fff;">Competitor Campaign Monitor</h1>
    <div style="font-size:13px;color:#aaa;">${weekLabel} · ${today}</div>
  </div>
  <div style="background:#FEF2F2;border-left:4px solid #EF4444;padding:12px 20px;">
    <span style="font-size:13px;color:#991B1B;font-weight:700;">🚨 Flash deal gap: competitors active daily · Klook MY: 0 recurring flash deals</span>
  </div>
  ${compSection("traveloka","🔵 Traveloka","#0A9AF2")}
  ${compSection("tripcom","🟢 Trip.com","#1DA462")}
  ${compSection("kkday","🔴 KKday","#FF6B35")}
  <div style="background:#fff;margin-top:12px;border-radius:12px;padding:18px 20px;box-shadow:0 2px 6px rgba(0,0,0,0.07);">
    <div style="font-size:14px;font-weight:800;color:#111;margin-bottom:14px;">⚡ Key insights this week</div>
    <table style="width:100%;border-collapse:collapse;">${insightRows||"<tr><td style='font-size:13px;color:#888;padding:8px 0;'>No insights generated.</td></tr>"}</table>
  </div>
  <div style="margin-top:16px;padding:14px 0;border-top:1px solid #e8e8e8;">
    <div style="font-size:11px;color:#bbb;">Auto-generated by Klook MY Marketing Intelligence · GitHub Actions + Groq (${CONFIG.groqModel}) · ${weekLabel}</div>
  </div>
</div></body></html>`;
}

// ─── Send email ───────────────────────────────────────────────────────────────
async function sendEmail(htmlBody, subject) {
  if (!CONFIG.gmailUser || !CONFIG.gmailPass) { console.warn("  ⚠ Gmail not configured"); return false; }
  console.log("  Sending email…");
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: CONFIG.gmailUser, pass: CONFIG.gmailPass },
  });
  await transporter.sendMail({
    from:    `"Klook MY Intel" <${CONFIG.gmailUser}>`,
    to:      CONFIG.recipient,
    subject,
    html:    htmlBody,
  });
  console.log(`  ✓ Email sent → ${CONFIG.recipient}`);
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const weekLabel = getWeekLabel();
  const startTime = Date.now();
  console.log(`\n🚀 Klook Competitor Monitor — ${weekLabel}`);
  console.log(`   Model: ${CONFIG.groqModel}\n`);

  // 1. Scrape — sequential to avoid rate limits
  console.log("Step 1 — Scraping competitors");
  const results = {};
  for (const [name, urls] of Object.entries(CONFIG.competitors)) {
    results[name] = await scrapeCompetitor(name, urls);
    await sleep(1500);
  }

  // 2. Summary
  console.log("\nStep 2 — AI summary");
  const summary = await generateSummary(results, weekLabel);

  // 3. Lark
  console.log("\nStep 3 — Lark");
  await sendToLark(summary.lark_message);

  // 4. Email
  console.log("\nStep 4 — Email");
  const html    = buildEmailHTML(results, summary, weekLabel);
  const subject = `🔍 Competitor Monitor — ${weekLabel} | Traveloka · Trip.com · KKday`;
  await sendEmail(html, subject);

  console.log(`\n✅ Done in ${((Date.now()-startTime)/1000).toFixed(1)}s — ${weekLabel}\n`);
}

main().catch((err) => {
  console.error("\n❌ Fatal error:", err.message);
  process.exit(1);
});
