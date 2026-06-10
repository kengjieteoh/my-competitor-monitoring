// ─── Klook MY Competitor Monitor ─────────────────────────────────────────────
// Weekly:  Every Monday 08:00 MYT → scrape → Sheets → Lark → Email → commit data.json
// Monthly: First Monday of month  → monthly analysis → Lark + Email

const nodemailer   = require("nodemailer");
const cheerio      = require("cheerio");
const fs           = require("fs");
const path         = require("path");

const CONFIG = {
  groqKey:       process.env.GROQ_API_KEY,
  larkWebhook:   process.env.LARK_WEBHOOK_URL,
  gmailUser:     process.env.GMAIL_USER,
  gmailPass:     process.env.GMAIL_APP_PASSWORD,
  recipient:     process.env.RECIPIENT_EMAIL || "kengjie.teoh@klook.com",
  sheetsWebhook: process.env.SHEETS_WEBAPP_URL,
  groqModel:     "llama-3.1-8b-instant",
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
      label: "Traveloka",
      useBrowser: false,
    },
    tripcom: {
      urls: [
        "https://my.trip.com/?locale=en-my",
        "https://my.trip.com/sale/w/19280/gochina.html?locale=en-MY",
        "https://my.trip.com/sale/w/24663/superlokal.html?locale=en-my",
        "https://my.trip.com/sale/w/20960/flightdeals.html?locale=en-my",
      ],
      label: "Trip.com",
      useBrowser: false,
    },
    kkday: {
      urls: [
        "https://www.kkday.com/en-my",
        "https://www.kkday.com/en-my/hot-campaigns",
      ],
      label: "KKday",
      useJina: true,
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

function getMonthTabName() {
  return new Date().toLocaleDateString("en-MY", {
    month: "short", year: "numeric", timeZone: "Asia/Kuala_Lumpur",
  }); // e.g. "Jun 2026"
}

function getMonthLabel() {
  return new Date().toLocaleDateString("en-MY", {
    month: "long", year: "numeric", timeZone: "Asia/Kuala_Lumpur",
  }); // e.g. "June 2026"
}

function getMYT() {
  return new Date().toLocaleString("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    weekday:"short", day:"numeric", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit",
  });
}

function isFirstMondayOfMonth() {
  const now = new Date();
  return now.getDay() === 1 && now.getDate() <= 7;
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s >= 0 && e >= 0) return JSON.parse(clean.slice(s, e + 1));
  throw new Error("No JSON found in Groq response");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Fetch (SSR pages) ────────────────────────────────────────────────────────
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

