# GideonMail

A clean, fast, stable desktop email client for IMAP/SMTP servers.

Built for people who just want email that works — no cloud sync, no telemetry,
no account linking. Connect to your IMAP/SMTP server and go.

## Features

- Single IMAP/SMTP account (perfect for ISPConfig, Dovecot, Postfix, etc.)
- Folder browsing with auto-detection of Sent, Drafts, Trash, Junk
- Email threading with HTML rendering in a sandboxed iframe
- Compose with rich text, reply, reply all, forward
- File attachments (send and receive)
- Full-text search across subject, from, to, and body
- Star/flag messages
- System tray with unread count badge
- Dark theme
- Auto-refresh with IMAP IDLE keepalive

## Quick start

```bash
git clone https://github.com/gbroeckling/gideonmail.git
cd gideonmail
npm install
npm start
```

On first launch, the Settings dialog opens. Enter your IMAP/SMTP credentials,
click **Test Connection**, then **Save**.

## Requirements

- Node.js 18+
- npm

## Architecture

- **Electron** — desktop shell
- **ImapFlow** — IMAP client (modern, Promise-based)
- **Nodemailer** — SMTP sending
- **mailparser** — email parsing (MIME, HTML, attachments)
- **electron-store** — encrypted local credential storage

All email processing happens in the main process. The renderer communicates
via IPC through a secure preload bridge (`contextIsolation: true`).

## Development

```bash
npm start        # launch the app
npm run dev      # launch with verbose logging
```

Built by **Garry Broeckling**. Implementation is AI-assisted using
**Claude** by Anthropic.

## License

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 Garry Broeckling.
