# Architecture

## Overview

GideonMail is an Electron desktop application with a clear separation between the main process (backend) and renderer process (UI).

```
┌─────────────────────────────────────────────────────┐
│                  Main Process                        │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ ImapFlow │  │Nodemailer│  │  Anthropic SDK    │  │
│  │ (IMAP)   │  │ (SMTP)   │  │  (AI Assistant)  │  │
│  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
│       │              │                 │             │
│  ┌────┴──────────────┴─────────────────┴──────────┐ │
│  │              IPC Handlers (main.js)             │ │
│  │  fetch, send, search, delete, AI, calendar,    │ │
│  │  security, SMS, lists, settings                 │ │
│  └────────────────────┬───────────────────────────┘ │
│                       │                              │
│  ┌────────────────────┴───────────────────────────┐ │
│  │           electron-store (config)               │ │
│  │  Account, API keys, lists, instructions,        │ │
│  │  filters, SMS config, pending appointments      │ │
│  └────────────────────────────────────────────────┘ │
└───────────────────────┬─────────────────────────────┘
                        │ preload.js (IPC bridge)
┌───────────────────────┴─────────────────────────────┐
│                 Renderer Process                     │
│                                                     │
│  ┌─────────────────────────────────────────────────┐│
│  │              app.js (UI Logic)                   ││
│  │  Message list, read pane, compose, AI panel,    ││
│  │  rules modal, people, wizard, calendar          ││
│  └─────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────┐│
│  │              index.html + styles.css            ││
│  │  Layout, modals, dark theme, animations         ││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

## Files

| File | Purpose | Lines |
|------|---------|-------|
| `main.js` | Main process: IMAP, SMTP, AI, SMS, calendar, security, all IPC | ~2400 |
| `preload.js` | IPC bridge — exposes `gideon.*` methods to renderer | ~60 |
| `renderer/app.js` | UI logic: all views, event handlers, rendering | ~1700 |
| `renderer/index.html` | HTML structure: sidebar, panes, modals, wizard | ~300 |
| `renderer/styles.css` | CSS: dark theme, variables, responsive | ~500 |
| `security.js` | 8 security filter implementations | ~300 |
| `google-auth.js` | OAuth 2.0 flow with refresh tokens | ~150 |

## IMAP Connection Strategy

- **Main client** — shared connection for inbox fetch, message read, flag, delete
- **Fresh client** — new connection per AI tool operation (search, bulk delete)
- **Fresh client** — new connection for folder listing
- This prevents mailbox lock contention between the idle loop and AI operations

## Data Storage

All persistent data is in `%APPDATA%/gideonmail/gideonmail-config.json`:

| Key | What |
|-----|------|
| `account` | IMAP/SMTP credentials |
| `anthropic_api_key` | AI API key |
| `textbelt_key` | SMS API key |
| `sms_to` | Phone number |
| `google_client_id/secret` | OAuth credentials |
| `google_refresh_token` | Persistent calendar auth |
| `sms_whitelist` | VIP sender list |
| `ai_watchlist` | Watch sender list |
| `sms_blacklist` | Blocked sender list |
| `sms_greylist` | Muted sender list |
| `ai_instructions` | Standing AI rules |
| `security_filters` | Which filters are enabled |
| `pending_appointments` | Queued meeting detections |
| `sms_sent_uids` | Dedup tracking for SMS |
| `bayesian_data` | Learned spam patterns |

## Security Model

1. Renderer has `contextIsolation: true`, `nodeIntegration: false`
2. All IPC goes through `preload.js` which exposes only specific methods
3. Email HTML rendered in sandboxed iframe
4. Credentials never sent to renderer (masked with ••••••••)
5. Config auto-backed up on every startup (3 rolling backups)
