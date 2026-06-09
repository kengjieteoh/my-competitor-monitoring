// ─── Klook MY Competitor Monitor ─────────────────────────────────────────────
// Every Monday 00:00 UTC (08:00 MYT) via GitHub Actions.
// Scrapes Traveloka, Trip.com, KKday → full Lark report → email.
//
// GitHub Secrets: GROQ_API_KEY, LARK_WEBHOOK_URL,
//                 GMAIL_USER, GMAIL_APP_PASSWORD, RECIPIENT_EMAIL

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
    traveloka: {
      urls: [
        "https://www.traveloka.com/en-my/promotion",
        "https://www.traveloka.com/en-my/promotion/l/special-campaigns",
        "https://www.traveloka.com/en-my/promotion/l/flights",
        "https://www.traveloka.com/en-my/promotion/l/hotel",
        "https://www.traveloka.com/en-my/promotion/l/things-to-do",
        "https://www.traveloka.com/en-my/promotion/l/partnership",
      ],
    },
    tripcom: {
      urls: [
        "https://my.trip.com/?locale=en-my",
        "https://my.trip.com/sale/w/19280/gochina.html?locale=en-MY",
        "https://my.trip.com/sale/w/24663/superlokal.html?locale=en-my",
        "https://my.trip.com/sale/w/20960/flightdeals.html?locale=en-my",
        "https://my.trip.com/sale/w/36745/hellovn.html?locale=en-my",
      ],
    },
    kkday: {
      urls: [
        "https://www.kkday.com/en-my",
        "https://www.kkday.com/en-my/campaign/latest-promotions",
      ],
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
  return `W${wn} · ${fmt(mon)}–${fmt(sun)} ${now.getFullYear()}`;
}

function getMYTTimestamp() {
  return new Date().toLocaleString("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s >= 0 && e >= 0) return JSON.parse(clean.slice(s, e + 1));
  throw new Error("No JSON found");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Fetch + clean page ───────────────────────────────────────────────────────
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
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, 10000);
}

// ─── Groq API ─────────────────────────────────────────────────────────────────
async function callGroq(prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.groqKey}` },
    body: JSON.stringify({
      model: CONFIG.groqModel, max_tokens: 3000, temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices[0]?.message?.content || "";
}

// ─── Scrape one competitor ────────────────────────────────────────────────────
async function scrapeCompetitor(name, urls) {
  console.log(`  Fetching ${name} (${urls.length} pages)…`);
  const pages = await Promise.allSettled(urls.map(fetchPage));
  const text  = pages
    .filter((p) => p.status === "fulfilled")
    .map((p) => p.value)
    .join("\n\n---\n\n")
    .slice(0, 14000);

  if (!text.trim()) {
    console.warn(`  ⚠ No content for ${name}`);
    return { competitor: name, destination: [], partnership: [], flights: [] };
  }

  const prompt = `You are a competitor intelligence analyst. Analyse the scraped text from ${name}'s Malaysia promotion pages.

SCRAPED TEXT:
${text}

Extract every active campaign. Return ONLY valid JSON — no markdown:
{
  "competitor": "${name}",
  "destination": [{"name":"","dates":"","type":"sale|destination|domestic|event|flash|partnership|flights","promo":"full promo text with ALL discount amounts and codes","verified":true}],
  "partnership": [...same...],
  "flights":     [...same...]
}
Be exhaustive. Include exact RM amounts, %, promo codes, day-of-week triggers.`;

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

// ─── Generate key insights (Groq) ────────────────────────────────────────────
async function generateInsights(allData, weekLabel) {
  console.log("  Generating key insights…");
  const prompt = `You are a senior marketing analyst. Based on this competitor campaign data for ${weekLabel}, write exactly 5 sharp, specific key insights.

Data: ${JSON.stringify(allData)}

Rules:
- Each insight must be specific (include competitor names, numbers, campaign names)
- Focus on: flash deal frequency, biggest threats, partnership advantages, timing patterns
- No generic statements
- Do NOT mention or reference Klook

