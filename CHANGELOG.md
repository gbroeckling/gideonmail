# Changelog

## 0.3.1 — 2026-07-04

### Spam pipeline fixes
- Security scan score ≥ 5 now deletes the email (was: counted but left in inbox)
- Blacklist 7-day cleanup runs every check cycle (was: starved by no-new-mail early returns)
- Persistent log file at `%APPDATA%/gideonmail/gideonmail.log` (2MB rotation) — errors, auto-actions, and skipped scans are no longer console-only
- Bayesian filter now trains automatically: spam from auto-deletions, ham from confident AI classifications

### April feature work (previously uncommitted)
- Low Touch autopilot: AI categorization and auto-actioning of unknown-sender mail with safeguards
- Daily digests, morning briefings, commitment tracking, sender reputation, action emails

## 0.2.0 — 2026-03-25

### AI Assistant
- Claude-powered email triage, analysis, and reply drafting
- Chat interface with full email context
- Email actions: forward, reply, delete, flag, search, bulk delete via AI
- Standing instructions — persistent rules AI follows on every check
- "Save as instruction" button on every AI response
- Meeting detection from VIP emails

### Smart Sender Management
- Unified People list: VIP, Watch, Blocked, Muted roles
- Inline role changes via dropdown
- Watch list with per-sender action toggles (SMS, Calendar, Flag)
- VIP emails highlighted white with badge
- Blocked emails auto-deleted after 7 days
- Color-coded message list by sender role
- Sender status badge in read pane

### SMS Notifications
- Textbelt integration for outbound SMS
- VIP alerts, conversation alerts, AI urgency detection
- Configurable: format, quiet hours, rate limits, batch mode
- Persistent tracking — no duplicate texts across restarts
- Startup lookback catches emails from while app was closed

### Google Calendar
- OAuth 2.0 with permanent refresh tokens
- Task button: AI extracts event → visual day timeline → conflict detection
- Attendee approval before inviting
- Auto-calendar from Watch list senders
- Pending appointments banner with Windows notification
- Meeting detection for VIP emails

### Security
- 8 toggleable filters: SpamAssassin, Spamhaus, VirusTotal, Safe Browsing, PhishTank, AbuseIPDB, ClamAV, Bayesian
- Scan button on any email
- VIP/Watch/Muted immune from spam filters
- API key fields for VirusTotal, Safe Browsing, AbuseIPDB

### Desktop Integration
- System tray with single instance lock
- Start on Windows login (minimized to tray)
- Close dialog: minimize to tray or quit
- Windows notifications for meetings and auto-calendar
- Desktop shortcut creator
- Target + arrow icon

### UI
- Modern 2026 dark theme (charcoal + indigo-violet)
- Setup wizard on first launch
- Help button re-opens wizard
- Three-pane layout with drag-and-drop
- Gradient buttons with hover animation

## 0.1.0 — 2026-03-24

### Initial Release
- Electron desktop email client
- Single IMAP/SMTP account
- Folder browsing, HTML rendering, compose
- Reply, reply all, forward, attachments
- Search, star/flag, pagination
- Dark theme, system tray
