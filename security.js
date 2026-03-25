// GideonMail — Security Filters Module
// Scans emails against multiple free threat intelligence sources.

const dns = require("dns").promises;
const https = require("https");

// ── Helper: extract URLs from text/html ─────────────────────────────────
function extractUrls(text) {
  if (!text) return [];
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
  return [...new Set((text.match(urlRegex) || []).map((u) => u.replace(/[.,;:!?)]+$/, "")))];
}

// ── Helper: extract sender IP from Received headers ─────────────────────
function extractSenderIp(headers) {
  if (!headers) return null;
  // Look for the first Received header (outermost = original sender)
  const received = typeof headers === "string" ? headers : (headers["received"] || "");
  const lines = Array.isArray(received) ? received : [received];
  for (const line of lines.reverse()) {
    const match = line.match(/\[(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]/);
    if (match) {
      const ip = match[1];
      // Skip private IPs
      if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("127.")) continue;
      return ip;
    }
  }
  return null;
}

// ── Helper: HTTPS GET/POST ──────────────────────────────────────────────
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: options.headers || {},
      timeout: 10000,
    };
    if (options.body) {
      opts.headers["Content-Type"] = opts.headers["Content-Type"] || "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(options.body);
    }
    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. SpamAssassin Headers
// ═══════════════════════════════════════════════════════════════════════════
function checkSpamAssassin(headers) {
  const result = { score: 0, spam: false, details: "" };
  if (!headers) return result;

  // X-Spam-Status: Yes, score=12.3 required=5.0
  const status = headers["x-spam-status"] || headers["X-Spam-Status"] || "";
  const scoreMatch = status.match(/score=([0-9.-]+)/i);
  if (scoreMatch) {
    result.score = parseFloat(scoreMatch[1]);
    result.spam = status.toLowerCase().startsWith("yes");
    result.details = `SpamAssassin: ${result.score} ${result.spam ? "(SPAM)" : "(clean)"}`;
  }

  // X-Spam-Score header (some servers use this instead)
  const scoreHeader = headers["x-spam-score"] || headers["X-Spam-Score"] || "";
  if (!result.score && scoreHeader) {
    result.score = parseFloat(scoreHeader) || 0;
    result.spam = result.score >= 5;
    result.details = `SpamAssassin: ${result.score}`;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Spamhaus ZEN (DNS blocklist)
// ═══════════════════════════════════════════════════════════════════════════
async function checkSpamhaus(ip) {
  if (!ip) return { listed: false, details: "" };
  try {
    const reversed = ip.split(".").reverse().join(".");
    const lookup = `${reversed}.zen.spamhaus.org`;
    const addresses = await dns.resolve4(lookup);
    // Any result means the IP is listed
    const zones = addresses.map((a) => {
      if (a.startsWith("127.0.0.2")) return "SBL (spam)";
      if (a.startsWith("127.0.0.3")) return "SBL-CSS (spam)";
      if (a.startsWith("127.0.0.4") || a.startsWith("127.0.0.5") || a.startsWith("127.0.0.6") || a.startsWith("127.0.0.7")) return "XBL (exploit)";
      if (a.startsWith("127.0.0.10") || a.startsWith("127.0.0.11")) return "PBL (policy)";
      return a;
    });
    return { listed: true, details: `Spamhaus: ${ip} listed in ${zones.join(", ")}` };
  } catch (e) {
    // NXDOMAIN = not listed (good)
    if (e.code === "ENOTFOUND" || e.code === "ENODATA") return { listed: false, details: "" };
    return { listed: false, details: "" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. VirusTotal (URL + file scanning)
// ═══════════════════════════════════════════════════════════════════════════
async function checkVirusTotal(urls, apiKey) {
  if (!apiKey || !urls.length) return { threats: 0, details: "" };
  const threats = [];
  // Check up to 3 URLs per email to stay within rate limits
  for (const url of urls.slice(0, 3)) {
    try {
      const urlId = Buffer.from(url).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
      const res = await httpsRequest(`https://www.virustotal.com/api/v3/urls/${urlId}`, {
        headers: { "x-apikey": apiKey },
      });
      if (res.status === 200 && res.data?.data?.attributes?.last_analysis_stats) {
        const stats = res.data.data.attributes.last_analysis_stats;
        if (stats.malicious > 0 || stats.suspicious > 0) {
          threats.push(`${url.substring(0, 40)}... (${stats.malicious} malicious, ${stats.suspicious} suspicious)`);
        }
      }
    } catch (e) { /* skip */ }
  }
  return {
    threats: threats.length,
    details: threats.length ? `VirusTotal: ${threats.join("; ")}` : "",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Google Safe Browsing
// ═══════════════════════════════════════════════════════════════════════════
async function checkSafeBrowsing(urls, apiKey) {
  if (!apiKey || !urls.length) return { threats: 0, details: "" };
  try {
    const body = JSON.stringify({
      client: { clientId: "gideonmail", clientVersion: "1.0" },
      threatInfo: {
        threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
        platformTypes: ["ANY_PLATFORM"],
        threatEntryTypes: ["URL"],
        threatEntries: urls.slice(0, 10).map((u) => ({ url: u })),
      },
    });
    const res = await httpsRequest(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`, {
      method: "POST",
      body,
    });
    const matches = res.data?.matches || [];
    return {
      threats: matches.length,
      details: matches.length ? `Safe Browsing: ${matches.length} threat${matches.length > 1 ? "s" : ""} detected` : "",
    };
  } catch (e) {
    return { threats: 0, details: "" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. PhishTank
// ═══════════════════════════════════════════════════════════════════════════
async function checkPhishTank(urls) {
  if (!urls.length) return { phishing: 0, details: "" };
  const hits = [];
  for (const url of urls.slice(0, 3)) {
    try {
      const body = `format=json&url=${encodeURIComponent(url)}`;
      const res = await httpsRequest("https://checkurl.phishtank.com/checkurl/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (res.data?.results?.in_database && res.data.results.valid) {
        hits.push(url.substring(0, 40));
      }
    } catch (e) { /* skip */ }
  }
  return {
    phishing: hits.length,
    details: hits.length ? `PhishTank: ${hits.length} phishing URL${hits.length > 1 ? "s" : ""}` : "",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. AbuseIPDB
// ═══════════════════════════════════════════════════════════════════════════
async function checkAbuseIPDB(ip, apiKey) {
  if (!apiKey || !ip) return { score: 0, details: "" };
  try {
    const res = await httpsRequest(`https://api.abuseipdb.com/api/v2/check?ipAddress=${ip}&maxAgeInDays=90`, {
      headers: { Key: apiKey, Accept: "application/json" },
    });
    const score = res.data?.data?.abuseConfidenceScore || 0;
    return {
      score,
      details: score > 25 ? `AbuseIPDB: ${ip} abuse score ${score}%` : "",
    };
  } catch (e) {
    return { score: 0, details: "" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. ClamAV (local scan via clamdscan)
// ═══════════════════════════════════════════════════════════════════════════
async function checkClamAV(filePath) {
  if (!filePath) return { infected: false, details: "" };
  try {
    const { exec } = require("child_process");
    return new Promise((resolve) => {
      exec(`clamdscan --no-summary "${filePath}"`, { timeout: 30000 }, (err, stdout) => {
        if (err && err.code === 1) {
          // Code 1 = virus found
          resolve({ infected: true, details: `ClamAV: ${stdout.trim()}` });
        } else {
          resolve({ infected: false, details: "" });
        }
      });
    });
  } catch (e) {
    return { infected: false, details: "" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Bayesian Filter (simple token-based)
// ═══════════════════════════════════════════════════════════════════════════
class BayesianFilter {
  constructor(store) {
    this.store = store;
    this.data = store.get("bayesian_data") || { spam: {}, ham: {}, spamCount: 0, hamCount: 0 };
  }

  _tokenize(text) {
    return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((t) => t.length > 2 && t.length < 20);
  }

  train(text, isSpam) {
    const tokens = this._tokenize(text);
    const bucket = isSpam ? "spam" : "ham";
    for (const t of tokens) {
      this.data[bucket][t] = (this.data[bucket][t] || 0) + 1;
    }
    if (isSpam) this.data.spamCount++;
    else this.data.hamCount++;
    this.store.set("bayesian_data", this.data);
  }

  score(text) {
    const tokens = this._tokenize(text);
    const total = this.data.spamCount + this.data.hamCount;
    if (total < 10) return 0.5; // not enough data

    let logScore = 0;
    for (const t of tokens) {
      const spamFreq = (this.data.spam[t] || 0) / Math.max(1, this.data.spamCount);
      const hamFreq = (this.data.ham[t] || 0) / Math.max(1, this.data.hamCount);
      const prob = spamFreq / (spamFreq + hamFreq + 0.0001);
      const clamped = Math.max(0.01, Math.min(0.99, prob));
      logScore += Math.log(1 - clamped) - Math.log(clamped);
    }

    const combined = 1 / (1 + Math.exp(logScore));
    return combined; // 0 = ham, 1 = spam
  }

  check(text) {
    const s = this.score(text);
    return {
      spamProbability: s,
      spam: s > 0.7,
      details: s > 0.7 ? `Bayesian: ${(s * 100).toFixed(0)}% spam probability` : "",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main scan function — runs all enabled filters on a parsed email
// ═══════════════════════════════════════════════════════════════════════════
async function scanEmail(email, headers, filters, apiKeys, bayesian) {
  const results = { flags: [], score: 0, details: [] };

  const bodyText = (email.text || "") + " " + (email.subject || "");
  const urls = extractUrls((email.html || "") + " " + (email.text || ""));
  const senderIp = extractSenderIp(headers);

  // 1. SpamAssassin
  if (filters.spamassassin) {
    const sa = checkSpamAssassin(headers);
    if (sa.spam) { results.flags.push("spamassassin"); results.score += sa.score; }
    if (sa.details) results.details.push(sa.details);
  }

  // 2. Spamhaus
  if (filters.spamhaus && senderIp) {
    const sh = await checkSpamhaus(senderIp);
    if (sh.listed) { results.flags.push("spamhaus"); results.score += 5; }
    if (sh.details) results.details.push(sh.details);
  }

  // 3. VirusTotal
  if (filters.virustotal && urls.length && apiKeys.virustotal) {
    const vt = await checkVirusTotal(urls, apiKeys.virustotal);
    if (vt.threats) { results.flags.push("virustotal"); results.score += vt.threats * 10; }
    if (vt.details) results.details.push(vt.details);
  }

  // 4. Google Safe Browsing
  if (filters.safebrowsing && urls.length && apiKeys.safebrowsing) {
    const sb = await checkSafeBrowsing(urls, apiKeys.safebrowsing);
    if (sb.threats) { results.flags.push("safebrowsing"); results.score += sb.threats * 10; }
    if (sb.details) results.details.push(sb.details);
  }

  // 5. PhishTank
  if (filters.phishtank && urls.length) {
    const pt = await checkPhishTank(urls);
    if (pt.phishing) { results.flags.push("phishtank"); results.score += pt.phishing * 10; }
    if (pt.details) results.details.push(pt.details);
  }

  // 6. AbuseIPDB
  if (filters.abuseipdb && senderIp && apiKeys.abuseipdb) {
    const ab = await checkAbuseIPDB(senderIp, apiKeys.abuseipdb);
    if (ab.score > 25) { results.flags.push("abuseipdb"); results.score += Math.round(ab.score / 10); }
    if (ab.details) results.details.push(ab.details);
  }

  // 8. Bayesian
  if (filters.bayesian && bayesian) {
    const bay = bayesian.check(bodyText);
    if (bay.spam) { results.flags.push("bayesian"); results.score += 3; }
    if (bay.details) results.details.push(bay.details);
  }

  return results;
}

module.exports = {
  scanEmail,
  extractUrls,
  extractSenderIp,
  checkSpamAssassin,
  checkSpamhaus,
  checkVirusTotal,
  checkSafeBrowsing,
  checkPhishTank,
  checkAbuseIPDB,
  checkClamAV,
  BayesianFilter,
};
