# Klook MY Competitor Monitor

Runs every **Monday 08:00 MYT** via GitHub Actions.  
Scrapes Traveloka, Trip.com, KKday → **Groq AI** summary → Lark → Email.  
**No Anthropic API needed. Groq is free with no credit card.**

---

## Setup (10 minutes)

### 1. Get a free Groq API key
1. Go to **[console.groq.com](https://console.groq.com)**
2. Sign up (Google/GitHub login, no credit card)
3. API Keys → Create API Key → copy it

### 2. Push to a private GitHub repo
```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOUR_ORG/klook-competitor-monitor.git
git push -u origin main
```

### 3. Add GitHub Secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Where to get it |
|---|---|
| `GROQ_API_KEY` | console.groq.com → API Keys |
| `LARK_WEBHOOK_URL` | Lark channel → Settings → Bots → Custom Bot → copy Webhook URL |
| `GMAIL_USER` | your Gmail e.g. `kengjie.teoh@klook.com` |
| `GMAIL_APP_PASSWORD` | myaccount.google.com → Security → App passwords → create one |
| `RECIPIENT_EMAIL` | who receives the report |

### 4. Get Gmail App Password
1. **[myaccount.google.com/security](https://myaccount.google.com/security)**
2. Enable 2-Step Verification (if not already)
3. Search "App passwords" → Create → Name: "Klook Monitor" → copy 16-char password
4. Paste as `GMAIL_APP_PASSWORD` secret

### 5. Get Lark Webhook
1. Open your `#klook-my-marketing` Lark channel
2. ··· → Settings → Bots → Add Bot → **Custom Bot**
3. Name it "Competitor Monitor" → Create → copy the **Webhook URL**
4. Paste as `LARK_WEBHOOK_URL` secret

### 6. Test it now
Repo → **Actions** tab → "Klook Competitor Monitor" → **Run workflow** → Run workflow

Watch the logs live. First real run: next Monday 08:00 MYT automatically.

---

## Schedule
```yaml
cron: '0 0 * * 1'   →   Monday 00:00 UTC = Monday 08:00 MYT (UTC+8)
```
Edit `.github/workflows/competitor-monitor.yml` to change timing.

## Change AI model
Edit `groqModel` in `index.js`:
- `llama-3.3-70b-versatile` — default, best quality
- `llama-3.1-8b-instant` — faster, lower rate limit pressure
- `mixtral-8x7b-32768` — large context window

## Add more competitors
Add a new key to `CONFIG.competitors` in `index.js`:
```js
mynewcomp: ["https://www.competitor.com/promotions"]
```

## Local test
```bash
export GROQ_API_KEY=gsk_...
export LARK_WEBHOOK_URL=https://open.larksuite.com/open-apis/bot/v2/hook/...
export GMAIL_USER=you@gmail.com
export GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
export RECIPIENT_EMAIL=you@klook.com
npm install
node index.js
```
