// GideonMail — Google OAuth 2.0 with refresh tokens
// Handles authorization flow, token refresh, and API calls.

const https = require("https");
const http = require("http");
const { URL } = require("url");

const SCOPES = "https://www.googleapis.com/auth/calendar";
const REDIRECT_PORT = 39847;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth/callback`;

class GoogleAuth {
  constructor(store) {
    this.store = store;
  }

  get clientId() { return this.store.get("google_client_id") || ""; }
  get clientSecret() { return this.store.get("google_client_secret") || ""; }
  get accessToken() { return this.store.get("google_access_token") || ""; }
  get refreshToken() { return this.store.get("google_refresh_token") || ""; }
  get tokenExpiry() { return this.store.get("google_token_expiry") || 0; }

  get isConfigured() { return !!(this.clientId && this.clientSecret); }
  get isConnected() { return !!(this.refreshToken); }

  // ── Start OAuth flow: opens browser, listens for callback ─────────────
  async authorize() {
    if (!this.isConfigured) throw new Error("Set Google Client ID and Secret in Settings first");

    return new Promise((resolve, reject) => {
      // Start local HTTP server to receive the OAuth callback
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
          if (url.pathname !== "/oauth/callback") {
            res.writeHead(404); res.end("Not found"); return;
          }

          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          if (error) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<h2>Authorization failed</h2><p>You can close this window.</p>");
            server.close();
            reject(new Error(error));
            return;
          }

          if (!code) {
            res.writeHead(400); res.end("No code received");
            return;
          }

          // Exchange code for tokens
          const tokens = await this._exchangeCode(code);
          this.store.set("google_access_token", tokens.access_token);
          this.store.set("google_refresh_token", tokens.refresh_token || this.refreshToken);
          this.store.set("google_token_expiry", Date.now() + (tokens.expires_in || 3600) * 1000);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h2 style='color:green'>GideonMail connected to Google Calendar!</h2><p>You can close this window and return to GideonMail.</p>");
          server.close();
          resolve({ ok: true });
        } catch (e) {
          res.writeHead(500); res.end("Error: " + e.message);
          server.close();
          reject(e);
        }
      });

      server.listen(REDIRECT_PORT, () => {
        const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
          client_id: this.clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: SCOPES,
          access_type: "offline",
          prompt: "consent",
        }).toString();

        // Open browser for user consent
        const { shell } = require("electron");
        shell.openExternal(authUrl);
      });

      // Timeout after 2 minutes
      setTimeout(() => {
        server.close();
        reject(new Error("Authorization timed out"));
      }, 120000);
    });
  }

  // ── Exchange auth code for access + refresh tokens ────────────────────
  async _exchangeCode(code) {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString();

    return this._post("https://oauth2.googleapis.com/token", body);
  }

  // ── Refresh the access token ──────────────────────────────────────────
  async refresh() {
    if (!this.refreshToken) throw new Error("No refresh token — authorize first");

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    }).toString();

    const tokens = await this._post("https://oauth2.googleapis.com/token", body);
    this.store.set("google_access_token", tokens.access_token);
    this.store.set("google_token_expiry", Date.now() + (tokens.expires_in || 3600) * 1000);
    return tokens.access_token;
  }

  // ── Get a valid access token (auto-refresh if expired) ────────────────
  async getToken() {
    if (!this.isConnected) throw new Error("Google Calendar not connected. Click 'Connect' in Settings.");

    // Refresh if expired or expiring in next 5 minutes
    if (Date.now() > this.tokenExpiry - 300000) {
      return await this.refresh();
    }

    return this.accessToken;
  }

  // ── Disconnect (clear tokens) ─────────────────────────────────────────
  disconnect() {
    this.store.delete("google_access_token");
    this.store.delete("google_refresh_token");
    this.store.delete("google_token_expiry");
  }

  // ── HTTP POST helper ──────────────────────────────────────────────────
  async _post(url, body) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      }, (res) => {
        let data = "";
        res.on("data", (d) => { data += d; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error_description || parsed.error));
            else resolve(parsed);
          } catch (e) { reject(new Error("Invalid response")); }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = GoogleAuth;
