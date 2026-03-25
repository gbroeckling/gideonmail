# Features Guide

Complete reference for every GideonMail feature.

---

## Sidebar

| Button | Icon | What it does |
|--------|------|-------------|
| **Compose** | Purple button | Write a new email |
| **Folders** | List | Navigate IMAP folders (drag emails to move) |
| **Rules** | ☰ (green) | Manage People, AI instructions, security, SMS |
| **AI** | ✨ (purple) | Open AI assistant panel |
| **Settings** | ⚙ | Account, API keys, auto-launch |
| **Refresh** | ↻ | Reload inbox |
| **Help** | ? | Re-open setup wizard |

---

## Message List

- **Unread emails** have a purple left border and bold subject
- **VIP emails** appear with white background and "VIP" badge
- **Watch emails** have amber background and "WATCH" badge
- **Blocked emails** have dark red background and "BLOCKED" badge
- **Muted emails** have grey background and "MUTED" badge
- **Drag** any email to a folder in the sidebar to move it

---

## Reading an Email

### Action Bar
| Button | What it does |
|--------|-------------|
| **Reply** | Reply to sender |
| **Reply All** | Reply to all recipients |
| **Forward** | Forward to another address |
| **Delete** | Delete the email (with confirmation) |
| **Star** | Toggle star/flag |
| **Task** | AI extracts event → shows calendar → create event |
| **Scan** | Run security filters on this email |
| **Add sender to...** | Add sender to VIP/Watch/Blocked/Muted |

The **sender status badge** appears next to the dropdown showing which list the sender is currently on.

### Links
Clicking any link in an email opens it in your default browser.

---

## AI Assistant Panel

Open with the ✨ button in the sidebar.

### Quick Actions
- **Triage** — AI reviews your entire inbox and prioritizes every email
- **Analyze** — Summarizes the currently open email with suggested action
- **Draft Reply** — AI writes a reply matching the conversation tone

### Chat
Type any instruction in the chat input:
- "Delete all emails from noreply@spam.com"
- "Forward this to bob@example.com"
- "Search for emails about the quarterly report"
- "Reply saying I'll be there at 3pm"

The AI has full email management tools — it can search, read, forward, reply, delete, flag, and bulk-delete.

### Standing Instructions
Click **Show** under "Standing Instructions" to see and manage your rules:
- Add new rules that the AI follows on every check
- Toggle rules on/off
- Edit or delete rules
- **Save as instruction** button appears on every AI response — one click to make it permanent

---

## People (Rules → People tab)

Unified sender management. Four roles:

| Role | Color | SMS | Spam Filter | Auto-delete | Highlight |
|------|-------|-----|-------------|-------------|-----------|
| **VIP** | Blue | Always | Skipped | No | White bg |
| **Watch** | Amber | Configurable | Skipped | No | Amber bg |
| **Blocked** | Red | Never | Always | After 7 days | Red bg |
| **Muted** | Grey | Never | Skipped | No | Grey bg |

### Watch Actions
Each Watch sender has toggleable actions:
- **SMS** — text you when they email
- **Cal** — auto-create calendar events from their emails
- **Flag** — auto-star their emails

### Adding Senders
- From the People tab: type email/name, select role, click Add
- From any open email: use "Add sender to..." dropdown

### Changing Roles
Each person has a role dropdown — change it inline without removing and re-adding.

---

## Security Filters (Rules → Security tab)

8 filters that scan emails from unknown and blocked senders:

| Filter | Free | What it checks |
|--------|------|---------------|
| SpamAssassin Headers | ✓ (server-side) | Reads existing X-Spam scores |
| Spamhaus ZEN | ✓ | Sender IP against DNS blocklist |
| VirusTotal | ✓ (500/day) | URLs against 70+ antivirus engines |
| Google Safe Browsing | ✓ (10k/day) | URLs against Google's threat database |
| PhishTank | ✓ | URLs against phishing database |
| AbuseIPDB | ✓ (1k/day) | Sender IP reputation |
| ClamAV | ✓ (local) | Attachment antivirus scan |
| Bayesian | ✓ | Learns from your actions over time |

VIP, Watch, and Muted senders are **immune** from spam filters.

### Auto-Check Interval
Controls how often all automated checks run (default: 2 hours). Options: 15min, 30min, 1h, 2h, 4h, 8h, 12h, 24h.

---

## SMS Notifications (Rules → SMS tab)

| Setting | Default | Description |
|---------|---------|-------------|
| Message format | Sender — Subject | How emails appear in texts |
| Max length | 160 chars | 1 SMS segment = $0.01 |
| Prefix | GideonMail | Identifies texts from the app |
| Batch mode | On | Combines multiple alerts into one text |
| Quiet hours | 10pm – 7am | No texts while you sleep |
| Max per hour | 10 | Prevents SMS flood |
| Max per day | 30 | Daily cap |
| Startup lookback | 4 hours | Catches emails from while app was closed |

---

## Google Calendar (Task Button)

When you click **Task** on an email:

1. AI extracts: title, date, time, location, attendees, description
2. Shows a **visual day timeline** with all your existing events
3. **Conflicts** highlighted in red
4. **Proposed event** shown in green
5. If attendees detected, asks for **approval before inviting**
6. Buttons: **Add to Calendar**, **Edit Details**, **Cancel**

### Pending Appointments
When a VIP email looks like a meeting:
- SMS says "MEETING from [sender]: [subject]"
- Windows notification appears
- Amber banner in GideonMail: "Meeting detected — click to add to calendar"

### Auto-Calendar (Watch List)
Watch senders with the "Cal" action enabled get events auto-created. No attendees are invited. A Windows notification confirms each event.

---

## Conversation Alerts (Rules → Convos tab)

Get texted when someone replies to a thread you've been active in.

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | Yes | Toggle on/off |
| Min replies | 2 | How many times you've replied to trigger |
| Lookback | 6 months | How far back to check your sent folder |
| Check interval | 60 min | How often to check (separate from auto-check) |

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **Ctrl+R** | Refresh inbox |
| **Delete** | Delete selected email |

---

## System Tray

GideonMail runs in the system tray when minimized:
- Click tray icon to open
- Right-click for menu: Open, Check Mail, Quit
- Unread count badge on the icon
- Auto-start on Windows login (toggle in Settings)
- Close dialog: "Minimize to Tray" or "Quit"