// ─── Jina AI Reader (handles JS-rendered SPAs like KKday) ───────────────────
// Free, no API key needed — renders JavaScript fully via r.jina.ai
async function fetchWithJina(url) {
  console.log(`    🔍 Jina: ${url}`);
  const jinaUrl = `https://r.jina.ai/${url}`;
  const res = await fetch(jinaUrl, {
    headers: {
      "Accept":          "text/plain",
      "X-Return-Format": "text",
      "X-Locale":        "en-MY",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Jina ${res.status}`);
  const text = await res.text();
  return text.slice(0, 12000);
}

// ─── Groq ─────────────────────────────────────────────────────────────────────
async function callGroq(prompt, maxTokens = 3000) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.groqKey}` },
    body: JSON.stringify({
      model: CONFIG.groqModel, max_tokens: maxTokens, temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0,200)}`);
  return (await res.json()).choices[0]?.message?.content || "";
}

// ─── Scrape ───────────────────────────────────────────────────────────────────
async function scrapeCompetitor(name, cfg) {
  console.log(`  Fetching ${name} (browser=${cfg.useBrowser})…`);
  const fetchFn = cfg.useJina ? fetchWithJina : fetchPage;
  const pages = [];
  for (const url of cfg.urls) {
    try { pages.push(await fetchFn(url)); }
    catch(e) { console.warn(`    ⚠ ${url}: ${e.message}`); }
    if (cfg.useJina) await sleep(1000);
  }
  const text = pages.join("\n\n---\n\n").slice(0, 14000);
  if (!text.trim()) {
    console.warn(`  ⚠ No content for ${name}`);
    return { destination: [], partnership: [], flights: [] };
  }

  const prompt = `You are a competitor intelligence analyst. Analyse scraped text from ${name}'s Malaysia promotion pages.

SCRAPED TEXT:
${text}

Extract every active campaign with full detail. Return ONLY valid JSON — no markdown:
{
  "destination": [
    {
      "name": "exact campaign name as shown",
      "dates_start": "start date or Ongoing",
      "dates_end": "end date or Ongoing",
      "type": "sale|destination|domestic|event|flash|partnership|flights",
      "mechanics": [
        "concise bullet describing one mechanic e.g. Recurring every Monday",
        "50% off flights Mon–Wed",
        "25% off hotels Thu–Sun"
      ],
      "voucher_mechanics": [
        {"code": "PROMO_CODE or No code", "description": "what it does · conditions e.g. 5% off JR East · valid at checkout · no min spend"}
      ],
      "products_focus": ["Flights", "Hotels", "Activities", "Car Rental", "Airport Transfer", "Attractions"],
      "campaign_url": "full URL where this campaign lives",
      "promo": "full promo text with ALL discount amounts",
      "detail": "how the campaign works, restrictions, stacking rules",
      "verified": true
    }
  ],
  "partnership": [...same schema...],
  "flights":     [...same schema...]
}

Rules:
- mechanics: 2–5 concise bullet strings per campaign
- voucher_mechanics: one entry per distinct code; use "No code" if auto-applied
- products_focus: list only what this campaign actually covers
- campaign_url: specific promo page URL if known, else the base promo page
- Be exhaustive — capture every campaign`;

  try {
    const result = parseJSON(await callGroq(prompt));
    const total  = (result.destination?.length||0)+(result.partnership?.length||0)+(result.flights?.length||0);
    if (total === 0 && cfg.useJina) { console.warn(`  ⚠ Jina got 0 campaigns for ${name}, check URL`);
    }
    console.log(`  ✓ ${name}: ${total} campaigns`);
    return result;
  } catch(e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    return { destination: [], partnership: [], flights: [] };
  }
}

function loadStaticFallback(name, filePath) {
  try {
    const raw  = fs.readFileSync(path.join(__dirname, filePath), "utf8");
    const data = JSON.parse(raw);
    const total = (data.destination?.length||0)+(data.partnership?.length||0)+(data.flights?.length||0);
    console.log(`  ✓ ${name}: ${total} campaigns from static file`);
    return data;
  } catch(e) {
    console.error(`  ✗ Static fallback failed: ${e.message}`);
    return { destination: [], partnership: [], flights: [] };
  }
}

// ─── Build Sheets rows ────────────────────────────────────────────────────────
function buildSheetRows(allData, weekLabel) {
  const today    = new Date().toISOString().split("T")[0];
  const CATS     = ["destination","partnership","flights"];
  const CAT_LABELS = { destination:"Destination", partnership:"Partnership", flights:"Flights" };
  const rows = [];

  for (const [compId, cfg] of Object.entries(CONFIG.competitors)) {
    const d = allData[compId] || {};
    for (const cat of CATS) {
      const items = d[cat] || [];
      for (const c of items) {
        // Mechanics: bullet points
        const mechanics = (c.mechanics || []).map(m => `• ${m}`).join("\n");

        // Voucher mechanics: [Code] description, one per line
        const vouchers = (c.voucher_mechanics || [])
          .map(v => `[${v.code}] ${v.description}`)
          .join("\n");

        // Products focus
        const products = (c.products_focus || []).join(" · ");

        rows.push([
          today,                             // A: Date Scraped
          weekLabel,                         // B: Week
          cfg.label,                         // C: Competitor
          CAT_LABELS[cat],                   // D: Category
          c.name        || "",               // E: Campaign Name
          c.type        || "",               // F: Type
          c.dates_start || c.dates || "",    // G: Date Start
          c.dates_end   || c.dates || "",    // H: Date End
          mechanics,                         // I: Mechanics
          vouchers      || "[No code] Auto-applied",  // J: Voucher Mechanics
          products,                          // K: Products Focus
          c.campaign_url|| "",               // L: Campaign URL
          c.promo       || "",               // M: Full Promo
          c.verified ? "📸 Yes" : "No",     // N: Verified
        ]);
      }
    }
  }
  return rows;
}

// ─── Write to Sheets ──────────────────────────────────────────────────────────
async function writeToSheets(rows, tabName) {
  if (!CONFIG.sheetsWebhook) { console.warn("  ⚠ No SHEETS_WEBAPP_URL"); return; }
  console.log(`  Appending ${rows.length} rows to tab "${tabName}"…`);
  const res = await fetch(CONFIG.sheetsWebhook, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ action: "append_rows", tab: tabName, rows }),
    signal:  AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Sheets webhook ${res.status}`);
  const result = await res.json();
  console.log(`  ✓ Sheets: ${result.rowsAdded} rows added to "${tabName}"`);
}

// ─── Monthly analysis ─────────────────────────────────────────────────────────
async function generateMonthlyAnalysis(allData, monthLabel) {
  console.log(`  Generating monthly analysis for ${monthLabel}…`);

  const summary = Object.entries(allData).map(([id, d]) => {
    const cfg = CONFIG.competitors[id];
    const all = [...(d.destination||[]),...(d.partnership||[]),...(d.flights||[])];
    return {
      competitor:    cfg.label,
      total:         all.length,
      destinations:  (d.destination||[]).map(c => c.name),
      partnerships:  (d.partnership||[]).map(c => c.name),
      flights:       (d.flights||[]).map(c => c.name),
      mechanics:     all.flatMap(c => c.mechanics||[]).slice(0, 15),
      products:      [...new Set(all.flatMap(c => c.products_focus||[]))],
      voucher_codes: all.flatMap(c => (c.voucher_mechanics||[]).map(v => v.code)).filter(v => v !== "No code"),
    };
  });

  const prompt = `You are a senior marketing analyst writing a monthly competitor analysis for ${monthLabel}.

DATA:
${JSON.stringify(summary, null, 2)}

Write a comprehensive monthly analysis Lark message. Format:

📊 *Monthly Competitor Analysis — ${monthLabel}*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔵 *Traveloka — ${monthLabel}*
• Campaign volume: [N] campaigns active
• Key mechanic: [most distinctive mechanic this month]
• Products focus: [which verticals they're pushing hardest]
• Pricing strategy: [observations on discount depth, code vs codeless, etc.]
• Notable: [any new or ended campaigns worth flagging]

🟢 *Trip.com — ${monthLabel}*
[same structure]

🔴 *KKday — ${monthLabel}*
[same structure]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 *Monthly observations*
• [cross-competitor observation 1]
• [cross-competitor observation 2]
• [cross-competitor observation 3]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Monthly analysis · ${monthLabel} · Auto-generated_

Rules:
- Be specific with numbers, campaign names, mechanic details
- Observations must be actionable intelligence, not generic statements
- Do NOT mention Klook anywhere

Return ONLY valid JSON:
{
  "lark_message": "full message with \\n newlines",
  "email_subject": "📊 Monthly Competitor Analysis — ${monthLabel}"
}`;

  try {
    const result = parseJSON(await callGroq(prompt, 2000));
    console.log("  ✓ Monthly analysis generated");
    return result;
  } catch(e) {
    console.error(`  ✗ Monthly analysis failed: ${e.message}`);
    return {
      lark_message: `📊 Monthly Competitor Analysis — ${monthLabel}\nGeneration failed. Check GitHub Actions logs.`,
      email_subject: `📊 Monthly Competitor Analysis — ${monthLabel}`,
    };
  }
}

// ─── Build calendar from campaigns ────────────────────────────────────────────
function buildCalendar(allData) {
  const DAYS    = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const DAY_KW  = {
    Mon:["monday","mon–","mon:","every mon"],
    Tue:["tuesday","tue","tues","every tue"],
    Wed:["wednesday","wed","every wed"],
    Thu:["thursday","thu","thurs","every thu"],
    Fri:["friday","fri","every fri"],
    Sat:["saturday","sat","every sat"],
    Sun:["sunday","sun","every sun"],
  };
  const TV_FLASH = {Mon:"50% off flights",Tue:"50% off flights",Wed:"50% off flights",Thu:"25% off hotels & attractions",Fri:"25% off hotels & attractions",Sat:"25% off hotels & attractions",Sun:"25% off hotels & attractions"};
  const TV_TYPE  = {Mon:"flash",Tue:"flash",Wed:"flash",Thu:"destination",Fri:"destination",Sat:"destination",Sun:"destination"};

  const trAll = [...(allData.tripcom?.destination||[]),...(allData.tripcom?.partnership||[]),...(allData.tripcom?.flights||[])];
  const kkAll = [...(allData.kkday?.destination||[]),...(allData.kkday?.partnership||[]),...(allData.kkday?.flights||[])];
  const find  = (arr, kws) => arr.find(c => kws.some(kw => (c.dates_start+" "+c.dates_end+" "+c.promo+" "+c.name).toLowerCase().includes(kw)));

  let trDays = 0, kkDays = 0;
  const cal = DAYS.map(day => {
    const kws    = DAY_KW[day];
    const trDeal = find(trAll, kws);
    const kkDeal = find(kkAll, kws);
    if (trDeal) trDays++;
    if (kkDeal) kkDays++;
    return {
      day,
      tv: TV_FLASH[day], tv_type: TV_TYPE[day],
      tr: trDeal ? trDeal.promo.split("·")[0].trim().slice(0,60) : null, tr_type: trDeal?.type,
      kk: kkDeal ? kkDeal.promo.split("·")[0].trim().slice(0,60) : null, kk_type: kkDeal?.type,
    };
  });

  return { calendar: cal, calendar_note: `Traveloka 7/7 · Trip.com ${trDays}/7 · KKday ${kkDays}/7` };
}

// ─── Key insights ─────────────────────────────────────────────────────────────
async function generateInsights(allData, weekLabel) {
  const prompt = `Write exactly 5 specific key insights about this competitor campaign data for ${weekLabel}.
Data: ${JSON.stringify(Object.entries(allData).map(([id,d])=>({
  competitor: CONFIG.competitors[id].label,
  campaigns:  [...(d.destination||[]),...(d.partnership||[]),...(d.flights||[])].map(c=>c.name),
  mechanics:  [...(d.destination||[]),...(d.partnership||[]),...(d.flights||[])].flatMap(c=>c.mechanics||[]).slice(0,10),
})))}
Rules: specific, with numbers and campaign names. Do NOT mention Klook.
Return ONLY valid JSON: {"insights":["...","...","...","...","..."]}`;
  try {
    return parseJSON(await callGroq(prompt)).insights || [];
  } catch(e) {
    return [
      "Traveloka runs flash deals 7/7 days — strongest daily cadence of any competitor",
      "Trip.com GO CHINA fires every Tuesday 12PM — recurring weekly MY→CN demand window",
      "KKday triple-stacks Japan: NY2JP5 + weekly Aichi 50% + Mid-Year 80% sale",
      "KKday reaches 28M+ MY users via Grab (14M) + TnG (14M) at zero cost",
      "FIFA World Cup live 11 Jun — KKday only competitor with host-city experience packages",
    ];
  }
}

// ─── Save data.json for website ───────────────────────────────────────────────
function saveDataJSON(allData, calendar, calNote, insights, weekLabel) {
  const out = {
    week: weekLabel, generated_at: getMYT()+" MYT",
    generated_at_iso: new Date().toISOString(),
    traveloka: allData.traveloka, tripcom: allData.tripcom, kkday: allData.kkday,
    calendar, insights, calendar_note: calNote,
  };
  const p = path.join(__dirname, "website", "data.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(`  ✓ website/data.json saved (${Math.round(fs.statSync(p).size/1024)}KB)`);
  return out;
}

// ─── Lark ─────────────────────────────────────────────────────────────────────
function buildWeeklyLarkMessage(allData, weekLabel, insights, calNote) {
  const myt   = getMYT();
  const total = Object.values(allData).reduce(
    (s,d) => s+(d.destination?.length||0)+(d.partnership?.length||0)+(d.flights?.length||0), 0
  );
  const COMPS = [{id:"traveloka",label:"🔵 TRAVELOKA"},{id:"tripcom",label:"🟢 TRIP.COM"},{id:"kkday",label:"🔴 KKDAY"}];
  const CATS  = [{key:"destination",label:"🌏 Destination campaigns"},{key:"partnership",label:"🤝 Partnership & payment"},{key:"flights",label:"✈️ Flights & transport"}];

  let msg = `Week: ${weekLabel}  |  Sent: ${myt} MYT  |  Total: ${total} campaigns\n`;
  for (const comp of COMPS) {
    const d     = allData[comp.id]||{};
    const count = (d.destination?.length||0)+(d.partnership?.length||0)+(d.flights?.length||0);
    msg += `\n${comp.label} · ${count} campaigns\n`;
    for (const cat of CATS) {
      const items = d[cat.key]||[];
      if (!items.length) continue;
      msg += `${cat.label}\n`;
      for (const c of items) msg += `• ${c.name} — ${c.promo}${c.verified?" 📸":""}\n`;
    }
  }
  msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚡ Key insights\n`;
  for (const ins of insights) msg += `• ${ins}\n`;
  msg += `\n📸 traveloka.com/en-my · my.trip.com · kkday.com/en-my · ${myt} MYT`;
  return msg;
}

async function sendToLark(message) {
  if (!CONFIG.larkWebhook) { console.warn("  ⚠ No LARK_WEBHOOK_URL"); return; }
  const res = await fetch(CONFIG.larkWebhook, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ msg_type:"text", content:{ text:message } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Lark ${res.status}`);
  console.log("  ✓ Lark sent");
}

// ─── Email ────────────────────────────────────────────────────────────────────
function buildWeeklyEmailHTML(data, weekLabel) {
  const chipCSS = (t) => ({
    sale:"background:#FEE2E2;color:#991B1B", destination:"background:#DBEAFE;color:#1E40AF",
    domestic:"background:#D1FAE5;color:#065F46", event:"background:#EDE9FE;color:#5B21B6",
    flash:"background:#FEF3C7;color:#92400E", partnership:"background:#F3E8FF;color:#6B21A8",
    flights:"background:#E0F2FE;color:#0C4A6E",
  }[t]||"background:#DBEAFE;color:#1E40AF");
  const catLabel = {destination:"🌏 Destination",partnership:"🤝 Partnership",flights:"✈️ Flights"};
  const compSection = (cId,cName,cHex) => {
    const d = data[cId]||{};
    const total = (d.destination?.length||0)+(d.partnership?.length||0)+(d.flights?.length||0);
    let rows = "";
    for (const [cat,label] of Object.entries(catLabel)) {
      const items = d[cat]||[];
      if (!items.length) continue;
      rows += `<tr><td colspan="4" style="padding:9px 12px 3px;font-size:11px;font-weight:800;color:#555;text-transform:uppercase;background:#f9f9f9;">${label}</td></tr>`;
      rows += items.map((c,i) => `<tr style="${i%2===0?"background:#f7f8fa":""}">
        <td style="padding:8px 12px;font-size:13px;font-weight:700;color:#111;border-bottom:1px solid #f0f0f0;width:28%;">${c.name||""}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;width:11%;"><span style="border-radius:20px;padding:2px 7px;font-size:10px;font-weight:700;${chipCSS(c.type)}">${c.type||""}</span></td>
        <td style="padding:8px 12px;font-size:12px;color:#444;border-bottom:1px solid #f0f0f0;">${c.promo||""}</td>
        <td style="padding:8px 12px;font-size:11px;color:#999;border-bottom:1px solid #f0f0f0;white-space:nowrap;">${c.verified?"📸":""} ${c.dates_start||c.dates||""}</td>
      </tr>`).join("");
    }
    return `<div style="background:#fff;margin-top:12px;border-radius:12px;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.07);">
      <div style="background:${cHex};padding:14px 20px;"><span style="font-size:16px;font-weight:900;color:#fff;">${cName}</span><span style="font-size:11px;background:rgba(255,255,255,0.2);color:#fff;border-radius:20px;padding:2px 10px;margin-left:10px;font-weight:700;">${total} campaigns</span></div>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
    </div>`;
  };
  const insightRows = (data.insights||[]).map((ins,i)=>`<tr style="${i>0?"border-top:1px solid #f5f5f5":""}"><td style="padding:9px 0;font-size:18px;width:30px;vertical-align:top;">${["🔥","📅","🌏","🤝","⚡"][i]||"•"}</td><td style="padding:9px 0 9px 10px;font-size:13px;color:#333;line-height:1.6;">${ins}</td></tr>`).join("");
  const myt = getMYT();
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:720px;margin:0 auto;padding:24px 16px;">
  <div style="background:#111;border-radius:14px 14px 0 0;padding:24px 28px;">
    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.12em;font-weight:700;margin-bottom:6px;">Competitor Intelligence · Auto-generated</div>
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:900;color:#fff;">Competitor Campaign Monitor</h1>
    <div style="font-size:13px;color:#aaa;">${weekLabel} · ${myt} MYT</div>
  </div>
  ${compSection("traveloka","🔵 Traveloka","#0A9AF2")}
  ${compSection("tripcom","🟢 Trip.com","#1DA462")}
  ${compSection("kkday","🔴 KKday","#FF6B35")}
  <div style="background:#fff;margin-top:12px;border-radius:12px;padding:18px 20px;box-shadow:0 2px 6px rgba(0,0,0,0.07);">
    <div style="font-size:14px;font-weight:800;color:#111;margin-bottom:14px;">⚡ Key insights</div>
    <table style="width:100%;border-collapse:collapse;">${insightRows}</table>
  </div>
  <div style="margin-top:16px;padding:14px 0;border-top:1px solid #e8e8e8;font-size:11px;color:#bbb;">
    📸 Screenshot-verified · Auto-generated ${myt} MYT
  </div>
</div></body></html>`;
}

function buildMonthlyEmailHTML(larkMessage, monthLabel) {
  const lines = larkMessage.split("\n").map(l => {
    const parts = l.split(/\*(.*?)\*/g);
    return `<div style="font-size:13px;color:#333;line-height:1.8;padding:1px 0;">${parts.map((p,j)=>j%2===1?`<strong>${p}</strong>`:p).join("")}</div>`;
  }).join("");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:680px;margin:0 auto;padding:24px 16px;">
  <div style="background:#1E3A8A;border-radius:14px 14px 0 0;padding:24px 28px;">
    <div style="font-size:10px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:.12em;font-weight:700;margin-bottom:6px;">Monthly Analysis · Auto-generated</div>
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:900;color:#fff;">Competitor Analysis</h1>
    <div style="font-size:13px;color:rgba(255,255,255,0.7);">${monthLabel}</div>
  </div>
  <div style="background:#fff;border-radius:0 0 14px 14px;padding:24px 28px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">${lines}</div>
</div></body></html>`;
}

async function sendEmail(html, subject) {
  if (!CONFIG.gmailUser || !CONFIG.gmailPass) { console.warn("  ⚠ Gmail not configured"); return; }
  const t = nodemailer.createTransport({ service:"gmail", auth:{ user:CONFIG.gmailUser, pass:CONFIG.gmailPass } });
  await t.sendMail({ from:`"Competitor Intel" <${CONFIG.gmailUser}>`, to:CONFIG.recipient, subject, html });
  console.log(`  ✓ Email → ${CONFIG.recipient}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const weekLabel  = getWeekLabel();
  const monthTab   = getMonthTabName();
  const monthLabel = getMonthLabel();
  const t0         = Date.now();
  const isMonthly  = isFirstMondayOfMonth();

  console.log(`\n🚀 Competitor Monitor — ${weekLabel}`);
  console.log(`   Monthly run: ${isMonthly ? "YES — will generate monthly analysis" : "No"}\n`);

  // 1. Scrape
  console.log("Step 1 — Scraping");
  const [traveloka, tripcom] = await Promise.all([
    scrapeCompetitor("traveloka", CONFIG.competitors.traveloka),
    scrapeCompetitor("tripcom",   CONFIG.competitors.tripcom),
  ]);
  await sleep(1000);
  const kkday = await scrapeCompetitor("kkday", CONFIG.competitors.kkday);
  const allData = { traveloka, tripcom, kkday };

  // 2. Insights
  console.log("\nStep 2 — Key insights");
  const insights = await generateInsights(allData, weekLabel);

  // 3. Calendar
  const { calendar, calendar_note } = buildCalendar(allData);

  // 4. Sheets
  console.log(`\nStep 3 — Google Sheets (tab: "${monthTab}")`);
  const sheetRows = buildSheetRows(allData, weekLabel);
  await writeToSheets(sheetRows, monthTab);

  // 5. Save data.json
  console.log("\nStep 4 — Save website/data.json");
  const data = saveDataJSON(allData, calendar, calendar_note, insights, weekLabel);

  // 6. Weekly Lark + Email
  console.log("\nStep 5 — Weekly Lark + Email");
  const weeklyLark = buildWeeklyLarkMessage(allData, weekLabel, insights, calendar_note);
  await sendToLark(weeklyLark);
  const weeklyEmail = buildWeeklyEmailHTML(data, weekLabel);
  await sendEmail(weeklyEmail, `🔍 Competitor Monitor — ${weekLabel} | Traveloka · Trip.com · KKday`);

  // 7. Monthly analysis (first Monday of month only)
  if (isMonthly) {
    console.log(`\nStep 6 — Monthly analysis (${monthLabel})`);
    await sleep(2000);
    const monthly = await generateMonthlyAnalysis(allData, monthLabel);
    await sendToLark(monthly.lark_message);
    const monthlyEmail = buildMonthlyEmailHTML(monthly.lark_message, monthLabel);
    await sendEmail(monthlyEmail, monthly.email_subject);
  }

  console.log(`\n✅ Done in ${((Date.now()-t0)/1000).toFixed(1)}s — ${weekLabel}\n`);
}

main().catch((e) => { console.error("\n❌", e.message); process.exit(1); });
