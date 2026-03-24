# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

1. Go to the [Security Advisories](https://github.com/gbroeckling/gideonmail/security/advisories) page.
2. Click **Report a vulnerability**.
3. Describe the issue, impact, and steps to reproduce.
4. Expect a response within **7 days**.
5. Credit will be given in the changelog (you may request anonymity).

## What counts as a security issue

- Credential leakage (passwords stored in plaintext, exposed to renderer)
- Remote code execution via email content (HTML/JS injection escaping sandbox)
- Man-in-the-middle vulnerabilities in TLS handling
- Attachment handling that could execute arbitrary code

## What does not count

- Issues requiring local filesystem access (credentials are stored locally by design)
- Bugs without security impact

## Security posture

- Credentials are stored via `electron-store` (encrypted at rest on supported platforms).
- Email HTML is rendered in a sandboxed iframe (`sandbox="allow-same-origin"`).
- The renderer process has `contextIsolation: true` and `nodeIntegration: false`.
- All IPC between renderer and main process goes through the `preload.js` bridge.
- IMAP/SMTP connections use TLS by default.
