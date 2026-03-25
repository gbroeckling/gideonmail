# Security Architecture

## Data Privacy

- **No telemetry** — GideonMail sends no data to any server except the ones you configure
- **No cloud sync** — all data stays on your machine
- **Credentials encrypted** — stored via electron-store (OS-level encryption on supported platforms)
- **Email HTML sandboxed** — rendered in an iframe with `sandbox="allow-same-origin"`, no scripts execute
- **Context isolation** — renderer has no access to Node.js; all IPC goes through the preload bridge
- **No `nodeIntegration`** — renderer is a standard web page with no filesystem access

## Network Connections

GideonMail only connects to services you explicitly configure:

| Service | When | What's sent |
|---------|------|------------|
| Your IMAP server | Always | Login credentials, email fetch/search/delete |
| Your SMTP server | When sending | Login credentials, email content |
| Anthropic API | When AI is used | Email subjects/bodies for analysis |
| Textbelt | When SMS triggers | Phone number + message text |
| Google Calendar | When calendar is used | OAuth tokens + event data |
| VirusTotal | When enabled | URLs from email bodies |
| Google Safe Browsing | When enabled | URLs from email bodies |
| AbuseIPDB | When enabled | Sender IP addresses |
| PhishTank | When enabled | URLs from email bodies |
| Spamhaus | When enabled | DNS queries for sender IPs |

## Security Filters

8 scanning layers protect against threats from unknown senders:

1. **SpamAssassin** — server-side scoring (your mail server already does this)
2. **Spamhaus ZEN** — DNS blocklist for sender IPs
3. **VirusTotal** — URL scanning against 70+ antivirus engines
4. **Google Safe Browsing** — URL threat check
5. **PhishTank** — community-reported phishing URLs
6. **AbuseIPDB** — sender IP reputation
7. **ClamAV** — local antivirus for attachments
8. **Bayesian filter** — learns from your delete/flag patterns

### Spam Immunity

Senders on your People list (except Blocked) are immune from spam filters:
- **VIP** — trusted, always delivers
- **Watch** — trusted, AI-monitored
- **Muted** — trusted, silent delivery
- **Blocked** — always scanned, auto-deleted after 7 days
- **Unknown** — scanned by all enabled filters

## Config Backup

GideonMail auto-backs up your configuration on every startup. The last 3 backups are kept in `%APPDATA%/gideonmail/`.

## Single Instance

Only one copy of GideonMail can run at a time. A second launch focuses the existing window.
