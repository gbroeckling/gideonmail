# Setup Guide

GideonMail walks you through setup with a wizard on first launch. This guide covers the same steps in detail.

## Step 1: Email Account

You need an IMAP/SMTP email server. GideonMail works with ISPConfig, Dovecot, Postfix, Zimbra, or any standard IMAP server.

1. Open **Settings** (gear icon in sidebar)
2. Enter your credentials:
   - **Display Name** — shown in sent emails
   - **Email Address** — your full email
   - **Username** — usually your email address
   - **Password** — your email password
   - **IMAP Host** — e.g., `mail.yourdomain.com`
   - **IMAP Port** — typically `143` (STARTTLS) or `993` (SSL)
   - **SMTP Host** — usually same as IMAP
   - **SMTP Port** — typically `587` (STARTTLS) or `465` (SSL)
3. Click **Test IMAP Connection** to verify
4. Click **Save**

### Self-signed certificates
If your server uses a self-signed SSL certificate, GideonMail accepts it automatically (`rejectUnauthorized: false`).

## Step 2: AI Assistant (Optional)

The AI assistant uses Claude by Anthropic to triage, analyze, and manage your email.

See [API Setup](API-SETUP.md#anthropic) for detailed instructions.

**Cost:** ~$0.003 per email triage call. $5 of credit lasts months.

## Step 3: SMS Notifications (Optional)

Get texted when important emails arrive.

See [API Setup](API-SETUP.md#textbelt) for detailed instructions.

**Cost:** $10 for 1,000 texts to Canada/US via Textbelt.

## Step 4: Google Calendar (Optional)

Create calendar events from emails with AI-powered date/time extraction.

See [API Setup](API-SETUP.md#google-calendar) for detailed instructions.

**Cost:** Free.

## Step 5: Set Up Your People

Go to **Rules** (green icon) → **People** tab:

1. Add important contacts as **VIP** — you'll get texted when they email
2. Add contacts you want AI-monitored as **Watch** — auto-analysis on every email
3. Add known spam senders as **Blocked** — auto-deleted after 7 days
4. Add noisy-but-legitimate senders as **Muted** — no notifications, stays in inbox

You can also add senders directly from any open email using the "Add sender to..." dropdown.
