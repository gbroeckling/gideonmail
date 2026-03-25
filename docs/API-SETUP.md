# API Setup Guide

Step-by-step instructions for each external service GideonMail integrates with. All are optional — GideonMail works as a standalone email client without any of these.

---

## Anthropic (AI Assistant)

**What it does:** Powers the AI assistant — email triage, analysis, reply drafting, smart actions, standing instructions.

**Cost:** ~$0.003 per API call. $5 credit lasts months of normal email use.

### Setup

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an account or sign in
3. Go to **Settings → Billing** and add $5 credit
4. Go to **Settings → API Keys → Create Key**
5. Name it "GideonMail"
6. **Copy the key immediately** — you can only see it once (starts with `sk-ant-`)
7. In GideonMail: **Settings → Anthropic API Key** → paste → **Save**
8. Click **Verify API Key** — should show "Verified!"

### Troubleshooting

- **"Credit balance too low"** — add funds at console.anthropic.com/settings/billing
- **404 model error** — your account may need a specific model. GideonMail uses `claude-haiku-4-5-20251001`
- **Key starts with something other than `sk-ant-`** — you copied the wrong thing. Go back to API Keys and create a new one

---

## Textbelt (SMS Notifications)

**What it does:** Sends text messages when VIP senders email, meetings are detected, conversations you're active in get replies, or AI flags something urgent.

**Cost:** $10 for 1,000 texts to Canada/US. No subscription.

### Setup

1. Go to [textbelt.com](https://textbelt.com)
2. Click **Buy API Key** — pay $10
3. Copy the key you receive
4. In GideonMail: **Settings → Phone Number** → enter your number (digits only, e.g., `6045551234`)
5. **Settings → Textbelt API Key** → paste
6. Click **Save**, then **Send Test SMS**

### SMS Configuration

In **Rules → SMS tab:**
- **Message format** — how emails are summarized in texts
- **Max length** — 160 chars = 1 SMS segment ($0.01)
- **Quiet hours** — no texts between 10pm and 7am (configurable)
- **Rate limits** — max 10/hour, 30/day (configurable)
- **Batch mode** — combine multiple alerts into one text

---

## Google Calendar

**What it does:** Creates calendar events from emails, shows your day's schedule with conflict detection, auto-creates events from Watch list senders.

**Cost:** Free.

### Setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. **APIs & Services → Library** → search "Google Calendar API" → **Enable**
4. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Under **Authorized redirect URIs**, add: `http://localhost:39847/oauth/callback`
7. Click **Create** — copy the **Client ID** and **Client Secret**
8. **APIs & Services → OAuth consent screen**:
   - Add your email under **Test users**
   - Publishing status should be "Testing"
9. In GideonMail: **Settings → Client ID** and **Client Secret** → paste both
10. Click **Save**, then **Connect Google Calendar**
11. Browser opens — approve the Google consent
12. Should show "Connected!" in GideonMail

### Important Notes

- Application type must be **Web application** (not Desktop)
- Redirect URI must be exactly: `http://localhost:39847/oauth/callback`
- You must add yourself as a test user in the OAuth consent screen
- Tokens auto-refresh — stays connected permanently

---

## Security Filter API Keys (Optional)

These enhance the security scanning of unknown sender emails.

### VirusTotal

1. Go to [virustotal.com/gui/join](https://www.virustotal.com/gui/join)
2. Create a free account
3. Go to your profile → **API Key** → copy
4. In GideonMail: **Rules → Security tab → VirusTotal key** → paste → **Save All**

Free tier: 4 lookups/minute, 500/day.

### Google Safe Browsing

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Safe Browsing API**
3. Create an API key under Credentials
4. In GideonMail: **Rules → Security tab → Safe Browsing key** → paste → **Save All**

Free tier: 10,000 lookups/day.

### AbuseIPDB

1. Go to [abuseipdb.com/register](https://www.abuseipdb.com/register)
2. Create a free account
3. Go to **API** → copy your key
4. In GideonMail: **Rules → Security tab → AbuseIPDB key** → paste → **Save All**

Free tier: 1,000 checks/day.