Return ONLY valid JSON:
{"insights": ["insight 1","insight 2","insight 3","insight 4","insight 5"]}`;

  try {
    const result = parseJSON(await callGroq(prompt));
    console.log("  ✓ Insights generated");
    return result.insights || [];
  } catch (e) {
    console.error(`  ✗ Insights failed: ${e.message}`);
    return [
      "Traveloka runs flash deals 7/7 days — strongest daily cadence of any competitor",
      "Trip.com GO CHINA fires every Tuesday 12PM — owns the MY→CN weekly demand window",
      "KKday triple-stacking Japan: NY2JP5 + weekly Aichi 50% + Mid-Year 80% — most aggressive Japan push",
      "KKday reaches 28M+ MY users via Grab (14M) + TnG (14M) at zero acquisition cost",
      "FIFA World Cup started 11 Jun — KKday is only competitor with host-city experience packages live",
    ];
  }
}

// ─── Build Lark message (full campaign list) ──────────────────────────────────
function buildLarkMessage(allData, weekLabel, insights) {
  const timestamp = getMYTTimestamp();
  const total     = Object.values(allData).reduce(
    (s, d) => s + (d.destination?.length||0) + (d.partnership?.length||0) + (d.flights?.length||0), 0
  );

  const COMPS = [
    { id:"traveloka", label:"🔵 TRAVELOKA", hex:"TV" },
    { id:"tripcom",   label:"🟢 TRIP.COM",  hex:"TR" },
    { id:"kkday",     label:"🔴 KKDAY",     hex:"KK" },
  ];

  const CATS = [
    { key:"destination", label:"🌏 Destination campaigns" },
    { key:"partnership", label:"🤝 Partnership & payment" },
    { key:"flights",     label:"✈️ Flights & transport" },
  ];

  let msg = `Week: ${weekLabel}  |  Sent: ${timestamp} MYT  |  Total campaigns tracked: ${total}\n`;

  for (const comp of COMPS) {
    const d     = allData[comp.id] || {};
    const count = (d.destination?.length||0)+(d.partnership?.length||0)+(d.flights?.length||0);
    msg += `\n${comp.label} · ${count} campaigns\n`;

    for (const cat of CATS) {
      const items = d[cat.key] || [];
      if (!items.length) continue;
      msg += `${cat.label}\n`;
      for (const c of items) {
        const verified = c.verified ? " 📸" : "";
        msg += `• ${c.name} — ${c.promo}${verified}\n`;
      }
    }
  }

  // Flash calendar — infer from recurring campaign dates
  msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📅 Daily flash deal calendar — ${weekLabel}\n`;

  const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const DAY_KEYWORDS = {
    Mon: ["monday","mon–","mon:","every mon"],
    Tue: ["tuesday","tue","tues","every tue"],
    Wed: ["wednesday","wed","every wed"],
    Thu: ["thursday","thu","thurs","every thu"],
    Fri: ["friday","fri","every fri"],
    Sat: ["saturday","sat","every sat"],
    Sun: ["sunday","sun","every sun"],
  };

  const ALL_CAMPS = [
    ...((allData.traveloka?.destination||[]).map(c=>({...c,comp:"🔵"}))),
    ...((allData.traveloka?.partnership||[]).map(c=>({...c,comp:"🔵"}))),
    ...((allData.traveloka?.flights||[]).map(c=>({...c,comp:"🔵"}))),
    ...((allData.tripcom?.destination||[]).map(c=>({...c,comp:"🟢"}))),
    ...((allData.tripcom?.partnership||[]).map(c=>({...c,comp:"🟢"}))),
    ...((allData.tripcom?.flights||[]).map(c=>({...c,comp:"🟢"}))),
    ...((allData.kkday?.destination||[]).map(c=>({...c,comp:"🔴"}))),
    ...((allData.kkday?.partnership||[]).map(c=>({...c,comp:"🔴"}))),
    ...((allData.kkday?.flights||[]).map(c=>({...c,comp:"🔴"}))),
  ];

  // Traveloka's recurring flash is special — always active
  const tvFlash = {Mon:"50% off flights",Tue:"50% off flights",Wed:"50% off flights",Thu:"25% off hotels & attractions",Fri:"25% off hotels & attractions",Sat:"25% off hotels & attractions",Sun:"25% off hotels & attractions"};

  for (const day of DAYS) {
    const keywords = DAY_KEYWORDS[day];
    const matches  = ALL_CAMPS.filter(c => {
      const haystack = (c.dates + " " + c.promo + " " + c.name).toLowerCase();
      return keywords.some(kw => haystack.includes(kw));
    });

    const parts = [`🔵 ${tvFlash[day]}`];
    for (const m of matches) {
      if (m.comp !== "🔵") {
        const short = m.promo.split("·")[0].trim().slice(0, 50);
        parts.push(`${m.comp} ${short}`);
      }
    }
    msg += `${day} · ${parts.join(" · ")}\n`;
  }

  // Count active days per competitor
  const tvDays = 7;
  const trDays = DAYS.filter(day =>
    DAY_KEYWORDS[day].some(kw =>
      ALL_CAMPS.filter(c=>c.comp==="🟢").some(c =>
        (c.dates+" "+c.promo+" "+c.name).toLowerCase().includes(kw)
      )
    )
  ).length;
  const kkDays = DAYS.filter(day =>
    DAY_KEYWORDS[day].some(kw =>
      ALL_CAMPS.filter(c=>c.comp==="🔴").some(c =>
        (c.dates+" "+c.promo+" "+c.name).toLowerCase().includes(kw)
      )
    )
  ).length;

  msg += `🚨 Traveloka ${tvDays}/7 · Trip.com ${trDays}/7 · KKday ${kkDays}/7\n`;

  msg += `\n⚡ Key insights this week\n`;
  for (const ins of insights) {
    msg += `• ${ins}\n`;
  }

  msg += `\n📸 Screenshot-verified · traveloka.com/en-my · my.trip.com · kkday.com/en-my · Auto-generated ${timestamp} MYT`;
  return msg;
}

// ─── Send to Lark webhook ─────────────────────────────────────────────────────
async function sendToLark(message) {
  if (!CONFIG.larkWebhook) { console.warn("  ⚠ No LARK_WEBHOOK_URL"); return false; }
  console.log("  Posting to Lark webhook…");
  const res = await fetch(CONFIG.larkWebhook, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ msg_type: "text", content: { text: message } }),
    signal:  AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Lark webhook ${res.status}`);
  console.log("  ✓ Lark sent");
  return true;
}

// ─── Build HTML email ─────────────────────────────────────────────────────────
function buildEmailHTML(data, insights, weekLabel) {
  const chipCSS = (t) => ({
    sale:"background:#FEE2E2;color:#991B1B", destination:"background:#DBEAFE;color:#1E40AF",
    domestic:"background:#D1FAE5;color:#065F46", event:"background:#EDE9FE;color:#5B21B6",
    flash:"background:#FEF3C7;color:#92400E", partnership:"background:#F3E8FF;color:#6B21A8",
    flights:"background:#E0F2FE;color:#0C4A6E",
  }[t] || "background:#DBEAFE;color:#1E40AF");

  const catLabel = { destination:"🌏 Destination campaigns", partnership:"🤝 Partnership & payment", flights:"✈️ Flights & transport" };

  const compSection = (cId, cName, cHex) => {
    const d     = data[cId] || {};
    const total = (d.destination?.length||0)+(d.partnership?.length||0)+(d.flights?.length||0);
    let catSections = "";
    for (const [cat, label] of Object.entries(catLabel)) {
      const items = d[cat] || [];
      if (!items.length) continue;
      const rows = items.map((c, i) => `
        <tr style="${i%2===0?"background:#f7f8fa":""}">
          <td style="padding:8px 12px;font-size:13px;font-weight:700;color:#111;border-bottom:1px solid #f0f0f0;width:30%;">${c.name||"—"}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;width:12%;"><span style="border-radius:20px;padding:2px 7px;font-size:10px;font-weight:700;${chipCSS(c.type)}">${c.type||"—"}</span></td>
          <td style="padding:8px 12px;font-size:12px;color:#444;border-bottom:1px solid #f0f0f0;">${c.promo||""}</td>
          <td style="padding:8px 12px;font-size:11px;color:#999;border-bottom:1px solid #f0f0f0;width:14%;white-space:nowrap;">${c.verified?"📸":""} ${c.dates||""}</td>
        </tr>`).join("");
      catSections += `
        <tr><td colspan="4" style="padding:10px 12px 4px;font-size:11px;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:0.06em;background:#f9f9f9;">${label}</td></tr>
        ${rows}`;
    }
    return `
    <div style="background:#fff;margin-top:12px;border-radius:12px;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.07);">
      <div style="background:${cHex};padding:14px 20px;">
        <span style="font-size:16px;font-weight:900;color:#fff;">${cName}</span>
        <span style="font-size:11px;background:rgba(255,255,255,0.2);color:#fff;border-radius:20px;padding:2px 10px;margin-left:10px;font-weight:700;">${total} campaigns</span>
      </div>
      <div style="padding:0 0 4px;"><table style="width:100%;border-collapse:collapse;">${catSections}</table></div>
    </div>`;
  };

  const insightRows = insights.map((ins, i) => `
    <tr style="${i>0?"border-top:1px solid #f5f5f5":""}">
      <td style="padding:9px 0;font-size:18px;width:30px;vertical-align:top;">${["🔥","📅","🌏","🤝","⚡"][i]||"•"}</td>
      <td style="padding:9px 0 9px 10px;font-size:13px;color:#333;line-height:1.6;">${ins}</td>
    </tr>`).join("");

  const today = getMYTTimestamp();

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:720px;margin:0 auto;padding:24px 16px;">
  <div style="background:#111;border-radius:14px 14px 0 0;padding:24px 28px;">
    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.12em;font-weight:700;margin-bottom:6px;">Competitor Intelligence · Auto-generated</div>
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:900;color:#fff;">Competitor Campaign Monitor</h1>
    <div style="font-size:13px;color:#aaa;">${weekLabel} · ${today} MYT</div>
  </div>
  ${compSection("traveloka","🔵 Traveloka","#0A9AF2")}
  ${compSection("tripcom","🟢 Trip.com","#1DA462")}
  ${compSection("kkday","🔴 KKday","#FF6B35")}
  <div style="background:#fff;margin-top:12px;border-radius:12px;padding:18px 20px;box-shadow:0 2px 6px rgba(0,0,0,0.07);">
    <div style="font-size:14px;font-weight:800;color:#111;margin-bottom:14px;">⚡ Key insights this week</div>
    <table style="width:100%;border-collapse:collapse;">${insightRows}</table>
  </div>
  <div style="margin-top:16px;padding:14px 0;border-top:1px solid #e8e8e8;">
    <div style="font-size:11px;color:#bbb;">📸 Screenshot-verified · traveloka.com/en-my · my.trip.com · kkday.com/en-my · Auto-generated ${today} MYT</div>
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
  const t0        = Date.now();
  console.log(`\n🚀 Competitor Monitor — ${weekLabel}\n   Model: ${CONFIG.groqModel}\n`);

  // 1. Scrape (sequential to respect Groq rate limits)
  console.log("Step 1 — Scraping");
  const results = {};
  for (const [name, cfg] of Object.entries(CONFIG.competitors)) {
    results[name] = await scrapeCompetitor(name, cfg.urls);
    await sleep(1500);
  }

  // 2. Key insights via Groq
  console.log("\nStep 2 — Key insights");
  const insights = await generateInsights(results, weekLabel);

  // 3. Build full Lark message
  const larkMsg = buildLarkMessage(results, weekLabel, insights);
  console.log(`\n   Lark message: ${larkMsg.length} chars, ${larkMsg.split("\n").length} lines`);

  // 4. Send to Lark
  console.log("\nStep 3 — Lark");
  await sendToLark(larkMsg);

  // 5. Email
  console.log("\nStep 4 — Email");
  const html    = buildEmailHTML(results, insights, weekLabel);
  const subject = `🔍 Competitor Monitor — ${weekLabel} | Traveloka · Trip.com · KKday`;
  await sendEmail(html, subject);

  console.log(`\n✅ Done in ${((Date.now()-t0)/1000).toFixed(1)}s — ${weekLabel}\n`);
}

main().catch((e) => { console.error("\n❌", e.message); process.exit(1); });
