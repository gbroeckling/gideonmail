// GideonMail — Renderer
// Single-account IMAP/SMTP email client

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Help System ─────────────────────────────────────────────────────────
const HELP = {
  "low-touch": {
    title: "Low Touch Autopilot",
    text: `Low Touch mode lets AI manage your email autonomously. When enabled, every new email from unknown senders is categorized (spam, newsletter, receipt, notification, action, meeting, deadline) and acted on automatically.

**What it does:**
• Deletes spam and scams (with 13 safeguards to prevent false positives)
• Files newsletters, receipts, and notifications into folders
• Drafts replies in your voice for emails that need a response (sent to your phone for one-tap approval)
• Auto-unsubscribes from newsletters you never read
• Auto-schedules calendar events from meeting emails
• Sends follow-up nudges when your emails go unanswered

**Safeguards:** First-time senders never get auto-replied to. DKIM/SPF/DMARC is checked. Scam content is AI-detected. Rate limits prevent mass actions. All actions are logged.

**Implications:** This uses your Anthropic API key (~$0.003/email). Emails are sent to Claude for analysis. The AI makes mistakes occasionally — review the Stats tab to see what it's doing.

**Best for:** Busy inboxes, old accounts you don't check, catch-all addresses.`
  },
  "summarize": {
    title: "Summarize Now",
    text: `Generates an instant AI-powered briefing of your current inbox.

**What it does:**
• AI analyzes your 20 most recent emails
• Produces a 3-5 bullet point summary (what needs attention, what can wait, urgent items)
• Suggests sender management actions for unknown senders (block, mute, daily, etc.)
• Sends the summary + recommendations to your phone via SMS
• Sends an action email with per-sender buttons you can tap to act

**Also available:** Right-click the system tray icon → "Summarize Now" to get a summary without opening the app.

**Cost:** One API call (~$0.01) per summary.`
  },
  "customer": {
    title: "Customer (CRM-Lite)",
    text: `Customer is the highest priority role — above VIP. Designed for important business contacts where you need to track projects, action items, and follow-ups.

**What happens when a Customer emails you:**
• Full AI deep analysis of the email (not just category — extracts every action item, question, and deadline)
• Emails are grouped by topic/project (AI detects if it's a new item or continuation)
• Action items tracked per customer with owners (you vs them) and due dates
• Questions asked are extracted and listed
• Sentiment analysis (positive, neutral, negative, urgent)
• Calendar slots included in action email when a meeting is requested
• SMS alert with action item count
• Full customer context in action emails (open items, history)

**Action email includes:**
• AI summary + all action items listed
• Available calendar time slots (next 3 free hours) as one-tap buttons
• Mark Resolved / Needs Follow-up / Reply buttons
• Open items tracker for this customer

**Item tracking:**
• Each email is assigned to a project/item (AI groups related emails)
• Status: open → urgent → pending → resolved
• Action items per item with due dates and ownership
• Customer dashboard in Smart Digest

**Use for:** Clients, key business contacts, anyone where you need to track deliverables and follow-ups across multiple emails.`
  },
  "vip": {
    title: "VIP Senders",
    text: `VIP is the second-highest priority sender role (after Customer). Emails from VIP senders always trigger an SMS text to your phone.

**What happens:**
• Immediate SMS alert with AI summary
• Meeting detection — meetings auto-detected and scheduled on your calendar
• Deadline detection — due dates flagged in the SMS
• DKIM/SPF/DMARC verified — if authentication fails, you get a SPOOF WARNING
• Spam filters are skipped (you trust this sender)
• White background in the inbox

**Use for:** Family, close business contacts, your boss, your accountant — anyone whose email you never want to miss.`
  },
  "watch": {
    title: "Watch List",
    text: `Watch senders get AI analysis on every email with configurable actions.

**What happens:**
• Full AI analysis of every email (summary, urgency, suggested action)
• Configurable per sender: SMS alerts, auto-calendar, flag as important
• Spam filters are skipped
• Amber/gold highlighting in the inbox

**Use for:** Important services (banks auto-detected), key clients, project contacts — senders you want monitored but not at VIP priority.`
  },
  "daily-update": {
    title: "Daily Update",
    text: `Daily Update senders are batched into your morning briefing instead of triggering individual alerts.

**What happens:**
• No individual SMS or notifications
• All emails summarized by AI and included in the morning briefing
• Green highlighting in the inbox
• Spam filters are skipped

**Use for:** Amazon, UPS, PayPal, utility companies — senders whose emails are useful to know about but not urgent. "3 packages shipped, 1 invoice received" in one daily summary.`
  },
  "blocked": {
    title: "Blocked Senders",
    text: `Blocked senders are filtered, quarantined, and auto-deleted after 7 days.

**What happens:**
• Full security filter scan (all 8 layers)
• Never triggers SMS or notifications
• Red highlighting in the inbox
• Auto-deleted after 7 days
• Bayesian filter learns from blocked patterns

**Use for:** Spammers, scammers, persistent marketers, anyone you never want to hear from again.`
  },
  "muted": {
    title: "Muted Senders",
    text: `Muted senders are silently received with no notifications or processing.

**What happens:**
• No SMS, no notifications, no AI analysis
• Spam filters are skipped (you acknowledge this sender)
• Light blue highlighting in the inbox
• Emails stay in inbox untouched

**Use for:** Senders you don't want to block but don't need alerts for. Social media notifications, low-priority mailing lists.`
  },
  "security-filters": {
    title: "Security Filters (6 Layers)",
    text: `Six independent scanning layers protect your inbox from threats. Only emails from unknown and blocked senders are scanned — VIP, Watch, Muted, and Daily Update senders are exempt.

**Layer 0 — DKIM/DMARC/SPF:** Verifies sender authentication. Always runs. Detects spoofed addresses.
**Layer 1 — SpamAssassin:** Reads server-side spam scores from your mail server.
**Layer 2 — Spamhaus ZEN:** DNS blocklist lookup for sender IP.
**Layer 3 — VirusTotal:** Scans URLs against 70+ antivirus engines (needs API key).
**Layer 4 — Google Safe Browsing:** URL threat detection (needs API key).
**Layer 5 — AbuseIPDB:** IP reputation scoring (needs API key).
**Layer 6 — Bayesian:** Pattern-based filter that learns from your actions over time.

**All API keys are free tier.** Most have generous daily limits.`
  },
  "auto-unsub": {
    title: "Auto-Unsubscribe",
    text: `When Low Touch categorizes an email as a newsletter, it automatically unsubscribes you.

**How it works:**
1. Checks for List-Unsubscribe header (RFC 8058) — most reliable
2. Sends mailto: unsubscribe email OR posts to HTTP one-click endpoint
3. If no header exists, scans the email body for unsubscribe links and clicks them

**Safeguard:** The unsubscribe target domain must match the sender domain. This prevents attackers from using fake List-Unsubscribe headers to make you email innocent third parties.

**Implication:** You may miss future emails from unsubscribed senders. If you change your mind, add them to a list (Watch, Daily, etc.) to override.`
  },
  "auto-nudge": {
    title: "Auto Follow-up Nudge",
    text: `When you send an email and don't get a reply within N days, the AI sends a polite follow-up in your voice.

**How it works:**
• Scans your Sent folder for emails older than the configured days
• Checks if the recipient replied (searches inbox for their address)
• If no reply found, AI drafts a natural follow-up using your voice profile
• Sends it automatically

**Safeguard:** Only nudges addresses you have prior interaction history with (opened or replied to their emails before). First-time contacts are never auto-nudged.

**Implication:** The follow-up is sent from your email address. The recipient sees it as a normal email from you.`
  },
  "max-per-cycle": {
    title: "Emails Per Cycle",
    text: `Controls how many emails Low Touch processes in each check cycle (default: every 2 hours).

**Default: 100.** Range: 5–1000.

**Lower values (5-20):** Slower processing, lower API costs, less risk from mistakes.
**Higher values (200-1000):** Catches up faster on backlogs, higher API cost per cycle.

**For reference:** 100 emails × $0.003 = $0.30 per cycle. At 12 cycles/day = $3.60/day. Most accounts process far fewer.`
  },
  "archive-lookback": {
    title: "Archive Lookback",
    text: `Normally Low Touch only processes new unread emails. Archive lookback also processes older read emails that were never categorized.

**Default: 0 (disabled).** Range: 0–365 days.

**Use for:** When you first enable Low Touch on an account with months of uncategorized email. Set to 30 to process the last month, then set back to 0.

**Implication:** Higher values process more emails per cycle and use more API credits. Set temporarily, not permanently.`
  },
  "digest-max": {
    title: "Digest Max Emails",
    text: `Controls how many emails the Smart Digest email includes.

**Default: 60.** Range: 20–500.

Higher values give a more complete daily briefing but make the email longer. For accounts with 500+ daily emails, increase this. For personal accounts, 60 is plenty.`
  },
  "sms-format": {
    title: "SMS Format",
    text: `Controls how sender and subject appear in text message alerts.

• **Sender — Subject:** "Nicole — Meeting Thursday" (default, most context)
• **Subject only:** "Meeting Thursday" (shorter, no sender name)
• **Sender: Subject:** "Nicole: Meeting Thursday" (compact)

Each text costs one Textbelt credit regardless of length (up to 160 chars).`
  },
  "quiet-hours": {
    title: "Quiet Hours",
    text: `SMS alerts are suppressed during quiet hours. Emails are still processed — alerts are just held until quiet hours end.

**Default:** 10 PM to 7 AM.

VIP alerts still process during quiet hours but the SMS is delayed. Meeting detection and calendar events still fire immediately.`
  },
  "conversation-alerts": {
    title: "Conversation Alerts",
    text: `Texts you when someone replies to a thread you've been active in — even if the sender isn't VIP.

**How it works:** Tracks threads where you've replied 2+ times in the last 6 months. When a new reply arrives, you get an SMS.

**Use for:** Staying on top of active discussions without promoting every participant to VIP.

**Implication:** Can be noisy if you reply to many threads. Adjust "min replies" to filter.`
  },
  "action-email": {
    title: "Action Email Relay",
    text: `Control your inbox from your phone without opening the app. GideonMail sends branded HTML emails with one-tap action buttons.

**Each action email includes:**
• AI assessment (summary, sender legitimacy, risk rating)
• Email preview text
• Action buttons: Reply, Approve, Decline, Reschedule, Later, Ignore
• Sender management: VIP, Watch, Daily, Block, Mute

**Security:** Every action email has a unique 12-character verification code. Forged replies are rejected. Processed action emails auto-delete.

**Requires:** An email address you check on your phone (e.g., Gmail).`
  },
  "commitment-tracking": {
    title: "Commitment Tracking",
    text: `AI scans your outgoing emails for promises and tracks them.

**What it catches:** "I'll send that by Friday," "Let me get back to you," "I'll have the numbers by EOD"

**Also tracks incoming:** Promises others make to you. "I'll deliver the files by Wednesday."

**Notifications:** SMS nudge when commitments are due or overdue. Shown in the Smart Digest under "Your Promises" and "Owed to You."

**Implication:** Only runs in Low Touch mode. Scans outgoing emails sent through GideonMail.`
  },
  "reputation": {
    title: "Sender Reputation Learning",
    text: `GideonMail tracks how you interact with each sender and suggests role changes over time.

**Tracked:** Opens, replies, deletes, and ignores (48h+ unopened).

**Suggestions:**
• Deleted >70% → suggest Blocked
• Replied >50% → suggest Watch
• Ignored >80% → suggest Muted

Suggestions appear in the Smart Digest email. You decide — the AI never auto-promotes to VIP.`
  },
  "voice-learning": {
    title: "Voice Learning",
    text: `AI samples your last 20 sent emails to learn your writing style — tone, vocabulary, greetings, sign-offs.

**Used for:** Auto-drafted replies and follow-up nudges that sound like you wrote them.

**Refreshed:** Weekly. Click "Learn My Voice Now" to force a refresh.

**Privacy:** Your sent emails are sent to the Anthropic API for analysis. The voice profile is stored locally.`
  },
  "keyboard-shortcuts": {
    title: "Keyboard Shortcuts",
    text: `**D** — Delete current email
**R** — Reply / open compose
**S** — Star / flag current email
**C** — Compose new email
**J** — Next message
**K** — Previous message
**/** — Focus search bar

Shortcuts are disabled when typing in input fields.`
  },
  "export-import": {
    title: "Export / Import Config",
    text: `**Export:** Saves all your settings, sender lists, standing instructions, and statistics to a single JSON file.

**Import:** Restores settings from an exported file. Overwrites current configuration.

**Use for:**
• Backup before major changes
• Migrating to a new computer
• Moving to Relegate (same config format)
• Sharing configuration between accounts`
  },
  "stats": {
    title: "Statistics",
    text: `Tracks everything GideonMail does automatically:

• Spam/scam blocked and deleted
• Newsletters filed to folders
• Receipts organized
• AI reply drafts created
• Commitments tracked (yours + owed to you)
• Follow-up nudges sent
• Newsletters unsubscribed
• Digest emails sent
• Total inbox checks

Stats are tracked daily, weekly, and all-time. Weekly stats are included in the Smart Digest email.`
  },
  "bulk-actions": {
    title: "Bulk Actions",
    text: `Select multiple emails with checkboxes, then act on all of them at once.

**Select:** Click individual checkboxes, or use "Select All" at the top.
**Actions:** Delete, Mark Read, Flag, Block Sender.

Block Sender collects all unique sender addresses from selected emails and adds them to the Blocked list.`
  },
  "ai-urgency": {
    title: "AI Urgency Triage",
    text: `When enabled, AI scans emails from unknown senders and texts you if any are genuinely urgent.

**Very selective:** Only 1 in 20 emails should trigger. Must be from a real human, require action within hours, and contain a specific request.

**Disabled by default.** Enable only if you want SMS alerts for emails from people not on any list.

**Implication:** Can generate false positives from well-crafted spam. The 13 spam safeguards help but aren't perfect.`
  },
};

async function showHelp(key) {
  const h = HELP[key];
  if (!h) return;

  // Fetch live settings for dynamic help content
  let lt = {}, sms = {}, status = {}, stats = {}, people = [];
  try {
    [lt, sms, status, stats, people] = await Promise.all([
      gideon.lowTouchGet().catch(() => ({})),
      gideon.smsSettingsGet().catch(() => ({})),
      gideon.serviceStatus().catch(() => ({})),
      gideon.statsGet().catch(() => ({ total: {} })),
      gideon.peopleGetAll().catch(() => []),
    ]);
  } catch (e) {}

  const peopleCounts = { vip: 0, watch: 0, daily: 0, blocked: 0, muted: 0 };
  for (const p of people) peopleCounts[p.role] = (peopleCounts[p.role] || 0) + 1;
  const t = stats.total || {};

  // Dynamic status line for each help entry
  const dynStatus = {
    "low-touch": `**Currently:** ${lt.enabled ? "ON" : "OFF"} | ${lt.maxPerCycle || 100} emails/cycle | AI: ${status.hasAI ? "Connected" : "Not configured"}`,
    "summarize": `**AI:** ${status.hasAI ? "Ready" : "Not configured"} | **SMS:** ${status.hasSMS ? "Ready" : "Not configured"} | **Action Email:** ${status.hasActionEmail ? "Ready" : "Not configured"}`,
    "customer": `**Currently:** ${peopleCounts.customer || 0} Customer sender${(peopleCounts.customer || 0) !== 1 ? "s" : ""} configured | AI: ${status.hasAI ? "Ready" : "Required"} | Calendar: ${status.hasCalendar ? "Connected" : "Not connected"} | ${t.customer_emails || 0} customer emails processed`,
    "vip": `**Currently:** ${peopleCounts.vip} VIP sender${peopleCounts.vip !== 1 ? "s" : ""} configured | SMS: ${status.hasSMS ? "Active" : "No phone set"} | Calendar: ${status.hasCalendar ? "Connected" : "Not connected"}`,
    "watch": `**Currently:** ${peopleCounts.watch} Watch sender${peopleCounts.watch !== 1 ? "s" : ""} configured`,
    "daily-update": `**Currently:** ${peopleCounts.daily} Daily Update sender${peopleCounts.daily !== 1 ? "s" : ""} configured`,
    "blocked": `**Currently:** ${peopleCounts.blocked} blocked sender${peopleCounts.blocked !== 1 ? "s" : ""} | ${t.spam_blocked || 0} spam blocked all-time`,
    "muted": `**Currently:** ${peopleCounts.muted} muted sender${peopleCounts.muted !== 1 ? "s" : ""} configured`,
    "security-filters": `**AI:** ${status.hasAI ? "Ready" : "Not configured"} | All-time: ${(t.spam_blocked || 0) + (t.scam_blocked || 0)} threats blocked`,
    "auto-unsub": `**Currently:** ${lt.autoUnsub ? "ON" : "OFF"} | ${t.unsubscribed || 0} newsletters unsubscribed all-time`,
    "auto-nudge": `**Currently:** ${lt.autoNudge ? "ON" : "OFF"} | Nudge after: ${lt.nudgeDays || 5} days | ${t.nudges_sent || 0} nudges sent all-time`,
    "max-per-cycle": `**Currently set to:** ${lt.maxPerCycle || 100} emails per cycle`,
    "archive-lookback": `**Currently set to:** ${lt.archiveLookbackDays || 0} days (${lt.archiveLookbackDays ? "processing older emails" : "new emails only"})`,
    "digest-max": `**Currently set to:** ${lt.digestMaxEmails || 60} emails per digest`,
    "sms-format": `**Current format:** ${sms.format || "sender_subject"} | Max length: ${sms.maxLength || 160} chars | Phone: ${status.hasSMS ? "Configured" : "Not set"}`,
    "quiet-hours": `**Currently:** ${sms.quietStart ?? 22}:00 to ${sms.quietEnd ?? 7}:00`,
    "conversation-alerts": `**SMS:** ${status.hasSMS ? "Active" : "No phone configured"}`,
    "action-email": `**Currently:** ${status.hasActionEmail ? "Enabled" : "Not configured"} | AI: ${status.hasAI ? "Ready" : "Not configured"}`,
    "commitment-tracking": `**Low Touch:** ${lt.enabled ? "ON" : "OFF"} | ${t.commitments_tracked || 0} commitments tracked all-time`,
    "reputation": `**Senders tracked:** ${Object.keys(stats.total || {}).length > 0 ? "Active" : "No data yet"}`,
    "voice-learning": `**Voice profile:** ${lt.voiceProfile ? "Learned" : "Not yet learned"} | AI: ${status.hasAI ? "Ready" : "Not configured"}`,
    "stats": `**All-time:** ${t.spam_blocked || 0} spam blocked, ${t.newsletters_filed || 0} newsletters filed, ${t.drafts_created || 0} drafts, ${t.commitments_tracked || 0} commitments`,
    "ai-urgency": `**Currently:** ${status.hasAI ? "Available" : "Requires AI key"} | SMS: ${status.hasSMS ? "Ready" : "Not configured"}`,
  };

  const statusLine = dynStatus[key] || "";

  // Remove existing help popup
  const existing = document.getElementById("helpPopup");
  if (existing) existing.remove();

  const popup = document.createElement("div");
  popup.id = "helpPopup";
  popup.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:450px;max-height:80vh;overflow-y:auto;background:#1a1a1f;border:1px solid #7c6cff;border-radius:12px;padding:0;z-index:10000;box-shadow:0 20px 60px rgba(0,0,0,0.8)";

  const statusHtml = statusLine ? `<div style="padding:8px 20px;background:#111113;border-bottom:1px solid #2a2a32;font-size:11px;color:#8b8b96">${statusLine.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#a78bfa">$1</strong>')}</div>` : "";

  popup.innerHTML = `
    <div style="background:linear-gradient(135deg,#7c6cff,#6355e0);padding:12px 20px;display:flex;justify-content:space-between;align-items:center;border-radius:11px 11px 0 0">
      <span style="color:#fff;font-size:14px;font-weight:700">${h.title}</span>
      <span id="helpClose" style="color:#e0d4ff;cursor:pointer;font-size:18px;padding:0 4px">&times;</span>
    </div>
    ${statusHtml}
    <div style="padding:16px 20px;color:#e4e4e8;font-size:12px;line-height:1.7;white-space:pre-wrap">${h.text.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#a78bfa">$1</strong>').replace(/•/g, '<span style="color:#7c6cff">•</span>')}</div>
  `;
  document.body.appendChild(popup);
  popup.querySelector("#helpClose").addEventListener("click", () => popup.remove());
  // Close on Escape
  const esc = (e) => { if (e.key === "Escape") { popup.remove(); document.removeEventListener("keydown", esc); } };
  document.addEventListener("keydown", esc);
}

// Global help button click handler
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".help-btn");
  if (btn && btn.dataset.help) {
    e.stopPropagation();
    e.preventDefault();
    if (typeof showHelp === "function") showHelp(btn.dataset.help);
  }
});

let currentFolder = "INBOX";
let currentPage = 0;
let currentMessages = [];
let currentUid = null;
let currentMsg = null;
let composeAttachments = [];
let composeMode = null; // null | "new" | "reply" | "replyall" | "forward"

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  bindEvents();
  bindAIEvents();

  const account = await gideon.getAccount();
  if (!account || !account.imapHost) {
    openSettings();
    return;
  }

  // Delay slightly to let main process IMAP connect first
  await new Promise((r) => setTimeout(r, 1500));

  try {
    await loadFolders();
  } catch (e) {
    console.error("loadFolders failed:", e);
  }
  try {
    await loadMessages();
  } catch (e) {
    console.error("loadMessages failed:", e);
  }
  checkPendingAppointments();
  checkGcalConnection();

  // Check service status and hide/disable features that can't run
  try {
    const status = await gideon.serviceStatus();
    window._serviceStatus = status;

    // No AI — hide/disable AI-dependent features
    if (!status.hasAI) {
      $("#btnSummarizeNow").style.display = "none";
      $("#aiTriage")?.setAttribute("disabled", "true");
      $("#aiAnalyze")?.setAttribute("disabled", "true");
      if ($("#aiTriage")) { $("#aiTriage").style.opacity = "0.4"; $("#aiTriage").title = "Requires AI key (Settings)"; }
      if ($("#aiAnalyze")) { $("#aiAnalyze").style.opacity = "0.4"; $("#aiAnalyze").title = "Requires AI key (Settings)"; }
      // Hide Low Touch toggle (needs AI)
      $("#lowTouchToggle").style.opacity = "0.4";
      $("#lowTouchToggle").title = "Requires AI key (Settings)";
    }

    // No SMS — dim SMS-related indicators
    if (!status.hasSMS) {
      // SMS settings tab still accessible for setup, but note no phone configured
    }

    // No Calendar — hide calendar buttons
    if (!status.hasCalendar) {
      if ($("#btnTask")) { $("#btnTask").style.opacity = "0.4"; $("#btnTask").title = "Requires Google Calendar (Settings)"; }
    }
  } catch (e) {}
}

function bindEvents() {
  $("#btnCompose").addEventListener("click", () => openCompose("new"));
  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnRefresh").addEventListener("click", () => { loadFolders(); loadMessages(); });

  // Summarize Now button
  $("#btnSummarizeNow").addEventListener("click", async () => {
    const btn = $("#btnSummarizeNow");
    btn.textContent = "...";
    btn.disabled = true;
    try {
      const msgs = currentMessages.slice(0, 20);
      if (!msgs.length) { btn.textContent = "No emails"; setTimeout(() => { btn.textContent = "Summarize"; btn.disabled = false; }, 2000); return; }
      const res = await gideon.summarizeNow(msgs);
      if (res.text) {
        // Show in AI panel
        $("#aiPanel").style.display = "flex";
        let html = `<strong style="color:#a78bfa">Inbox Summary</strong><br>${escHtml(res.text).replace(/\n/g, "<br>")}`;
        if (res.recommendations?.length) {
          html += `<br><br><strong style="color:#f59e0b">AI Recommendations (${res.recommendations.length}):</strong>`;
          for (const r of res.recommendations) {
            html += `<br><span style="color:#8b8b96">${escHtml(r.from?.name || r.from?.address)}:</span> <span style="color:#a78bfa">${escHtml(r.suggestedAction)}</span> — ${escHtml(r.recommendation)}`;
          }
          html += `<br><br><span style="font-size:10px;color:#55555e">Summary + recommendations sent to your action email for one-tap execution.</span>`;
        }
        const div = document.createElement("div");
        div.className = "ai-msg assistant";
        div.innerHTML = html;
        $("#aiMessages").appendChild(div);
        $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;
      } else if (res.error) {
        const div = document.createElement("div");
        div.className = "ai-msg assistant";
        div.innerHTML = `<span style="color:var(--danger)">${escHtml(res.error)}</span>`;
        $("#aiMessages").appendChild(div);
      }
    } catch (e) {}
    btn.textContent = "Summarize";
    btn.disabled = false;
  });

  // Low Touch toggle
  async function updateLowTouchUI() {
    const cfg = await gideon.lowTouchGet();
    const dot = $("#lowTouchDot");
    const label = $("#lowTouchLabel");
    if (cfg.enabled) {
      dot.style.background = "#4ade80";
      label.textContent = "Low Touch: ON";
      label.style.color = "#4ade80";
    } else {
      dot.style.background = "#55555e";
      label.textContent = "Low Touch: OFF";
      label.style.color = "var(--fg2)";
    }
  }
  $("#lowTouchToggle").addEventListener("click", async () => {
    // Check if AI is available before enabling
    if (window._serviceStatus && !window._serviceStatus.hasAI) {
      alert("Low Touch mode requires an Anthropic API key.\n\nGo to Settings and add your API key first.");
      return;
    }
    const cfg = await gideon.lowTouchGet();
    const newState = !cfg.enabled;
    if (newState && !confirm("Enable Low Touch mode? (EXPERIMENTAL)\n\nThis lets AI autonomously:\n• Delete spam\n• Archive newsletters\n• File receipts & notifications\n• Draft replies for your approval\n• Create calendar events from meetings\n• Alert you about deadlines\n• Nudge you about unanswered emails\n\nYou stay in control via action emails on your phone.")) return;
    await gideon.lowTouchSet({ enabled: newState });
    updateLowTouchUI();
  });
  updateLowTouchUI();
  $("#btnCheckAll").addEventListener("click", async () => {
    $("#btnCheckAll").textContent = "...";
    $("#btnCheckAll").disabled = true;
    try {
      await loadFolders();
      await loadMessages();
      await gideon.checkNow();
    } catch (e) {}
    $("#btnCheckAll").textContent = "✓";
    $("#btnCheckAll").disabled = false;
  });
  // Legacy pagination buttons (still work as fallback)
  $("#btnPrev").addEventListener("click", () => { if (currentPage > 0) { currentPage--; loadMessages(); } });
  $("#btnNext").addEventListener("click", () => { loadMoreMessages(); });

  // Infinite scroll — load more when near bottom of message list
  $("#messageList").addEventListener("scroll", () => {
    const el = $("#messageList");
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) loadMoreMessages();
  });

  // Search
  let searchTimer;
  $("#searchInput").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => {
      if (q.length >= 2) searchMail(q);
      else loadMessages();
    }, 800);
  });

  // Read pane actions
  $("#btnReply").addEventListener("click", () => openCompose("reply"));
  $("#btnReplyAll").addEventListener("click", () => openCompose("replyall"));
  $("#btnForward").addEventListener("click", () => openCompose("forward"));
  $("#btnDelete").addEventListener("click", deleteCurrent);
  $("#btnStar").addEventListener("click", starCurrent);
  // ── Do Later ──────────────────────────────────────────────────────────
  $("#btnLater").addEventListener("click", async () => {
    if (!currentMsg) return;
    if (!aiOpen) toggleAI();

    addAIMessage(`Schedule time to handle: "${currentMsg.subject}"`, "system");

    // Default: tomorrow 9am, 30 min
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    const chosen = await showTimePicker({
      title: `Review: ${currentMsg.subject}`,
      date: tomorrow,
      startTime: "09:00",
      endTime: "09:30",
    }, []);

    if (!chosen) { addAIMessage("Cancelled.", "system"); return; }

    const r = await gideon.doLater(currentMsg.uid, currentMsg.subject, currentMsg.from?.address);
    if (r.ok) {
      addAIMessage(`Scheduled for ${chosen.date} ${chosen.startTime}–${chosen.endTime}`, "system");
    } else {
      addAIMessage("Failed to schedule: " + (r.error || ""), "error");
    }
  });

  // ── Create Task (Calendar) ──────────────────────────────────────────────
  let taskInProgress = false;
  $("#btnTask").addEventListener("click", async () => {
    if (!currentMsg) return;
    if (taskInProgress) { addAIMessage("A task is already being created. Wait for it to finish.", "system"); return; }
    taskInProgress = true;

    // Open AI panel and show progress there
    if (!aiOpen) toggleAI();
    addAIMessage("Creating calendar event from this email...", "system");

    // Step 1: AI extracts event details + checks if reschedule
    const extracted = await gideon.aiExtractEvent(currentMsg);
    if (extracted.error) {
      addAIMessage("Error extracting event: " + extracted.error, "error");
      taskInProgress = false;
      return;
    }
    const event = extracted.event;

    // Step 1.5: Check if this looks like a reschedule
    let isReschedule = false;
    let existingEventId = null;
    let existingEventTitle = null;
    try {
      const client2 = await gideon.aiChat(
        `Does this email look like a reschedule, change, or update to an existing meeting? Look for words like "reschedule", "moved", "changed", "new time", "updated", "postponed", "pushed back", etc.
Reply with ONLY valid JSON: {"reschedule": true/false, "originalTitle": "title of the original meeting if detectable, or empty string"}

Email from: ${currentMsg.from?.name || currentMsg.from?.address}
Subject: ${currentMsg.subject}`,
        null
      );
      try {
        const parsed = JSON.parse((client2.text || "").match(/\{[\s\S]*\}/)?.[0] || "{}");
        isReschedule = !!parsed.reschedule;
        if (isReschedule && parsed.originalTitle) existingEventTitle = parsed.originalTitle;
      } catch (e) {}
    } catch (e) {}

    // If reschedule, try to find the original event on the calendar
    if (isReschedule) {
      addAIMessage("This looks like a reschedule. Searching your calendar for the original meeting...", "system");

      // Search nearby dates for the matching event
      try {
        const searchDate = event.date || new Date().toISOString().split("T")[0];
        // Look 7 days before and after
        for (let offset = -7; offset <= 7; offset++) {
          const d = new Date(new Date(searchDate + "T12:00:00").getTime() + offset * 86400000);
          const dayStr = d.toISOString().split("T")[0];
          const dayResult = await gideon.gcalGetDay(dayStr);
          if (dayResult.ok && dayResult.events) {
            for (const ev of dayResult.events) {
              const titleMatch = ev.title.toLowerCase().includes((existingEventTitle || event.title).toLowerCase().substring(0, 15)) ||
                (existingEventTitle && ev.title.toLowerCase().includes(existingEventTitle.toLowerCase().substring(0, 15)));
              const senderMatch = ev.description?.toLowerCase().includes((currentMsg.from?.address || "").toLowerCase()) ||
                ev.title.toLowerCase().includes((currentMsg.from?.name || "").toLowerCase().substring(0, 8));
              if (titleMatch || senderMatch) {
                existingEventId = ev.id;
                existingEventTitle = ev.title;
                const evStart = ev.start ? new Date(ev.start).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "?";
                addAIMessage(`Found: "${ev.title}" on ${evStart}`, "system");
                break;
              }
            }
          }
          if (existingEventId) break;
        }
      } catch (e) {}

      if (existingEventId) {
        // Ask user: reschedule or create new?
        const reschedDiv = document.createElement("div");
        reschedDiv.className = "ai-msg system";
        reschedDiv.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";

        const moveBtn = document.createElement("button");
        moveBtn.style.cssText = "padding:4px 12px;background:#92400e;border:1px solid #f59e0b;color:#fef3c7;border-radius:4px;cursor:pointer;font-size:11px";
        moveBtn.textContent = `Move "${existingEventTitle}" to new time`;
        moveBtn.addEventListener("click", async () => {
          reschedDiv.remove();
          addAIMessage("Choose the new time:", "system");
          const newTime = await showTimePicker(event, []);
          if (!newTime) { addAIMessage("Cancelled.", "system"); taskInProgress = false; return; }

          const newStart = `${newTime.date}T${newTime.startTime}:00`;
          const newEnd = `${newTime.date}T${newTime.endTime}:00`;
          const moveResult = await gideon.gcalMoveEvent(existingEventId, newStart, newEnd);
          if (moveResult.ok) {
            addAIMessage(`Rescheduled "${existingEventTitle}" to ${newTime.date} ${newTime.startTime}–${newTime.endTime}`, "system");
          } else {
            addAIMessage("Failed to move: " + (moveResult.error || ""), "error");
          }
          taskInProgress = false;
        });

        const newBtn = document.createElement("button");
        newBtn.style.cssText = "padding:4px 12px;background:var(--bg2);border:1px solid var(--bg3);color:var(--fg2);border-radius:4px;cursor:pointer;font-size:11px";
        newBtn.textContent = "Create new event instead";
        newBtn.addEventListener("click", () => { reschedDiv.remove(); /* fall through to normal flow below */ });

        const cancelBtn = document.createElement("button");
        cancelBtn.style.cssText = "padding:4px 12px;background:var(--bg2);border:1px solid var(--bg3);color:var(--fg2);border-radius:4px;cursor:pointer;font-size:11px";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => { reschedDiv.remove(); taskInProgress = false; addAIMessage("Cancelled.", "system"); });

        reschedDiv.appendChild(moveBtn);
        reschedDiv.appendChild(newBtn);
        reschedDiv.appendChild(cancelBtn);
        $("#aiMessages").appendChild(reschedDiv);
        $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;

        // Wait for user choice — if they click "Move", the handler takes over
        // If they click "Create new", we continue below
        // We need to wait... use a promise
        const userChoice = await new Promise((resolve) => {
          moveBtn.addEventListener("click", () => resolve("move"));
          newBtn.addEventListener("click", () => resolve("new"));
          cancelBtn.addEventListener("click", () => resolve("cancel"));
        });
        if (userChoice === "move" || userChoice === "cancel") return;
        // "new" falls through to normal creation
      } else {
        addAIMessage("Couldn't find the original meeting on your calendar. Creating as a new event.", "system");
      }
    }

    // Step 2: Show extracted details
    let locationText = event.location || "(none)";
    if (event.fullAddress && event.fullAddress !== event.location) {
      locationText = event.fullAddress;
    }

    addAIMessage(
      `Event: ${event.title}\n` +
      `Date: ${event.date}  Time: ${event.startTime} – ${event.endTime}\n` +
      `Location: ${locationText}\n` +
      `Attendees: ${event.attendees?.length ? event.attendees.join(", ") : "(none)"}`,
      "assistant"
    );

    // Show Google Maps link if available
    if (event.mapsLink) {
      const mapsDiv = document.createElement("div");
      mapsDiv.className = "ai-msg system";
      mapsDiv.style.cssText = "cursor:pointer;color:#38bdf8;font-size:11px";
      mapsDiv.textContent = `📍 Open in Google Maps: ${event.fullAddress || event.location}`;
      mapsDiv.addEventListener("click", () => window.open(event.mapsLink));
      $("#aiMessages").appendChild(mapsDiv);
    }

    // Step 3: Fetch and display the day's calendar as a visual timeline
    const dayEvents = await gideon.gcalGetDay(event.date);
    const calDiv = document.createElement("div");
    calDiv.className = "ai-msg assistant";
    calDiv.style.padding = "8px 12px";

    const dayHeader = document.createElement("div");
    dayHeader.style.cssText = "font-weight:700;font-size:12px;color:#f59e0b;margin-bottom:6px";
    dayHeader.textContent = `Your calendar — ${event.date}`;
    calDiv.appendChild(dayHeader);

    const timeline = document.createElement("div");
    timeline.style.cssText = "display:flex;flex-direction:column;gap:2px";

    // Check for conflicts
    const proposedStart = event.startTime || "09:00";
    const proposedEnd = event.endTime || "10:00";
    let hasConflict = false;

    if (dayEvents.ok && dayEvents.events.length > 0) {
      for (const ev of dayEvents.events) {
        const evStart = ev.start ? new Date(ev.start) : null;
        const evEnd = ev.end ? new Date(ev.end) : null;
        const startStr = evStart ? evStart.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "all day";
        const endStr = evEnd ? evEnd.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

        // Check overlap with proposed event
        const evStartHM = evStart ? `${String(evStart.getHours()).padStart(2,"0")}:${String(evStart.getMinutes()).padStart(2,"0")}` : "";
        const evEndHM = evEnd ? `${String(evEnd.getHours()).padStart(2,"0")}:${String(evEnd.getMinutes()).padStart(2,"0")}` : "";
        const isConflict = evStartHM && evEndHM && proposedStart < evEndHM && proposedEnd > evStartHM;
        if (isConflict) hasConflict = true;

        const row = document.createElement("div");
        row.style.cssText = `display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:3px;font-size:11px;${isConflict ? "background:#7f1d1d;border:1px solid #ef4444" : "background:#1e293b"}`;
        row.innerHTML = `<span style="color:${isConflict ? "#fca5a5" : "#94a3b8"};min-width:90px;font-family:monospace">${startStr}${endStr ? " – " + endStr : ""}</span>` +
          `<span style="color:${isConflict ? "#fca5a5" : "var(--fg)"}">${ev.title}</span>` +
          (isConflict ? '<span style="color:#ef4444;font-size:9px;font-weight:700"> CONFLICT</span>' : '');
        timeline.appendChild(row);
      }
    } else {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size:11px;color:#22c55e;padding:4px 0";
      empty.textContent = "No events scheduled — day is free!";
      timeline.appendChild(empty);
    }

    // Show the proposed event in the timeline
    const proposedRow = document.createElement("div");
    proposedRow.style.cssText = `display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:3px;font-size:11px;background:#1a3a0a;border:1px solid #22c55e;margin-top:4px`;
    proposedRow.innerHTML = `<span style="color:#86efac;min-width:90px;font-family:monospace">${proposedStart} – ${proposedEnd}</span>` +
      `<span style="color:#86efac;font-weight:600">${event.title} (NEW)</span>`;
    timeline.appendChild(proposedRow);

    if (hasConflict) {
      const warn = document.createElement("div");
      warn.style.cssText = "font-size:11px;color:#ef4444;font-weight:600;padding:4px 0;margin-top:4px";
      warn.textContent = "⚠ Time conflict detected — consider changing the time";
      timeline.appendChild(warn);
    }

    calDiv.appendChild(timeline);
    $("#aiMessages").appendChild(calDiv);
    $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;

    // Step 3: Attendee approval (if any detected)
    event.attendeesApproved = false;
    if (event.attendees?.length) {
      const attendeeDiv = document.createElement("div");
      attendeeDiv.className = "ai-msg assistant";
      attendeeDiv.style.padding = "8px 12px";

      const attHeader = document.createElement("div");
      attHeader.style.cssText = "font-size:11px;color:#ff9f43;font-weight:600;margin-bottom:4px";
      attHeader.textContent = `${event.attendees.length} attendee${event.attendees.length > 1 ? "s" : ""} detected — invite them?`;
      attendeeDiv.appendChild(attHeader);

      for (const email of event.attendees) {
        const row = document.createElement("div");
        row.style.cssText = "font-size:11px;color:var(--fg2);padding:1px 0";
        row.textContent = `  ${email}`;
        attendeeDiv.appendChild(row);
      }

      const attActions = document.createElement("div");
      attActions.style.cssText = "display:flex;gap:6px;margin-top:6px";

      const inviteBtn = document.createElement("button");
      inviteBtn.style.cssText = "padding:3px 10px;background:#1a3a0a;border:1px solid #4ade80;color:#86efac;border-radius:3px;cursor:pointer;font-size:10px";
      inviteBtn.textContent = "Yes, invite them";
      inviteBtn.addEventListener("click", () => {
        event.attendeesApproved = true;
        inviteBtn.textContent = "Will invite";
        inviteBtn.disabled = true;
        noInviteBtn.disabled = true;
        noInviteBtn.style.opacity = "0.3";
      });

      const noInviteBtn = document.createElement("button");
      noInviteBtn.style.cssText = "padding:3px 10px;background:var(--bg2);border:1px solid var(--bg3);color:var(--fg2);border-radius:3px;cursor:pointer;font-size:10px";
      noInviteBtn.textContent = "No, just my calendar";
      noInviteBtn.addEventListener("click", () => {
        event.attendeesApproved = false;
        noInviteBtn.textContent = "No invites";
        noInviteBtn.disabled = true;
        inviteBtn.disabled = true;
        inviteBtn.style.opacity = "0.3";
      });

      attActions.appendChild(inviteBtn);
      attActions.appendChild(noInviteBtn);
      attendeeDiv.appendChild(attActions);
      $("#aiMessages").appendChild(attendeeDiv);
      $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;
    }

    // Step 4: Interactive time picker
    addAIMessage("Choose your time — click the timeline, change date, or adjust duration:", "system");
    const chosen = await showTimePicker(event, dayEvents.ok ? dayEvents.events : []);
    if (!chosen) { addAIMessage("Cancelled.", "system"); taskInProgress = false; return; }

    // Update event with chosen time
    event.date = chosen.date;
    event.startTime = chosen.startTime;
    event.endTime = chosen.endTime;

    addAIMessage(`Creating: ${event.title}\n${event.date} ${event.startTime}–${event.endTime}`, "system");
    const result = await gideon.gcalCreateEvent(event);
    if (result.ok) {
      addAIMessage(`Event created! ${result.link || ""}`, "system");
    } else {
      addAIMessage("Failed: " + result.error, "error");
      taskInProgress = false;
      return;
    }

    // Post-creation: offer to send a meeting reply to the sender
    const replyOpts = document.createElement("div");
    replyOpts.className = "ai-msg assistant";
    replyOpts.style.padding = "10px 12px";

    const replyHeader = document.createElement("div");
    replyHeader.style.cssText = "font-size:11px;font-weight:600;color:var(--accent);margin-bottom:8px";
    replyHeader.textContent = "Send a meeting confirmation to the sender?";
    replyOpts.appendChild(replyHeader);

    // Meeting type
    const typeRow = document.createElement("div");
    typeRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:11px;color:var(--fg2)";
    typeRow.innerHTML = '<span>Type:</span>';
    const typeSel = document.createElement("select");
    typeSel.style.cssText = "padding:3px 6px;background:var(--bg2);border:1px solid var(--bg3);border-radius:4px;color:var(--fg);font-size:11px";
    for (const [val, label] of [["inperson","In-person"],["teams","Microsoft Teams"],["meet","Google Meet"],["zoom","Zoom"],["phone","Phone call"]]) {
      const o = document.createElement("option"); o.value = val; o.textContent = label; typeSel.appendChild(o);
    }
    typeRow.appendChild(typeSel);
    replyOpts.appendChild(typeRow);

    // Action buttons
    const replyActions = document.createElement("div");
    replyActions.style.cssText = "display:flex;gap:6px;margin-top:6px";

    const sendReplyBtn = document.createElement("button");
    sendReplyBtn.style.cssText = "padding:4px 12px;background:#1a3a0a;border:1px solid #4ade80;color:#86efac;border-radius:4px;cursor:pointer;font-size:11px";
    sendReplyBtn.textContent = "Generate & Send Reply";
    sendReplyBtn.addEventListener("click", async () => {
      sendReplyBtn.disabled = true;
      sendReplyBtn.textContent = "Generating...";

      const meetingType = typeSel.value;
      const locationText = event.fullAddress || event.location || "";
      const mapsLink = event.mapsLink || "";

      // AI generates the reply
      const aiReply = await gideon.aiChat(
        `Write a professional meeting confirmation reply to ${currentMsg.from?.name || currentMsg.from?.address}.
Meeting details:
- Title: ${event.title}
- Date: ${event.date}
- Time: ${event.startTime} – ${event.endTime}
- Type: ${meetingType === "inperson" ? "In-person meeting" : meetingType === "teams" ? "Microsoft Teams video call" : meetingType === "meet" ? "Google Meet video call" : meetingType === "zoom" ? "Zoom video call" : "Phone call"}
${locationText ? "- Location: " + locationText : ""}
${mapsLink ? "- Google Maps: " + mapsLink : ""}

${locationText ? "Include a brief, helpful description of the location (e.g., parking tips, nearby landmarks, which entrance to use — be creative and helpful based on the type of venue)." : ""}
${meetingType !== "inperson" && meetingType !== "phone" ? "Mention that a meeting link will be included in the calendar invite." : ""}

Keep it concise and warm. Sign off as ${(await gideon.getAccount())?.displayName || "me"}.
Only output the reply body, no subject line.`,
        null
      );

      if (aiReply.error) {
        addAIMessage("Error generating reply: " + aiReply.error, "error");
        sendReplyBtn.textContent = "Generate & Send Reply";
        sendReplyBtn.disabled = false;
        return;
      }

      // Show preview
      replyOpts.remove();
      addAIMessage("Reply preview:", "system");
      addAIMessage(aiReply.text, "assistant");

      // Confirm/edit/cancel
      const confirmRow = document.createElement("div");
      confirmRow.className = "ai-msg system";
      confirmRow.style.cssText = "display:flex;gap:6px";

      const confirmSend = document.createElement("button");
      confirmSend.style.cssText = "padding:4px 12px;background:#1a3a0a;border:1px solid #4ade80;color:#86efac;border-radius:4px;cursor:pointer;font-size:11px";
      confirmSend.textContent = "Send Reply";
      confirmSend.addEventListener("click", async () => {
        confirmSend.disabled = true;
        confirmSend.textContent = "Sending...";

        const sendResult = await gideon.sendMail({
          to: currentMsg.from?.address,
          subject: currentMsg.subject?.startsWith("Re:") ? currentMsg.subject : `Re: ${currentMsg.subject}`,
          html: aiReply.text.replace(/\n/g, "<br>"),
          text: aiReply.text,
          inReplyTo: currentMsg.messageId,
        });

        if (sendResult.ok) {
          addAIMessage("Reply sent!", "system");

          // If Teams selected, text the user the meeting link
          if (meetingType === "teams" && result.link) {
            try {
              await gideon.sendMail({ to: (await gideon.getAccount())?.email, subject: "Teams Meeting Link", text: `Teams meeting for: ${event.title}\n${result.link}` });
            } catch (e) {}
            addAIMessage("Teams meeting link sent to your email.", "system");
          }
        } else {
          addAIMessage("Send failed: " + (sendResult.error || ""), "error");
        }
        confirmRow.remove();
        taskInProgress = false;
      });

      const skipSend = document.createElement("button");
      skipSend.style.cssText = "padding:4px 12px;background:var(--bg2);border:1px solid var(--bg3);color:var(--fg2);border-radius:4px;cursor:pointer;font-size:11px";
      skipSend.textContent = "Skip — don't send";
      skipSend.addEventListener("click", () => { confirmRow.remove(); taskInProgress = false; addAIMessage("Reply skipped.", "system"); });

      confirmRow.appendChild(confirmSend);
      confirmRow.appendChild(skipSend);
      $("#aiMessages").appendChild(confirmRow);
      $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;
    });

    const noReplyBtn = document.createElement("button");
    noReplyBtn.style.cssText = "padding:4px 12px;background:var(--bg2);border:1px solid var(--bg3);color:var(--fg2);border-radius:4px;cursor:pointer;font-size:11px";
    noReplyBtn.textContent = "No reply needed";
    noReplyBtn.addEventListener("click", () => { replyOpts.remove(); taskInProgress = false; });

    replyActions.appendChild(sendReplyBtn);
    replyActions.appendChild(noReplyBtn);
    replyOpts.appendChild(replyActions);
    $("#aiMessages").appendChild(replyOpts);
    $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;
  });

  $("#btnAddToList").addEventListener("change", async (e) => {
    const rawVal = e.target.value;
    if (!rawVal || !currentMsg) { e.target.value = ""; return; }
    const addr = currentMsg.from?.address || "";
    const name = currentMsg.from?.name || "";
    if (!addr) { e.target.value = ""; return; }

    const isDomain = rawVal.endsWith("_domain");
    const role = isDomain ? rawVal.replace("_domain", "") : rawVal;
    const domain = addr.includes("@") ? addr.split("@")[1] : "";

    if (isDomain && domain) {
      await gideon.peopleAdd({ address: `@${domain}`, name: `All @${domain}`, role });
    } else {
      await gideon.peopleAdd({ address: addr, name: name, role });
    }
    e.target.value = "";

    // Refresh message list to show new coloring
    await renderMessageList();

    // Brief confirmation
    const prev = e.target.style.borderColor;
    e.target.style.borderColor = "#22c55e";
    setTimeout(() => { e.target.style.borderColor = prev; }, 1500);
  });
  $("#btnScan").addEventListener("click", async () => {
    if (!currentUid) return;
    $("#scanResult").style.display = "block";
    $("#scanResult").textContent = "Scanning...";
    $("#scanResult").style.color = "var(--fg2)";
    const r = await gideon.securityScan(currentUid);
    if (r.error) {
      $("#scanResult").textContent = "Scan error: " + r.error;
      $("#scanResult").style.color = "var(--danger)";
    } else if (r.flags && r.flags.length) {
      $("#scanResult").textContent = "THREATS DETECTED (score: " + r.score + "):\n" + r.details.join("\n");
      $("#scanResult").style.color = "#ef4444";
      $("#scanResult").style.background = "#450a0a";
      $("#scanResult").style.padding = "8px 20px";
      $("#scanResult").style.borderRadius = "4px";
    } else {
      $("#scanResult").textContent = "Clean — no threats detected" + (r.details.length ? "\n" + r.details.join("\n") : "");
      $("#scanResult").style.color = "#22c55e";
    }
  });

  // Compose
  $("#composeClose").addEventListener("click", closeCompose);

  // Compose autocomplete from People list
  let acPeople = [];
  $("#composeTo").addEventListener("focus", async () => {
    acPeople = await gideon.peopleGetAll();
  });
  $("#composeTo").addEventListener("input", () => {
    const val = $("#composeTo").value.toLowerCase().trim();
    const dropdown = $("#composeAutocomplete");
    if (!val || val.length < 2) { dropdown.style.display = "none"; return; }
    const matches = acPeople.filter((p) => p.address?.includes(val) || p.name?.toLowerCase().includes(val)).slice(0, 8);
    if (!matches.length) { dropdown.style.display = "none"; return; }
    dropdown.innerHTML = matches.map((p) =>
      `<div class="ac-item" style="padding:6px 10px;cursor:pointer;font-size:11px;border-bottom:1px solid var(--border);color:var(--fg)" data-addr="${escHtml(p.address)}">
        <span style="font-weight:600">${escHtml(p.name || p.address)}</span>
        ${p.name ? `<span style="color:var(--fg2);margin-left:4px">${escHtml(p.address)}</span>` : ""}
      </div>`
    ).join("");
    dropdown.style.display = "block";
    dropdown.querySelectorAll(".ac-item").forEach((item) => {
      item.addEventListener("click", () => {
        $("#composeTo").value = item.dataset.addr;
        dropdown.style.display = "none";
      });
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#composeTo") && !e.target.closest("#composeAutocomplete")) {
      $("#composeAutocomplete").style.display = "none";
    }
  });
  $("#composeSend").addEventListener("click", sendCompose);
  $("#composeAttach").addEventListener("change", handleAttachFiles);

  // Settings
  $("#settingsClose").addEventListener("click", () => { $("#settingsModal").style.display = "none"; });
  $("#cfgTest").addEventListener("click", testConnection);
  $("#cfgSave").addEventListener("click", saveSettings);
  $("#cfgAiVerify").addEventListener("click", async () => {
    $("#cfgAiResult").textContent = "Verifying...";
    $("#cfgAiResult").style.color = "";
    await saveSettingsQuiet();
    const r = await gideon.aiVerifyKey();
    $("#cfgAiResult").textContent = r.ok ? "Verified!" : "Failed: " + r.message;
    $("#cfgAiResult").style.color = r.ok ? "var(--success)" : "var(--danger)";
  });
  // ── Rules panel ────────────────────────────────────────────────────────
  $("#btnRules").addEventListener("click", openRules);
  $("#rulesClose").addEventListener("click", () => { $("#rulesModal").style.display = "none"; });

  // Tab switching
  for (const tab of $$(".rules-tab")) {
    tab.addEventListener("click", () => {
      $$(".rules-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const sections = { people: "rulesPeople", instructions: "rulesInstructions", security: "rulesSecurity", conversations: "rulesConversations", sms: "rulesSms", lowtouch: "rulesLowtouch", stats: "rulesStats" };
      Object.values(sections).forEach((id) => { const el = $(`#${id}`); if (el) el.style.display = "none"; });
      const target = sections[tab.dataset.tab];
      if (target) $(`#${target}`).style.display = "block";
    });
  }

  // VIP options
  const saveVipOpts = async () => {
    await gideon.vipOptionsSave({
      detectMeetings: $("#cfgVipMeetings").checked,
      autoCalendar: $("#cfgVipAutoCalendar").checked,
      aiReview: $("#cfgVipAiReview").checked,
    });
  };
  $("#cfgVipMeetings").addEventListener("change", saveVipOpts);
  $("#cfgVipAutoCalendar").addEventListener("change", saveVipOpts);
  $("#cfgVipAiReview").addEventListener("change", saveVipOpts);

  // People add
  $("#peopleAddBtn").addEventListener("click", async () => {
    const addr = $("#peopleAddAddr").value.trim();
    if (!addr) return;
    await gideon.peopleAdd({ address: addr, name: $("#peopleAddName").value.trim(), role: $("#peopleAddRole").value });
    $("#peopleAddAddr").value = ""; $("#peopleAddName").value = "";
    renderPeople();
  });
  $("#peopleAddAddr").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#peopleAddBtn").click(); });

  // Instructions add
  $("#instrAddBtn").addEventListener("click", async () => {
    const text = $("#instrAddInput").value.trim();
    if (!text) return;
    await gideon.instructionsAdd(text);
    $("#instrAddInput").value = "";
    renderSettingsInstructions();
  });
  $("#instrAddInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#instrAddBtn").click();
  });

  // Check Now
  $("#rulesCheckNow").addEventListener("click", async () => {
    $("#checkNowResult").textContent = "Checking...";
    const r = await gideon.checkNow();
    $("#checkNowResult").textContent = r.message;
    $("#checkNowResult").style.color = r.ok ? "var(--success)" : "var(--danger)";
  });

  // Rules save all
  $("#rulesSave").addEventListener("click", async () => {
    await saveRulesSettings();
    $("#rulesSave").textContent = "Saved!";
    setTimeout(() => { $("#rulesSave").textContent = "Save All"; }, 1500);
  });

  // Learn Voice button
  $("#btnLearnVoice").addEventListener("click", async () => {
    const btn = $("#btnLearnVoice");
    btn.textContent = "Learning...";
    btn.disabled = true;
    try {
      const res = await gideon.lowTouchLearnVoice();
      if (res.profile) {
        $("#voiceProfilePreview").textContent = res.profile;
        $("#voiceProfilePreview").style.display = "block";
        btn.textContent = "Voice Learned!";
      } else {
        btn.textContent = res.error || "No sent emails found";
      }
    } catch (e) { btn.textContent = "Failed"; }
    setTimeout(() => { btn.textContent = "Learn My Voice Now"; btn.disabled = false; }, 3000);
  });

  $("#cfgConvoTest").addEventListener("click", async () => {
    $("#cfgConvoResult").textContent = "Checking...";
    $("#cfgConvoResult").style.color = "";
    await saveSettingsQuiet();
    const r = await gideon.convoTest();
    $("#cfgConvoResult").textContent = r.message;
    $("#cfgConvoResult").style.color = r.ok ? "var(--success)" : "var(--danger)";
  });
  // Pending appointments
  $("#pendingAction").addEventListener("click", async () => {
    if (!currentPendingUid) return;
    $("#pendingAction").textContent = "Creating...";
    // Open the email and trigger the Task flow
    await openMessage(currentPendingUid);
    await gideon.pendingAppointmentsClear(currentPendingUid);
    // Trigger Task button
    $("#btnTask").click();
    checkPendingAppointments();
  });
  $("#pendingDismiss").addEventListener("click", async () => {
    if (currentPendingUid) await gideon.pendingAppointmentsClear(currentPendingUid);
    checkPendingAppointments();
  });
  gideon.onPendingAppointment(() => checkPendingAppointments());

  // When clicking a Windows notification for a meeting, open that email + Task flow
  gideon.onOpenMeetingTask(async (data) => {
    if (data.uid) {
      await openMessage(data.uid);
      // Small delay to let the message load, then trigger Task
      setTimeout(() => { $("#btnTask").click(); }, 500);
    }
  });

  // ── Keyboard Shortcuts ──────────────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    // Don't fire when typing in inputs/textareas
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
    // Don't fire with modifiers (except shift for range select)
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const key = e.key.toLowerCase();
    if ((key === "d" || e.key === "Delete") && currentMsg) { gideon.deleteMessage(currentMsg.uid, currentFolder); loadMessages(); } // Delete
    else if (key === "r" && currentMsg) { $("#btnReply").click(); } // Reply to current message
    else if (key === "s" && currentMsg) { gideon.toggleFlag(currentMsg.uid, "flagged", currentFolder); } // Star/Flag
    else if (key === "j") { // Next message
      const rows = [...$$(".msg-row")];
      const idx = rows.findIndex((r) => r.classList.contains("active"));
      if (idx < rows.length - 1) rows[idx + 1]?.click();
    }
    else if (key === "k") { // Previous message
      const rows = [...$$(".msg-row")];
      const idx = rows.findIndex((r) => r.classList.contains("active"));
      if (idx > 0) rows[idx - 1]?.click();
    }
    else if (key === "c") { $("#btnCompose").click(); } // Compose
    else if (key === "/") { e.preventDefault(); $("#searchInput").focus(); } // Search
  });

  // ── Bulk Actions ──────────────────────────────────────────────────────
  // selectedUids declared at top level for renderMessageList access
  window._selectedUids = window._selectedUids || new Set();
  const selectedUids = window._selectedUids;

  window._updateBulkToolbar = function updateBulkToolbar() {
    const bar = $("#bulkToolbar");
    if (selectedUids.size > 0) {
      bar.style.display = "flex";
      $("#bulkCount").textContent = `${selectedUids.size} selected`;
    } else {
      bar.style.display = "none";
    }
  }

  $("#selectAll").addEventListener("change", (e) => {
    selectedUids.clear();
    if (e.target.checked) {
      for (const m of currentMessages) selectedUids.add(m.uid);
    }
    $$(".msg-checkbox").forEach((cb) => { cb.checked = e.target.checked; });
    updateBulkToolbar();
  });

  for (const btn of $$(".bulk-btn")) {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action;
      if (!selectedUids.size) return;
      const uids = [...selectedUids];

      if (action === "delete") {
        if (!confirm(`Delete ${uids.length} messages?`)) return;
        for (const uid of uids) { try { await gideon.deleteMessage(uid, currentFolder); } catch (e) {} }
      } else if (action === "read") {
        // Mark read handled by fetchMessage (marks as seen)
        for (const uid of uids) { try { await gideon.fetchMessage(uid); } catch (e) {} }
      } else if (action === "flag") {
        for (const uid of uids) { try { await gideon.toggleFlag(uid, "flagged", currentFolder); } catch (e) {} }
      } else if (action === "block") {
        const addrs = new Set();
        for (const uid of uids) {
          const msg = currentMessages.find((m) => m.uid === uid);
          if (msg?.from?.address) addrs.add(msg.from.address);
        }
        if (!confirm(`Block ${addrs.size} sender(s)?`)) return;
        for (const addr of addrs) {
          await gideon.peopleAdd({ address: addr, name: "", role: "blocked" });
        }
      }

      selectedUids.clear();
      $("#selectAll").checked = false;
      updateBulkToolbar();
      await loadMessages();
    });
  }

  // ── Export/Import Config ──────────────────────────────────────────────
  $("#btnExportConfig").addEventListener("click", async () => {
    const data = {
      account: await gideon.getAccount(),
      people: await gideon.peopleGetAll(),
      instructions: await gideon.instructionsGet(),
      smsConfig: await gideon.smsGetConfig(),
      smsSettings: await gideon.smsSettingsGet(),
      lowTouch: await gideon.lowTouchGet(),
      convo: await gideon.convoGetConfig(),
      securityFilters: await gideon.securityFiltersGet(),
      vipOptions: await gideon.vipOptionsGet(),
      autocheck: await gideon.autocheckGet(),
      stats: await gideon.statsGet(),
      exportDate: new Date().toISOString(),
      version: await gideon.getVersion(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `gideonmail-config-${new Date().toISOString().split("T")[0]}.json`;
    a.click(); URL.revokeObjectURL(url);
    $("#btnExportConfig").textContent = "Exported!";
    setTimeout(() => { $("#btnExportConfig").textContent = "Export Config"; }, 2000);
  });

  $("#btnImportConfig").addEventListener("click", () => { $("#importConfigFile").click(); });
  $("#importConfigFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.exportDate) { alert("Invalid config file"); return; }
      if (!confirm(`Import config from ${data.exportDate}?\n\nThis will overwrite your current settings, sender lists, and instructions.`)) return;
      // Re-import people
      if (data.people) {
        for (const p of data.people) {
          await gideon.peopleAdd({ address: p.address, name: p.name, role: p.role });
        }
      }
      // Re-import instructions
      if (data.instructions) {
        for (const inst of data.instructions) {
          if (inst.text) await gideon.instructionsAdd(inst.text);
        }
      }
      // Re-import settings
      if (data.lowTouch) await gideon.lowTouchSet(data.lowTouch);
      if (data.smsSettings) await gideon.smsSettingsSave(data.smsSettings);
      if (data.convo) await gideon.convoSaveConfig(data.convo);
      if (data.vipOptions) await gideon.vipOptionsSave(data.vipOptions);
      alert("Config imported! Restart the app for all changes to take effect.");
    } catch (err) { alert("Import failed: " + err.message); }
    e.target.value = "";
  });

  // ── Stats Rendering ───────────────────────────────────────────────────
  async function renderStats() {
    const stats = await gideon.statsGet();
    const total = stats.total || {};
    const container = $("#statsContent");
    if (!container) return;

    const statDefs = [
      { key: "spam_blocked", label: "Spam/scam blocked", icon: "🛡", color: "#ef4444" },
      { key: "spam_deleted", label: "Spam deleted", icon: "🗑", color: "#ef4444" },
      { key: "scam_blocked", label: "Scams detected", icon: "⚠", color: "#f59e0b" },
      { key: "newsletters_filed", label: "Newsletters filed", icon: "📰", color: "#3b82f6" },
      { key: "receipts_filed", label: "Receipts filed", icon: "🧾", color: "#22c55e" },
      { key: "drafts_created", label: "Replies drafted", icon: "✏", color: "#a78bfa" },
      { key: "commitments_tracked", label: "Commitments tracked", icon: "📋", color: "#f472b6" },
      { key: "nudges_sent", label: "Follow-ups sent", icon: "📤", color: "#06b6d4" },
      { key: "unsubscribed", label: "Newsletters unsubscribed", icon: "🚫", color: "#64748b" },
      { key: "digests_sent", label: "Digests sent", icon: "📧", color: "#8b5cf6" },
      { key: "emails_processed", label: "Inbox checks", icon: "📬", color: "#94a3b8" },
    ];

    container.innerHTML = statDefs.map((s) => {
      const val = total[s.key] || 0;
      if (!val) return "";
      return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:12px;color:var(--fg2)">${s.icon} ${s.label}</span>
        <span style="font-size:14px;font-weight:700;color:${s.color}">${val.toLocaleString()}</span>
      </div>`;
    }).filter(Boolean).join("") || '<div style="font-size:11px;color:var(--fg2);padding:8px 0">No stats yet. Enable Low Touch and start using the app.</div>';
  }

  // Google Calendar OAuth
  $("#cfgGcalConnect").addEventListener("click", async () => {
    try {
      // Save credentials first
      const id = $("#cfgGcalClientId").value.trim();
      const secret = $("#cfgGcalSecret").value.trim();
      if (!id || id === "••••••••" || !secret || secret === "••••••••") {
        if (!id) { $("#cfgGcalStatus").textContent = "Enter Client ID first"; $("#cfgGcalStatus").style.color = "#ef4444"; return; }
      }
      await gideon.gcalSaveCredentials(id, secret);
      $("#cfgGcalStatus").textContent = "Opening browser...";
      $("#cfgGcalStatus").style.color = "#f59e0b";
      const r = await gideon.gcalAuthorize();
      if (r.ok) {
        $("#cfgGcalStatus").textContent = "Connected!";
        $("#cfgGcalStatus").style.color = "#22c55e";
      } else {
        $("#cfgGcalStatus").textContent = "Failed: " + (r.error || "Unknown error");
        $("#cfgGcalStatus").style.color = "#ef4444";
      }
    } catch (e) {
      $("#cfgGcalStatus").textContent = "Error: " + (e.message || e);
      $("#cfgGcalStatus").style.color = "#ef4444";
    }
  });
  $("#cfgGcalDisconnect").addEventListener("click", async () => {
    await gideon.gcalDisconnect();
    $("#cfgGcalStatus").textContent = "Disconnected";
    $("#cfgGcalStatus").style.color = "#94a3b8";
  });
  $("#cfgAutoLaunch").addEventListener("change", async (e) => {
    await gideon.autolaunchSet(e.target.checked);
  });

  // Active lists — save on change
  for (const listId of ["Customer", "Vip", "Watch", "Daily", "Blocked", "Muted"]) {
    $(`#cfgList${listId}`).addEventListener("change", async () => {
      await gideon.activeListsSet({
        customer: $("#cfgListCustomer").checked,
        vip: $("#cfgListVip").checked,
        watch: $("#cfgListWatch").checked,
        daily: $("#cfgListDaily").checked,
        blocked: $("#cfgListBlocked").checked,
        muted: $("#cfgListMuted").checked,
      });
      window._activeLists = await gideon.activeListsGet();
    });
  }
  $("#cfgSmsTest").addEventListener("click", async () => {
    $("#cfgSmsResult").textContent = "Sending...";
    await saveSettingsQuiet();
    const r = await gideon.smsTest();
    $("#cfgSmsResult").textContent = r.ok ? "Sent!" : "Failed: " + r.error;
    $("#cfgSmsResult").style.color = r.ok ? "var(--success)" : "var(--danger)";
  });

  // Push updates
  gideon.onInboxUpdated((data) => {
    if (data && !data.error && currentFolder === "INBOX") {
      currentMessages = data.messages || [];
      renderMessageList();
    }
  });
}

// ── Folders ─────────────────────────────────────────────────────────────────
async function loadFolders() {
  console.log("loadFolders: starting...");
  let folders;
  try {
    folders = await gideon.listFolders();
  } catch (e) {
    console.error("loadFolders: exception", e);
    return;
  }
  console.log("loadFolders: got", typeof folders, Array.isArray(folders) ? folders.length + " items" : JSON.stringify(folders)?.substring(0, 100));
  // Retry once after 2s if connection wasn't ready
  if (!Array.isArray(folders) || folders.error) {
    console.log("loadFolders: retrying in 2s...");
    await new Promise((r) => setTimeout(r, 2000));
    try { folders = await gideon.listFolders(); } catch (e) { console.error("loadFolders retry failed:", e); return; }
    console.log("loadFolders: retry got", typeof folders, Array.isArray(folders) ? folders.length + " items" : "not array");
  }
  if (!Array.isArray(folders) || !folders.length) { console.log("loadFolders: no folders to show"); return; }

  const list = $("#folderList");
  list.innerHTML = "";

  // Preferred order
  const priority = ["INBOX", "Sent", "Drafts", "Trash", "Junk", "Spam", "Archive"];
  const sorted = [...folders].sort((a, b) => {
    const ai = priority.findIndex((p) => a.path.toUpperCase().includes(p.toUpperCase()));
    const bi = priority.findIndex((p) => b.path.toUpperCase().includes(p.toUpperCase()));
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.path.localeCompare(b.path);
  });

  for (const f of sorted) {
    const div = document.createElement("div");
    div.className = "folder-item" + (f.path === currentFolder ? " active" : "");
    const hasUnread = f.unseen > 0;
    const nameColor = hasUnread ? "color:#a78bfa;font-weight:600" : "";
    const badge = hasUnread ? ` <span style="color:#a78bfa;font-size:10px;opacity:0.8">(${f.unseen})</span>` : "";
    div.innerHTML = `<span style="${nameColor}">${escHtml(f.name)}${badge}</span>`;
    div.addEventListener("click", () => {
      currentFolder = f.path;
      currentPage = 0;
      loadMessages();
      loadFolders();
    });

    // Drop target for drag-and-drop
    div.addEventListener("dragover", (e) => {
      e.preventDefault();
      div.style.background = "#1a3a2a";
      div.style.borderColor = "#22c55e";
    });
    div.addEventListener("dragleave", () => {
      div.style.background = "";
      div.style.borderColor = "";
    });
    div.addEventListener("drop", async (e) => {
      e.preventDefault();
      div.style.background = "";
      div.style.borderColor = "";
      const uid = e.dataTransfer.getData("text/uid");
      const srcFolder = e.dataTransfer.getData("text/folder");
      if (!uid || f.path === srcFolder) return;
      div.style.background = "#0f2a1a";
      const result = await gideon.moveMessage(parseInt(uid), srcFolder, f.path);
      if (result.ok) {
        loadMessages();
        div.style.background = "";
      } else {
        div.style.background = "#2a0a0a";
        setTimeout(() => { div.style.background = ""; }, 1000);
      }
    });

    list.appendChild(div);
  }
}

// ── Message list with infinite scroll ────────────────────────────────────
let _loadingMore = false;
let _allLoaded = false;
let _totalMessages = 0;

async function loadMessages() {
  if ($("#calendarPane").style.display !== "none") showCalendar(false);
  currentPage = 0;
  _allLoaded = false;

  let result = currentFolder === "INBOX"
    ? await gideon.fetchInbox(currentPage)
    : await gideon.fetchFolder(currentFolder, currentPage);

  // Retry once after 2s if connection wasn't ready
  if (result.error) {
    await new Promise((r) => setTimeout(r, 2000));
    result = currentFolder === "INBOX"
      ? await gideon.fetchInbox(currentPage)
      : await gideon.fetchFolder(currentFolder, currentPage);
  }

  if (result.error) {
    $("#messageList").innerHTML = `<div class="placeholder" style="font-size:12px;color:#ef4444">${escHtml(result.error)}</div>`;
    return;
  }

  currentMessages = result.messages || [];
  _totalMessages = result.total || 0;

  await renderMessageList();
  $("#messageList").scrollTop = 0; // fresh folder/refresh always starts at top

  // Pagination info
  $("#btnPrev").disabled = true;
  $("#btnNext").disabled = true;
  _updatePageInfo();
}

async function loadMoreMessages() {
  if (_loadingMore || _allLoaded) return;
  if (currentMessages.length >= _totalMessages) { _allLoaded = true; return; }

  _loadingMore = true;

  try {
    // Load 2 pages (100 emails) at a time for smoother scrolling
    const allNew = [];
    for (let i = 0; i < 2; i++) {
      currentPage++;
      if ((currentPage) * 50 >= _totalMessages) break;

      const result = currentFolder === "INBOX"
        ? await gideon.fetchInbox(currentPage)
        : await gideon.fetchFolder(currentFolder, currentPage);

      const newMsgs = result.messages || [];
      if (!newMsgs.length) { _allLoaded = true; break; }
      allNew.push(...newMsgs);
    }

    if (!allNew.length) { _allLoaded = true; return; }

    // Append to existing messages (avoid duplicates by UID)
    const existingUids = new Set(currentMessages.map((m) => m.uid));
    const unique = allNew.filter((m) => !existingUids.has(m.uid));
    currentMessages = currentMessages.concat(unique);

    // Append to DOM instead of full re-render
    await renderAppendedMessages(unique);
    _updatePageInfo();
  } catch (e) {
    // revert on failure
  } finally {
    _loadingMore = false;
  }
}

function _updatePageInfo() {
  const showing = currentMessages.length;
  $("#pageInfo").textContent = _totalMessages > 0 ? `${showing} of ${_totalMessages}` : "Empty";
  $("#btnPrev").disabled = true;
  $("#btnNext").disabled = _allLoaded || showing >= _totalMessages;
}

async function renderAppendedMessages(newMsgs) {
  const list = $("#messageList");
  const gen = _listRenderGen;
  let newStatuses = {};
  try {
    newStatuses = await gideon.senderStatusBulk(newMsgs) || {};
  } catch (e) {}
  if (gen !== _listRenderGen) return; // a full re-render superseded this append (it already includes these rows)
  // Merge into global
  Object.assign(senderStatuses, newStatuses);

  for (const m of newMsgs) {
    const status = senderStatuses[m.from?.address] || null;
    const div = document.createElement("div");
    div.className = "msg-row" + (!m.seen ? " unread" : "") + (m.uid === currentUid ? " active" : "");

    if (status === "customer") { div.style.cssText = "background:#d1fae5;color:#111113;border-left:3px solid #10b981"; }
    else if (status === "whitelist") { div.style.cssText = "background:#f0f0f2;color:#111113;border-left:3px solid #7c6cff"; }
    else if (status === "watch") { div.style.cssText = "background:#1c1a10;color:#fef3c7;border-left:3px solid #ff9f43"; }
    else if (status === "blacklist") { div.style.cssText = "background:#1a0a0a;color:#fecaca;border-left:3px solid #f06060"; }
    else if (status === "greylist") { div.style.cssText = "background:#1a1a1f;color:#7dd3fc;border-left:3px solid #38bdf8"; }
    else if (status === "daily") { div.style.cssText = "background:#0a1a12;color:#86efac;border-left:3px solid #22c55e"; }

    const subjectColor = status === "customer" ? "color:#111" : status === "whitelist" ? "color:#2a2a32" : status === "watch" ? "color:#fbbf24" : status === "blacklist" ? "color:#fca5a5" : status === "greylist" ? "color:#7dd3fc" : status === "daily" ? "color:#86efac" : "";
    const fromColor = status === "customer" ? "color:#059669" : status === "whitelist" ? "color:#444" : status === "watch" ? "color:#ff9f43" : status === "greylist" ? "color:#38bdf8" : status === "daily" ? "color:#4ade80" : "";
    const dateColor = status === "whitelist" ? "color:#666" : "";
    const badge = status === "customer" ? '<span style="color:#10b981;font-size:10px;font-weight:600">CUSTOMER</span>'
      : status === "whitelist" ? '<span style="color:#7c6cff;font-size:10px;font-weight:600">VIP</span>'
      : status === "watch" ? '<span style="color:#ff9f43;font-size:10px">WATCH</span>'
      : status === "blacklist" ? '<span style="color:#f06060;font-size:10px">BLOCKED</span>'
      : status === "greylist" ? '<span style="color:#38bdf8;font-size:10px">MUTED</span>'
      : status === "daily" ? '<span style="color:#4ade80;font-size:10px">DAILY</span>'
      : "";

    div.innerHTML = `
      <div class="msg-top">
        <input type="checkbox" class="msg-checkbox" data-uid="${m.uid}" style="margin-right:4px;cursor:pointer;width:auto;flex:none" ${(window._selectedUids || new Set()).has(m.uid) ? "checked" : ""} />
        <span class="msg-from" style="${fromColor};flex:1">${escHtml(m.from?.name || m.from?.address || "Unknown")}</span>
        <span class="msg-date" style="${dateColor}">${formatDate(m.date)}</span>
      </div>
      <div class="msg-subject" style="${subjectColor}">${escHtml(m.subject)}</div>
      <div class="msg-icons">
        ${m.flagged ? '<span class="star">&#9733;</span>' : ""}
        ${m.hasAttachments ? '<span class="clip">&#128206;</span>' : ""}
        ${badge}
      </div>
    `;
    div.querySelector(".msg-checkbox").addEventListener("click", (e) => {
      e.stopPropagation();
      const _sel = window._selectedUids || new Set();
      if (e.target.checked) _sel.add(m.uid); else _sel.delete(m.uid);
      if (window._updateBulkToolbar) window._updateBulkToolbar();
    });
    div.addEventListener("click", (e) => { if (e.target.classList.contains("msg-checkbox")) return; openMessage(m.uid); });
    list.appendChild(div);
  }
}

let senderStatuses = {};
let _listRenderGen = 0; // serializes concurrent list renders (star, inbox push, search)

async function renderMessageList() {
  const list = $("#messageList");
  const prevScroll = list.scrollTop; // preserve position across re-renders (inbox updates, star, etc.)
  const gen = ++_listRenderGen;

  // Bulk fetch sender list statuses for coloring — BEFORE clearing the list: an empty
  // list mid-await resets scroll to 0 and falsely triggers the infinite-scroll handler
  try {
    senderStatuses = await gideon.senderStatusBulk(currentMessages) || {};
  } catch (e) { senderStatuses = {}; }
  if (gen !== _listRenderGen) return; // superseded by a newer render
  list.innerHTML = "";

  for (const m of currentMessages) {
    const status = senderStatuses[m.from?.address] || null;
    const div = document.createElement("div");
    div.className = "msg-row" + (!m.seen ? " unread" : "") + (m.uid === currentUid ? " active" : "");

    // Color based on list membership
    if (status === "customer") {
      div.style.cssText = "background:#d1fae5;color:#111113;border-left:3px solid #10b981";
    } else if (status === "whitelist") {
      div.style.cssText = "background:#f0f0f2;color:#111113;border-left:3px solid #7c6cff";
    } else if (status === "watch") {
      div.style.cssText = "background:#1c1a10;color:#fef3c7;border-left:3px solid #ff9f43";
    } else if (status === "blacklist") {
      div.style.cssText = "background:#1a0a0a;color:#fecaca;border-left:3px solid #f06060";
    } else if (status === "greylist") {
      div.style.cssText = "background:#1a1a1f;color:#7dd3fc;border-left:3px solid #38bdf8";
    } else if (status === "daily") {
      div.style.cssText = "background:#0a1a12;color:#86efac;border-left:3px solid #22c55e";
    }

    const subjectColor = status === "customer" ? "color:#f9a8d4" : status === "whitelist" ? "color:#2a2a32" : status === "watch" ? "color:#fbbf24" : status === "blacklist" ? "color:#fca5a5" : status === "greylist" ? "color:#7dd3fc" : status === "daily" ? "color:#86efac" : "";
    const fromColor = status === "customer" ? "color:#ec4899" : status === "whitelist" ? "color:#444" : status === "watch" ? "color:#ff9f43" : status === "greylist" ? "color:#38bdf8" : status === "daily" ? "color:#4ade80" : "";
    const dateColor = status === "whitelist" ? "color:#666" : "";
    const badge = status === "customer" ? '<span style="color:#ec4899;font-size:10px;font-weight:600">CUSTOMER</span>'
      : status === "whitelist" ? '<span style="color:#7c6cff;font-size:10px;font-weight:600">VIP</span>'
      : status === "watch" ? '<span style="color:#ff9f43;font-size:10px">WATCH</span>'
      : status === "blacklist" ? '<span style="color:#f06060;font-size:10px">BLOCKED</span>'
      : status === "greylist" ? '<span style="color:#38bdf8;font-size:10px">MUTED</span>'
      : status === "daily" ? '<span style="color:#4ade80;font-size:10px">DAILY</span>'
      : "";

    div.innerHTML = `
      <div class="msg-top">
        <input type="checkbox" class="msg-checkbox" data-uid="${m.uid}" style="margin-right:4px;cursor:pointer" ${(window._selectedUids || new Set()).has(m.uid) ? "checked" : ""} />
        <span class="msg-from" style="${fromColor};flex:1">${escHtml(m.from?.name || m.from?.address || "Unknown")}</span>
        <span class="msg-date" style="${dateColor}">${formatDate(m.date)}</span>
      </div>
      <div class="msg-subject" style="${subjectColor}">${escHtml(m.subject)}</div>
      <div class="msg-icons">
        ${m.flagged ? '<span class="star">&#9733;</span>' : ""}
        ${m.hasAttachments ? '<span class="clip">&#128206;</span>' : ""}
        ${badge}
      </div>
    `;
    // Checkbox click
    div.querySelector(".msg-checkbox").addEventListener("click", (e) => {
      e.stopPropagation();
      const _sel = window._selectedUids || new Set();
      if (e.target.checked) _sel.add(m.uid); else _sel.delete(m.uid);
      if (window._updateBulkToolbar) window._updateBulkToolbar();
    });
    div.addEventListener("click", (e) => { if (e.target.classList.contains("msg-checkbox")) return; openMessage(m.uid); });

    // Draggable for move-to-folder
    div.draggable = true;
    div.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/uid", String(m.uid));
      e.dataTransfer.setData("text/folder", currentFolder);
      e.dataTransfer.effectAllowed = "move";
      div.style.opacity = "0.5";
    });
    div.addEventListener("dragend", () => { div.style.opacity = "1"; });

    list.appendChild(div);
  }
  list.scrollTop = prevScroll;
}

// ── Read message ────────────────────────────────────────────────────────────
async function openMessage(uid) {
  currentUid = uid;
  // Highlight active row in place — a full re-render resets the list scroll position
  $("#messageList").querySelectorAll(".msg-row.active").forEach((el) => el.classList.remove("active"));
  $("#messageList").querySelector(`.msg-checkbox[data-uid="${uid}"]`)?.closest(".msg-row")?.classList.add("active");

  $("#readPlaceholder").style.display = "none";
  $("#readContent").style.display = "flex";
  $("#readHeader").innerHTML = `<div style="color:var(--fg2);font-size:12px">Loading...</div>`;

  const msg = await gideon.fetchMessage(uid, currentFolder);
  if (uid !== currentUid) return; // user opened a different message while this one loaded
  if (msg.error) {
    $("#readHeader").innerHTML = `<div style="color:var(--danger)">${escHtml(msg.error)}</div>`;
    return;
  }

  currentMsg = msg;

  // Mark as read in list (in place, to keep scroll position)
  const listMsg = currentMessages.find((m) => m.uid === uid);
  if (listMsg) {
    listMsg.seen = true;
    $("#messageList").querySelector(`.msg-checkbox[data-uid="${uid}"]`)?.closest(".msg-row")?.classList.remove("unread");
  }

  // Header
  $("#readHeader").innerHTML = `
    <h2>${escHtml(msg.subject)}</h2>
    <div class="meta">
      <strong>${escHtml(msg.from?.name || msg.from?.address || "")}</strong>
      &lt;${escHtml(msg.from?.address || "")}&gt;<br>
      To: ${(msg.to || []).map((t) => escHtml(t.name || t.address)).join(", ")}
      ${msg.cc?.length ? "<br>Cc: " + msg.cc.map((t) => escHtml(t.name || t.address)).join(", ") : ""}
      <br>${formatDateFull(msg.date)}
    </div>
  `;

  // Show sender list status
  const statusEl = $("#senderStatus");
  const senderAddr = msg.from?.address || "";
  if (senderAddr && senderStatuses[senderAddr]) {
    const s = senderStatuses[senderAddr];
    const labels = { customer: "CUSTOMER", vip: "VIP", watch: "WATCHING", blocked: "BLOCKED", muted: "MUTED", daily: "DAILY" };
    const colors = { customer: "#ec4899", vip: "#3b82f6", watch: "#f59e0b", blocked: "#ef4444", muted: "#64748b", daily: "#22c55e" };
    statusEl.textContent = labels[s] || s;
    statusEl.style.cssText = `font-size:10px;padding:2px 6px;border-radius:3px;background:${colors[s] || "#334155"}22;color:${colors[s] || "#94a3b8"};border:1px solid ${colors[s] || "#334155"}66;font-weight:600`;
  } else {
    statusEl.textContent = "";
    statusEl.style.cssText = "";
  }

  // Star button
  const starred = currentMessages.find((m) => m.uid === uid)?.flagged;
  $("#btnStar").innerHTML = starred ? "&#9733;" : "&#9734;";
  $("#btnStar").style.color = starred ? "#fbbf24" : "";

  // Attachments
  const attDiv = $("#readAttachments");
  attDiv.innerHTML = "";
  for (const a of msg.attachments || []) {
    const chip = document.createElement("div");
    chip.className = "att-chip";
    chip.textContent = `${a.filename} (${formatSize(a.size)})`;
    chip.addEventListener("click", () => downloadAttachment(uid, a.filename));
    attDiv.appendChild(chip);
  }

  // Body (sandboxed iframe)
  const iframe = $("#readBody");
  const html = msg.html || `<pre style="font-family:inherit;white-space:pre-wrap">${escHtml(msg.text || "")}</pre>`;
  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(`
    <html><head><style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; color: #1e293b; padding: 16px; line-height: 1.6; }
      img { max-width: 100%; height: auto; }
      a { color: #2563eb; cursor: pointer; }
      blockquote { border-left: 3px solid #cbd5e1; margin: 8px 0; padding: 4px 12px; color: #64748b; }
    </style></head><body>${html}</body></html>
  `);
  doc.close();

  // Make links open in system browser
  doc.addEventListener("click", (e) => {
    const link = e.target.closest("a");
    if (link && link.href && (link.href.startsWith("http://") || link.href.startsWith("https://") || link.href.startsWith("mailto:"))) {
      e.preventDefault();
      window.open(link.href);
    }
  });
}

async function deleteCurrent() {
  if (!currentUid) return;
  if (!confirm("Delete this message?")) return;

  const result = await gideon.deleteMessage(currentUid, currentFolder);
  if (result.ok) {
    currentUid = null;
    currentMsg = null;
    $("#readContent").style.display = "none";
    $("#readPlaceholder").style.display = "flex";
    loadMessages();
  }
}

async function starCurrent() {
  if (!currentUid) return;
  await gideon.toggleFlag(currentUid, "flagged", currentFolder);
  const m = currentMessages.find((m) => m.uid === currentUid);
  if (m) m.flagged = !m.flagged;
  renderMessageList();
  $("#btnStar").innerHTML = m?.flagged ? "&#9733;" : "&#9734;";
  $("#btnStar").style.color = m?.flagged ? "#fbbf24" : "";
}

async function downloadAttachment(uid, filename) {
  const result = await gideon.fetchAttachment(uid, filename, currentFolder);
  if (result.error) { alert(result.error); return; }

  const blob = new Blob([Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))], { type: result.contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = result.filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Search ──────────────────────────────────────────────────────────────────
let _searchGen = 0;

async function searchMail(query) {
  const gen = ++_searchGen;
  $("#pageInfo").textContent = "Searching…";
  $("#messageList").innerHTML = `<div style="padding:24px;text-align:center;color:#94a3b8">Searching for "${query}"…</div>`;
  try {
    const result = await gideon.searchMessages(query);
    if (gen !== _searchGen) return; // newer search superseded this one
    if (result.stale || result.error) return;
    currentMessages = result.messages || [];
    renderMessageList();
    $("#pageInfo").textContent = `${currentMessages.length} result${currentMessages.length !== 1 ? "s" : ""}`;
    $("#btnPrev").disabled = true;
    $("#btnNext").disabled = true;
  } catch (e) {
    if (gen !== _searchGen) return;
    $("#messageList").innerHTML = `<div style="padding:24px;text-align:center;color:#f06060">Search failed</div>`;
    $("#pageInfo").textContent = "Search failed";
  }
}

// ── Compose ─────────────────────────────────────────────────────────────────
function openCompose(mode) {
  composeMode = mode;
  composeAttachments = [];
  $("#composeAttachList").innerHTML = "";
  $("#composeModal").style.display = "flex";

  if (mode === "new") {
    $("#composeTitle").textContent = "New Message";
    $("#composeTo").value = "";
    $("#composeCc").value = "";
    $("#composeSubject").value = "";
    $("#composeEditor").innerHTML = "";
  } else if (mode === "reply" && currentMsg) {
    $("#composeTitle").textContent = "Reply";
    $("#composeTo").value = currentMsg.from?.address || "";
    $("#composeCc").value = "";
    $("#composeSubject").value = currentMsg.subject?.startsWith("Re:") ? currentMsg.subject : `Re: ${currentMsg.subject}`;
    $("#composeEditor").innerHTML = `<br><br><blockquote style="border-left:3px solid #cbd5e1;padding-left:12px;color:#64748b">
      On ${formatDateFull(currentMsg.date)}, ${escHtml(currentMsg.from?.name || currentMsg.from?.address || "")} wrote:<br>
      ${sanitizeEmailHtml(currentMsg.html) || escHtml(currentMsg.text || "")}
    </blockquote>`;
  } else if (mode === "replyall" && currentMsg) {
    $("#composeTitle").textContent = "Reply All";
    const allTo = [currentMsg.from, ...(currentMsg.to || []), ...(currentMsg.cc || [])]
      .filter((t) => t?.address)
      .map((t) => t.address);
    const unique = [...new Set(allTo)];
    $("#composeTo").value = currentMsg.from?.address || "";
    $("#composeCc").value = unique.filter((a) => a !== currentMsg.from?.address).join(", ");
    $("#composeSubject").value = currentMsg.subject?.startsWith("Re:") ? currentMsg.subject : `Re: ${currentMsg.subject}`;
    $("#composeEditor").innerHTML = `<br><br><blockquote style="border-left:3px solid #cbd5e1;padding-left:12px;color:#64748b">
      On ${formatDateFull(currentMsg.date)}, ${escHtml(currentMsg.from?.name || currentMsg.from?.address || "")} wrote:<br>
      ${sanitizeEmailHtml(currentMsg.html) || escHtml(currentMsg.text || "")}
    </blockquote>`;
  } else if (mode === "forward" && currentMsg) {
    $("#composeTitle").textContent = "Forward";
    $("#composeTo").value = "";
    $("#composeCc").value = "";
    $("#composeSubject").value = currentMsg.subject?.startsWith("Fwd:") ? currentMsg.subject : `Fwd: ${currentMsg.subject}`;
    $("#composeEditor").innerHTML = `<br><br>---------- Forwarded message ----------<br>
      From: ${escHtml(currentMsg.from?.name || "")} &lt;${escHtml(currentMsg.from?.address || "")}&gt;<br>
      Date: ${formatDateFull(currentMsg.date)}<br>
      Subject: ${escHtml(currentMsg.subject || "")}<br><br>
      ${sanitizeEmailHtml(currentMsg.html) || escHtml(currentMsg.text || "")}`;
  }

  $("#composeTo").focus();
}

function closeCompose() {
  $("#composeModal").style.display = "none";
  composeMode = null;
  composeAttachments = [];
}

function handleAttachFiles(e) {
  for (const file of e.target.files) {
    const reader = new FileReader();
    reader.onload = () => {
      composeAttachments.push({
        filename: file.name,
        contentType: file.type,
        data: reader.result.split(",")[1], // base64
      });
      renderAttachList();
    };
    reader.readAsDataURL(file);
  }
  e.target.value = "";
}

function renderAttachList() {
  const list = $("#composeAttachList");
  list.innerHTML = "";
  for (let i = 0; i < composeAttachments.length; i++) {
    const span = document.createElement("span");
    span.className = "att-chip";
    span.textContent = composeAttachments[i].filename;
    span.style.cursor = "pointer";
    span.addEventListener("click", () => {
      composeAttachments.splice(i, 1);
      renderAttachList();
    });
    list.appendChild(span);
  }
}

async function sendCompose() {
  const to = $("#composeTo").value.trim();
  if (!to) { alert("Enter a recipient"); return; }

  $("#composeSend").disabled = true;
  $("#composeSend").textContent = "Sending...";

  const opts = {
    to,
    cc: $("#composeCc").value.trim() || undefined,
    subject: $("#composeSubject").value.trim(),
    html: $("#composeEditor").innerHTML,
    text: $("#composeEditor").innerText,
    attachments: composeAttachments.length ? composeAttachments : undefined,
  };

  if (composeMode === "reply" || composeMode === "replyall") {
    opts.inReplyTo = currentMsg?.messageId;
    // References = parent's references + parent's Message-ID (RFC 5322 threading)
    opts.references = [currentMsg?.references, currentMsg?.messageId].filter(Boolean).join(" ") || undefined;
  }

  const result = await gideon.sendMail(opts);

  $("#composeSend").disabled = false;
  $("#composeSend").textContent = "Send";

  if (result.error) {
    alert("Send failed: " + result.error);
  } else {
    closeCompose();
  }
}

// ── Settings ────────────────────────────────────────────────────────────────
async function openSettings() {
  const cfg = await gideon.getAccount() || {};
  $("#cfgDisplayName").value = cfg.displayName || "";
  $("#cfgEmail").value = cfg.email || "";
  $("#cfgUsername").value = cfg.username || "";
  $("#cfgPassword").value = cfg.password || "";
  $("#cfgImapHost").value = cfg.imapHost || "";
  $("#cfgImapPort").value = cfg.imapPort || 993;
  $("#cfgImapSecure").checked = cfg.imapSecure !== false;
  $("#cfgSmtpHost").value = cfg.smtpHost || "";
  $("#cfgSmtpPort").value = cfg.smtpPort || 587;
  $("#cfgSmtpSecure").checked = cfg.smtpSecure || false;
  const aiKey = await gideon.aiGetKey();
  $("#cfgApiKey").value = aiKey || "";
  const gcalStatus = await gideon.gcalStatus();
  $("#cfgGcalClientId").value = gcalStatus.clientId || "";
  $("#cfgGcalSecret").value = gcalStatus.clientId ? "••••••••" : "";
  $("#cfgGcalStatus").textContent = gcalStatus.connected ? "Connected" : gcalStatus.configured ? "Not connected" : "Not configured";
  $("#cfgGcalStatus").style.color = gcalStatus.connected ? "#22c55e" : "#94a3b8";
  const smsCfg = await gideon.smsGetConfig();
  $("#cfgSmsTo").value = smsCfg.smsTo || "";
  $("#cfgAlertEmail").value = smsCfg.alertEmailTo || "";
  const actionCfg = await gideon.actionEmailGet();
  $("#cfgActionEmail").checked = actionCfg.enabled;
  $("#cfgActionEmailAddr").value = actionCfg.address || "";
  $("#cfgTextbeltKey").value = smsCfg.textbeltKey || "";
  $("#cfgSmsResult").textContent = "";
  const alState = await gideon.autolaunchGet();
  $("#cfgAutoLaunch").checked = alState.enabled;

  // Active lists
  const activeLists = await gideon.activeListsGet();
  window._activeLists = activeLists;
  $("#cfgListCustomer").checked = activeLists.customer;
  $("#cfgListVip").checked = activeLists.vip;
  $("#cfgListWatch").checked = activeLists.watch;
  $("#cfgListDaily").checked = activeLists.daily;
  $("#cfgListBlocked").checked = activeLists.blocked;
  $("#cfgListMuted").checked = activeLists.muted;
  const convoCfg = await gideon.convoGetConfig();
  $("#cfgConvoEnabled").checked = convoCfg.enabled !== false;
  $("#cfgConvoMinReplies").value = convoCfg.minReplies || 2;
  $("#cfgConvoLookback").value = convoCfg.lookbackMonths || 6;
  $("#cfgConvoInterval").value = convoCfg.checkIntervalMin || 60;
  $("#cfgConvoResult").textContent = "";
  $("#cfgTestResult").textContent = "";
  $("#settingsModal").style.display = "flex";
}

async function testConnection() {
  $("#cfgTestResult").textContent = "Testing...";
  $("#cfgTestResult").className = "";

  try {
    // Save first so the test uses current values
    await saveSettingsQuiet();

    const result = await gideon.testConnection();
    $("#cfgTestResult").textContent = result.ok ? result.message : "Failed: " + result.message;
    $("#cfgTestResult").className = result.ok ? "test-ok" : "test-fail";
  } catch (e) {
    $("#cfgTestResult").textContent = "Error: " + (e.message || e);
    $("#cfgTestResult").className = "test-fail";
  }
}

async function saveSettingsQuiet() {
  const cfg = {
    displayName: $("#cfgDisplayName").value.trim(),
    email: $("#cfgEmail").value.trim(),
    username: $("#cfgUsername").value.trim(),
    password: $("#cfgPassword").value,
    imapHost: $("#cfgImapHost").value.trim(),
    imapPort: parseInt($("#cfgImapPort").value) || 993,
    imapSecure: $("#cfgImapSecure").checked,
    smtpHost: $("#cfgSmtpHost").value.trim(),
    smtpPort: parseInt($("#cfgSmtpPort").value) || 587,
    smtpSecure: $("#cfgSmtpSecure").checked,
  };
  await gideon.saveAccount(cfg);
  const apiKey = $("#cfgApiKey").value.trim();
  if (apiKey) await gideon.aiSaveKey(apiKey);
  const gcalId = $("#cfgGcalClientId").value.trim();
  const gcalSecret = $("#cfgGcalSecret").value.trim();
  if (gcalId || gcalSecret) await gideon.gcalSaveCredentials(gcalId, gcalSecret);
  await gideon.smsSaveConfig({
    smsTo: $("#cfgSmsTo").value.trim(),
    textbeltKey: $("#cfgTextbeltKey").value.trim(),
    alertEmailTo: $("#cfgAlertEmail").value.trim(),
  });
  await gideon.actionEmailSave({
    enabled: $("#cfgActionEmail").checked,
    address: $("#cfgActionEmailAddr").value.trim(),
  });
}

async function saveSettings() {
  await saveSettingsQuiet();
  $("#settingsModal").style.display = "none";
  loadFolders();
  loadMessages();
}

// ── Unified People renderer ─────────────────────────────────────────────
const ROLE_COLORS = { customer: "#ec4899", vip: "#3b82f6", watch: "#f59e0b", blocked: "#ef4444", muted: "#64748b", daily: "#06b6d4" };
const ROLE_LABELS = { customer: "Customer", vip: "VIP", watch: "Watch", blocked: "Blocked", muted: "Muted", daily: "Daily Update" };
const ROLE_DESC = { customer: "Deep AI analysis, item tracking, calendar", vip: "Always texts you", watch: "AI analyzes + actions", blocked: "Dark red, auto-deletes in 7 days", muted: "Grey, no notifications", daily: "Summarized in morning briefing" };

async function renderPeople() {
  const people = await gideon.peopleGetAll();
  const container = $("#peopleEntries");
  if (!container) return;
  container.innerHTML = "";

  if (!people.length) {
    container.innerHTML = '<div style="font-size:11px;color:var(--fg2);padding:8px 0">No senders configured. Add someone below, or use the "Add sender to..." dropdown when reading an email.</div>';
    return;
  }

  // Group by role for visual clarity
  const al = window._activeLists || { customer: false, vip: true, watch: true, daily: true, blocked: true, muted: true };
  const groups = { customer: [], vip: [], watch: [], daily: [], blocked: [], muted: [] };
  for (const p of people) groups[p.role]?.push(p);

  for (const role of ["customer", "vip", "watch", "daily", "blocked", "muted"]) {
    // Skip disabled lists (except show if items already exist in them)
    const roleKey = role === "vip" ? "vip" : role;
    if (!al[roleKey] && !groups[role].length) continue;
    const items = groups[role];
    if (!items.length) continue;

    const groupHeader = document.createElement("div");
    groupHeader.style.cssText = `font-size:10px;font-weight:700;color:${ROLE_COLORS[role]};padding:6px 0 2px;border-bottom:1px solid ${ROLE_COLORS[role]}33;margin-top:4px`;
    groupHeader.textContent = `${ROLE_LABELS[role]} (${items.length}) — ${ROLE_DESC[role]}`;
    container.appendChild(groupHeader);

    for (const item of items) {
      const card = document.createElement("div");
      card.style.cssText = `display:flex;align-items:center;gap:6px;padding:5px 4px;font-size:11px;border-bottom:1px solid var(--border);border-left:3px solid ${ROLE_COLORS[role]}`;

      // Enable toggle
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = item.enabled;
      toggle.addEventListener("change", async () => { await gideon.peopleToggle(item.id, role); renderPeople(); });

      // Info
      const info = document.createElement("div");
      info.style.cssText = `flex:1;min-width:0;${item.enabled ? "" : "text-decoration:line-through;opacity:0.5"}`;
      info.innerHTML = `<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(item.name || item.address)}</div>` +
        (item.name ? `<div style="font-size:10px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis">${escHtml(item.address)}</div>` : "");

      // Role dropdown (change role inline)
      const roleSel = document.createElement("select");
      roleSel.style.cssText = "padding:2px 4px;background:var(--bg2);border:1px solid var(--bg3);border-radius:3px;color:var(--fg);font-size:10px;cursor:pointer";
      for (const r of ["customer", "vip", "watch", "daily", "blocked", "muted"].filter(r => al[r] || r === role)) {
        const opt = document.createElement("option");
        opt.value = r; opt.textContent = ROLE_LABELS[r];
        if (r === role) opt.selected = true;
        roleSel.appendChild(opt);
      }
      roleSel.addEventListener("change", async () => {
        await gideon.peopleChangeRole(item.id, role, roleSel.value);
        renderPeople();
      });

      // Delete
      const del = document.createElement("button");
      del.style.cssText = "background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:0 4px";
      del.textContent = "\u00d7";
      del.addEventListener("click", async () => {
        if (!confirm(`Remove "${item.name || item.address}"?`)) return;
        await gideon.peopleRemove(item.id, role);
        renderPeople();
      });

      card.appendChild(toggle);
      card.appendChild(info);
      card.appendChild(roleSel);

      // Watch-specific: show action toggles
      if (role === "watch" && item.actions) {
        const actionsDiv = document.createElement("div");
        actionsDiv.style.cssText = "display:flex;gap:2px";
        const actionDefs = [
          { key: "smsAlert", label: "SMS", color: "#22c55e" },
          { key: "autoCalendar", label: "Cal", color: "#f59e0b" },
          { key: "flagImportant", label: "Flag", color: "#3b82f6" },
          { key: "autoTask", label: "Task", color: "#a78bfa" },
        ];
        for (const ad of actionDefs) {
          const chip = document.createElement("span");
          chip.style.cssText = `padding:1px 4px;border-radius:2px;font-size:9px;cursor:pointer;border:1px solid ${item.actions[ad.key] ? ad.color + "66" : "var(--bg3)"};color:${item.actions[ad.key] ? ad.color : "var(--fg2)"}`;
          chip.textContent = ad.label;
          chip.addEventListener("click", async () => {
            await gideon.peopleUpdateActions(item.id, { [ad.key]: !item.actions[ad.key] });
            renderPeople();
          });
          actionsDiv.appendChild(chip);
        }
        card.appendChild(actionsDiv);
      }

      card.appendChild(del);
      container.appendChild(card);
    }
  }
}

// ── Watch List renderer (with per-sender action toggles) ────────────────
async function renderWatchlist() {
  const list = await gideon.watchlistGet();
  const container = $("#watchlistEntries");
  if (!container) return;
  container.innerHTML = "";

  if (!list.length) {
    container.innerHTML = '<div style="font-size:10px;color:var(--fg2);padding:4px 0">No watched senders. Add one below.</div>';
    return;
  }

  const header = document.createElement("div");
  header.style.cssText = "font-size:10px;color:#f59e0b;padding:2px 0 4px;font-weight:600";
  header.textContent = `${list.length} watched sender${list.length > 1 ? "s" : ""}`;
  container.appendChild(header);

  for (const item of list) {
    const card = document.createElement("div");
    card.style.cssText = "padding:8px;background:var(--bg2);border-radius:6px;margin-bottom:4px;border-left:3px solid #f59e0b";

    // Header row: toggle + name + edit + delete
    const hdr = document.createElement("div");
    hdr.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:4px";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = item.enabled;
    toggle.addEventListener("change", async () => { await gideon.watchlistToggle(item.id); renderWatchlist(); });

    const info = document.createElement("div");
    info.style.cssText = `flex:1;${item.enabled ? "" : "text-decoration:line-through;color:var(--fg2)"}`;
    info.innerHTML = `<div style="font-weight:600;font-size:12px">${escHtml(item.name || item.address)}</div>` +
      (item.name ? `<div style="font-size:10px;color:var(--fg2)">${escHtml(item.address)}</div>` : "");

    const editBtn = document.createElement("button");
    editBtn.style.cssText = "background:none;border:1px solid var(--bg3);color:var(--fg2);cursor:pointer;font-size:10px;padding:1px 6px;border-radius:3px";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      const newAddr = prompt("Email or name:", item.address);
      if (newAddr === null) return;
      const newName = prompt("Label:", item.name || "");
      gideon.watchlistUpdate(item.id, { address: newAddr, name: newName || "" }).then(renderWatchlist);
    });

    const del = document.createElement("button");
    del.style.cssText = "background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:0 4px";
    del.textContent = "\u00d7";
    del.addEventListener("click", async () => {
      if (!confirm(`Remove "${item.name || item.address}" from watch list?`)) return;
      await gideon.watchlistRemove(item.id);
      renderWatchlist();
    });

    hdr.appendChild(toggle);
    hdr.appendChild(info);
    hdr.appendChild(editBtn);
    hdr.appendChild(del);
    card.appendChild(hdr);

    // Action toggles
    const actions = item.actions || {};
    const actionsDiv = document.createElement("div");
    actionsDiv.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;padding-left:22px";

    const actionDefs = [
      { key: "aiAnalyze", label: "AI Analyze", color: "#a78bfa" },
      { key: "smsAlert", label: "SMS Alert", color: "#22c55e" },
      { key: "autoCalendar", label: "Auto Calendar", color: "#f59e0b" },
      { key: "flagImportant", label: "Flag Important", color: "#3b82f6" },
      { key: "autoReply", label: "Auto Reply", color: "#94a3b8" },
    ];

    for (const ad of actionDefs) {
      const chip = document.createElement("label");
      chip.style.cssText = `display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:3px;font-size:10px;cursor:pointer;border:1px solid ${actions[ad.key] ? ad.color + "66" : "var(--bg3)"};color:${actions[ad.key] ? ad.color : "var(--fg2)"};background:${actions[ad.key] ? ad.color + "15" : "transparent"}`;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!actions[ad.key];
      cb.style.cssText = "width:10px;height:10px;margin:0";
      cb.addEventListener("change", async () => {
        const updatedActions = { ...actions, [ad.key]: cb.checked };
        await gideon.watchlistUpdate(item.id, { actions: updatedActions });
        renderWatchlist();
      });
      chip.appendChild(cb);
      chip.appendChild(document.createTextNode(ad.label));
      actionsDiv.appendChild(chip);
    }

    card.appendChild(actionsDiv);
    container.appendChild(card);
  }
}

// ── Generic list renderer (whitelist, blacklist, greylist) ──────────────
async function renderManagedList(containerId, getFn, toggleFn, removeFn, updateFn, color) {
  const list = await getFn();
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = "";

  const header = document.createElement("div");
  header.style.cssText = "font-size:10px;color:" + color + ";padding:2px 0 4px;font-weight:600";
  header.textContent = list.length ? `${list.length} entr${list.length > 1 ? "ies" : "y"}` : "Empty. Add one below.";
  container.appendChild(header);

  for (const item of list) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 4px;font-size:11px;border-bottom:1px solid var(--border);background:var(--bg2);border-radius:4px;margin-bottom:2px";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = item.enabled;
    toggle.addEventListener("change", async () => { await toggleFn(item.id); renderManagedList(containerId, getFn, toggleFn, removeFn, updateFn, color); });

    const info = document.createElement("div");
    info.style.cssText = `flex:1;color:${item.enabled ? "var(--fg)" : "var(--fg2)"};${item.enabled ? "" : "text-decoration:line-through"}`;
    const addrLine = document.createElement("div");
    addrLine.textContent = item.address;
    addrLine.style.fontWeight = "600";
    info.appendChild(addrLine);
    if (item.name) { const n = document.createElement("div"); n.textContent = item.name; n.style.cssText = "font-size:10px;color:var(--fg2)"; info.appendChild(n); }

    const editBtn = document.createElement("button");
    editBtn.style.cssText = "background:none;border:1px solid var(--bg3);color:var(--fg2);cursor:pointer;font-size:10px;padding:1px 6px;border-radius:3px";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      const newAddr = prompt("Email or name to match:", item.address);
      if (newAddr === null) return;
      const newName = prompt("Label (optional):", item.name || "");
      updateFn(item.id, { address: newAddr, name: newName || "" }).then(() => renderManagedList(containerId, getFn, toggleFn, removeFn, updateFn, color));
    });

    const del = document.createElement("button");
    del.style.cssText = "background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:0 4px";
    del.textContent = "\u00d7";
    del.addEventListener("click", async () => {
      if (!confirm(`Remove "${item.name || item.address}"?`)) return;
      await removeFn(item.id);
      renderManagedList(containerId, getFn, toggleFn, removeFn, updateFn, color);
    });

    row.appendChild(toggle);
    row.appendChild(info);
    row.appendChild(editBtn);
    row.appendChild(del);
    container.appendChild(row);
  }
}

// ── Rules Panel ─────────────────────────────────────────────────────────
async function openRules() {
  // Load all settings into the rules panel
  const smsSett = await gideon.smsSettingsGet();
  $("#cfgSmsFormat").value = smsSett.format || "sender_subject";
  $("#cfgSmsMaxLen").value = smsSett.maxLength || 160;
  $("#cfgSmsPrefix").value = smsSett.prefix || "GideonMail";
  $("#cfgSmsBatch").checked = smsSett.batchMultiple !== false;
  $("#cfgQuietStart").value = smsSett.quietStart ?? 22;
  $("#cfgQuietEnd").value = smsSett.quietEnd ?? 7;
  $("#cfgSmsMaxHour").value = smsSett.maxPerHour || 10;
  $("#cfgSmsMaxDay").value = smsSett.maxPerDay || 30;
  $("#cfgSmsHistory").value = smsSett.historyHours || 4;

  const convoCfg = await gideon.convoGetConfig();
  $("#cfgConvoEnabled").checked = convoCfg.enabled !== false;
  $("#cfgConvoMinReplies").value = convoCfg.minReplies || 2;
  $("#cfgConvoLookback").value = convoCfg.lookbackMonths || 6;
  $("#cfgConvoInterval").value = convoCfg.checkIntervalMin || 60;
  $("#cfgConvoResult").textContent = "";

  // Security filters
  const sf = await gideon.securityFiltersGet();
  $("#sfSpamassassin").checked = sf.spamassassin || false;
  $("#sfSpamhaus").checked = sf.spamhaus || false;
  $("#sfVirustotal").checked = sf.virustotal || false;
  $("#sfSafebrowsing").checked = sf.safebrowsing || false;
  $("#sfAbuseipdb").checked = sf.abuseipdb || false;
  $("#sfBayesian").checked = sf.bayesian || false;

  // API keys
  const apiKeys = await gideon.securityApiKeysGet();
  $("#sfKeyVt").value = apiKeys.virustotal || "";
  $("#sfKeySb").value = apiKeys.safebrowsing || "";
  $("#sfKeyAbuse").value = apiKeys.abuseipdb || "";

  // AI urgency triage
  const aiUrg = await gideon.aiUrgencyGet();
  $("#sfAiUrgency").checked = aiUrg.enabled;

  // Auto-check interval
  const ac = await gideon.autocheckGet();
  $("#sfAutoCheckInterval").value = String(ac.intervalMin || 120);

  // Scheduling hours
  $("#sfSchedStart").value = localStorage.getItem("gm_sched_start") || "8";
  $("#sfSchedEnd").value = localStorage.getItem("gm_sched_end") || "18";

  const vipOpts = await gideon.vipOptionsGet();
  $("#cfgVipMeetings").checked = vipOpts.detectMeetings;
  $("#cfgVipAutoCalendar").checked = vipOpts.autoCalendar;
  $("#cfgVipAiReview").checked = vipOpts.aiReview;

  // Low Touch settings — show active/inactive state
  const lt = await gideon.lowTouchGet();
  $("#cfgAutoUnsub").checked = lt.autoUnsub;
  $("#cfgAutoNudge").checked = lt.autoNudge;
  $("#cfgNudgeDays").value = lt.nudgeDays || 5;
  $("#cfgMaxPerCycle").value = lt.maxPerCycle || 100;
  $("#cfgArchiveLookback").value = lt.archiveLookbackDays || 0;
  $("#cfgDigestMax").value = lt.digestMaxEmails || 60;
  const voicePreview = $("#voiceProfilePreview");
  if (lt.voiceProfile) {
    voicePreview.textContent = lt.voiceProfile;
    voicePreview.style.display = "block";
  } else {
    voicePreview.style.display = "none";
  }
  // Update Low Touch status banner and dim controls when inactive
  const ltBanner = $("#ltStatusBanner");
  const ltNote = $("#ltInactiveNote");
  const ltBody = $("#ltSettingsBody");
  if (ltBanner) {
    if (lt.enabled) {
      ltBanner.innerHTML = '<span style="color:#4ade80">&#9679;</span> Low Touch is <b style="color:#4ade80">ON</b> &mdash; these settings are actively controlling your email';
      ltBanner.style.background = "rgba(74,222,128,0.08)";
      ltBanner.style.color = "var(--fg2)";
    } else {
      ltBanner.innerHTML = '<span style="color:#f87171">&#9679;</span> Low Touch is <b style="color:#f87171">OFF</b> &mdash; settings below are saved but not in use';
      ltBanner.style.background = "rgba(248,113,113,0.06)";
      ltBanner.style.color = "var(--fg2)";
    }
  }
  if (ltNote) ltNote.style.display = lt.enabled ? "none" : "inline";
  if (ltBody) ltBody.style.opacity = lt.enabled ? "1" : "0.45";

  $("#rulesModal").style.display = "flex";
  renderPeople();
  renderSettingsInstructions();
  renderStats();
}

async function saveRulesSettings() {
  await gideon.smsSettingsSave({
    format: $("#cfgSmsFormat").value,
    maxLength: parseInt($("#cfgSmsMaxLen").value) || 160,
    prefix: $("#cfgSmsPrefix").value.trim(),
    batchMultiple: $("#cfgSmsBatch").checked,
    quietStart: parseInt($("#cfgQuietStart").value) ?? 22,
    quietEnd: parseInt($("#cfgQuietEnd").value) ?? 7,
    maxPerHour: parseInt($("#cfgSmsMaxHour").value) || 10,
    maxPerDay: parseInt($("#cfgSmsMaxDay").value) || 30,
    historyHours: parseInt($("#cfgSmsHistory").value) || 4,
  });
  await gideon.convoSaveConfig({
    enabled: $("#cfgConvoEnabled").checked,
    minReplies: parseInt($("#cfgConvoMinReplies").value) || 2,
    lookbackMonths: parseInt($("#cfgConvoLookback").value) || 6,
    checkIntervalMin: parseInt($("#cfgConvoInterval").value) || 60,
  });
  await gideon.securityFiltersSave({
    spamassassin: $("#sfSpamassassin").checked,
    spamhaus: $("#sfSpamhaus").checked,
    virustotal: $("#sfVirustotal").checked,
    safebrowsing: $("#sfSafebrowsing").checked,
    abuseipdb: $("#sfAbuseipdb").checked,
    bayesian: $("#sfBayesian").checked,
  });
  await gideon.autocheckSave({
    intervalMin: parseInt($("#sfAutoCheckInterval").value) || 120,
  });
  // Save scheduling hours
  localStorage.setItem("gm_sched_start", $("#sfSchedStart").value);
  localStorage.setItem("gm_sched_end", $("#sfSchedEnd").value);
  await gideon.aiUrgencySet($("#sfAiUrgency").checked);
  await gideon.securityApiKeysSave({
    virustotal: $("#sfKeyVt").value.trim(),
    safebrowsing: $("#sfKeySb").value.trim(),
    abuseipdb: $("#sfKeyAbuse").value.trim(),
  });
  // Low Touch settings
  await gideon.lowTouchSet({
    autoUnsub: $("#cfgAutoUnsub").checked,
    autoNudge: $("#cfgAutoNudge").checked,
    nudgeDays: parseInt($("#cfgNudgeDays").value) || 5,
    maxPerCycle: parseInt($("#cfgMaxPerCycle").value) || 100,
    archiveLookbackDays: parseInt($("#cfgArchiveLookback").value) || 0,
    digestMaxEmails: parseInt($("#cfgDigestMax").value) || 60,
  });
}

// ── Whitelist Management ────────────────────────────────────────────────
async function renderWhitelist() {
  const list = await gideon.whitelistGet();
  const container = $("#whitelistEntries");
  if (!container) { console.error("whitelistEntries element not found"); return; }
  container.innerHTML = "";

  // Header with count
  const header = document.createElement("div");
  header.style.cssText = "font-size:10px;color:var(--accent);padding:2px 0 4px;font-weight:600";
  header.textContent = list.length ? `${list.length} VIP sender${list.length > 1 ? "s" : ""} — emails from these always trigger SMS` : "No VIP senders. Add one below.";
  container.appendChild(header);

  for (const item of list) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 4px;font-size:11px;border-bottom:1px solid var(--border);background:var(--bg2);border-radius:4px;margin-bottom:2px";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = item.enabled;
    toggle.title = item.enabled ? "Enabled — click to disable" : "Disabled — click to enable";
    toggle.addEventListener("change", async () => {
      await gideon.whitelistToggle(item.id);
      renderWhitelist();
    });

    const info = document.createElement("div");
    info.style.cssText = `flex:1;color:${item.enabled ? "var(--fg)" : "var(--fg2)"};${item.enabled ? "" : "text-decoration:line-through"}`;
    const addrLine = document.createElement("div");
    addrLine.textContent = item.address;
    addrLine.style.cssText = "font-weight:600";
    info.appendChild(addrLine);
    if (item.name) {
      const nameLine = document.createElement("div");
      nameLine.textContent = item.name;
      nameLine.style.cssText = "font-size:10px;color:var(--fg2)";
      info.appendChild(nameLine);
    }

    const editBtn = document.createElement("button");
    editBtn.style.cssText = "background:none;border:1px solid var(--bg3);color:var(--fg2);cursor:pointer;font-size:10px;padding:1px 6px;border-radius:3px";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      const newAddr = prompt("Email or name to match:", item.address);
      if (newAddr === null) return;
      const newName = prompt("Label (optional):", item.name || "");
      gideon.whitelistUpdate(item.id, { address: newAddr, name: newName || "" }).then(renderWhitelist);
    });

    const del = document.createElement("button");
    del.style.cssText = "background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:0 4px";
    del.textContent = "\u00d7";
    del.title = "Remove";
    del.addEventListener("click", async () => {
      if (!confirm(`Remove "${item.name || item.address}" from whitelist?`)) return;
      await gideon.whitelistRemove(item.id);
      renderWhitelist();
    });

    row.appendChild(toggle);
    row.appendChild(info);
    row.appendChild(editBtn);
    row.appendChild(del);
    container.appendChild(row);
  }
}

// ── Instructions Management (Settings) ──────────────────────────────────
async function renderSettingsInstructions() {
  const list = await gideon.instructionsGet();
  const container = $("#instrEntries");
  if (!container) { console.error("instrEntries element not found"); return; }
  container.innerHTML = "";

  const header = document.createElement("div");
  header.style.cssText = "font-size:10px;color:var(--accent);padding:2px 0 4px;font-weight:600";
  header.textContent = list.length ? `${list.length} instruction${list.length > 1 ? "s" : ""} — the AI follows these when checking email` : "No instructions yet. Add one below or use 'Save as instruction' in the AI chat.";
  container.appendChild(header);

  for (const item of list) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:flex-start;gap:6px;padding:5px 4px;font-size:11px;border-bottom:1px solid var(--border);background:var(--bg2);border-radius:4px;margin-bottom:2px";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = item.enabled;
    toggle.style.marginTop = "2px";
    toggle.title = item.enabled ? "Active" : "Disabled";
    toggle.addEventListener("change", async () => {
      await gideon.instructionsToggle(item.id);
      renderSettingsInstructions();
    });

    const text = document.createElement("div");
    text.style.cssText = `flex:1;color:${item.enabled ? "var(--fg)" : "var(--fg2)"};line-height:1.4;${item.enabled ? "" : "text-decoration:line-through"}`;
    text.textContent = item.text;
    const dateLine = document.createElement("div");
    dateLine.style.cssText = "font-size:9px;color:var(--fg2);margin-top:2px";
    dateLine.textContent = `Added ${new Date(item.created).toLocaleDateString()}`;
    text.appendChild(dateLine);

    const editBtn = document.createElement("button");
    editBtn.style.cssText = "background:none;border:1px solid var(--bg3);color:var(--fg2);cursor:pointer;font-size:10px;padding:1px 6px;border-radius:3px";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      const newText = prompt("Edit instruction:", item.text);
      if (newText === null || !newText.trim()) return;
      gideon.instructionsUpdate(item.id, newText).then(renderSettingsInstructions);
    });

    const del = document.createElement("button");
    del.style.cssText = "background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:0 4px";
    del.textContent = "\u00d7";
    del.title = "Remove";
    del.addEventListener("click", async () => {
      if (!confirm(`Remove instruction: "${item.text.substring(0, 50)}..."?`)) return;
      await gideon.instructionsRemove(item.id);
      renderSettingsInstructions();
    });

    row.appendChild(toggle);
    row.appendChild(text);
    row.appendChild(editBtn);
    row.appendChild(del);
    container.appendChild(row);
  }
}

// ── AI Assistant ────────────────────────────────────────────────────────────
let aiOpen = false;
let lastUserMessage = "";

function toggleAI() {
  aiOpen = !aiOpen;
  $("#aiPanel").style.display = aiOpen ? "flex" : "none";
  // Show notice if no AI key
  if (aiOpen && window._serviceStatus && !window._serviceStatus.hasAI) {
    const existing = document.getElementById("aiNoKeyBanner");
    if (!existing) {
      const banner = document.createElement("div");
      banner.id = "aiNoKeyBanner";
      banner.style.cssText = "padding:8px 12px;background:#1a1a0a;border:1px solid #f59e0b33;border-radius:6px;margin:8px;font-size:11px;color:#f59e0b";
      banner.textContent = "AI features require an Anthropic API key. Add one in Settings to enable triage, analysis, drafting, and chat.";
      $("#aiMessages").parentNode.insertBefore(banner, $("#aiMessages"));
    }
  }
}

function addAIMessage(text, role) {
  const div = document.createElement("div");
  div.className = "ai-msg " + role;
  div.textContent = text;

  // Add "Save as rule" button on assistant responses that followed a user instruction
  if (role === "assistant" && lastUserMessage && text.includes("Actions taken:") || (role === "assistant" && lastUserMessage)) {
    const saveRule = document.createElement("div");
    saveRule.style.cssText = "margin-top:6px;padding-top:4px;border-top:1px solid #ffffff15";
    const btn = document.createElement("button");
    btn.style.cssText = "background:#7c3aed22;border:1px solid #7c3aed44;color:#a78bfa;padding:2px 8px;border-radius:3px;font-size:10px;cursor:pointer";
    btn.textContent = "Save as standing instruction";
    const instrText = lastUserMessage;
    btn.addEventListener("click", async () => {
      await gideon.instructionsAdd(instrText);
      btn.textContent = "Saved!";
      btn.disabled = true;
      btn.style.color = "#22c55e";
      btn.style.borderColor = "#22c55e44";
      // AI confirms
      addAIMessage(`New instruction saved: "${instrText}"`, "system");
      if (instrVisible) renderInstructions();
    });
    saveRule.appendChild(btn);
    div.appendChild(saveRule);
  }

  $("#aiMessages").appendChild(div);
  $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;
}

async function aiTriageInbox() {
  if (!currentMessages.length) { addAIMessage("No messages to triage.", "error"); return; }
  addAIMessage("Triaging inbox...", "system");
  const result = await gideon.aiTriage(currentMessages);
  if (result.error) { addAIMessage("Error: " + result.error, "error"); return; }
  addAIMessage(result.text, "assistant");

  // Add bulk action buttons after triage
  const bulkDiv = document.createElement("div");
  bulkDiv.className = "ai-msg system";
  bulkDiv.style.cssText = "display:flex;flex-wrap:wrap;gap:4px";

  const bulkActions = [
    { label: "Delete all LOW", action: async () => {
      // Match triage line numbers back to actual emails
      const triageText = result.text || "";
      const lines = triageText.split("\n").filter((l) => l.trim());
      const deleteUids = [];
      const deleteNames = [];
      for (const line of lines) {
        if (!line.toUpperCase().includes("SKIP") && !line.toUpperCase().includes("LOW")) continue;
        // Extract the line number [#] to match to email index
        const numMatch = line.match(/^\[?#?(\d+)\]?/);
        if (numMatch) {
          const idx = parseInt(numMatch[1]) - 1;
          if (idx >= 0 && idx < currentMessages.length) {
            deleteUids.push(currentMessages[idx].uid);
            deleteNames.push(`${currentMessages[idx].from?.name || currentMessages[idx].from?.address}: ${currentMessages[idx].subject}`);
          }
        }
      }
      if (!deleteUids.length) {
        // Fallback: if no line numbers parsed, try matching by subject keywords
        for (const line of lines) {
          if (!line.toUpperCase().includes("SKIP") && !line.toUpperCase().includes("LOW")) continue;
          for (const m of currentMessages) {
            const subj = (m.subject || "").toLowerCase();
            const from = (m.from?.name || m.from?.address || "").toLowerCase();
            if ((line.toLowerCase().includes(subj.substring(0, 20)) || line.toLowerCase().includes(from.substring(0, 15))) && !deleteUids.includes(m.uid)) {
              deleteUids.push(m.uid);
              deleteNames.push(`${m.from?.name || m.from?.address}: ${m.subject}`);
            }
          }
        }
      }
      if (!deleteUids.length) { addAIMessage("Couldn't match any emails to delete.", "error"); return; }
      if (!confirm(`Delete ${deleteUids.length} emails?\n\n${deleteNames.slice(0, 5).join("\n")}${deleteUids.length > 5 ? `\n...and ${deleteUids.length - 5} more` : ""}`)) return;
      addAIMessage(`Deleting ${deleteUids.length} emails...`, "system");
      for (const uid of deleteUids) {
        try { await gideon.deleteMessage(uid, currentFolder); } catch (e) {}
      }
      addAIMessage(`Deleted ${deleteUids.length} emails.`, "system");
      await loadMessages();
    }},
    { label: "Star all URGENT", action: async () => {
      const triageText = result.text || "";
      const lines = triageText.split("\n").filter((l) => l.trim());
      const starUids = [];
      for (const line of lines) {
        if (!line.toUpperCase().includes("URGENT")) continue;
        const numMatch = line.match(/^\[?#?(\d+)\]?/);
        if (numMatch) {
          const idx = parseInt(numMatch[1]) - 1;
          if (idx >= 0 && idx < currentMessages.length) starUids.push(currentMessages[idx].uid);
        }
      }
      if (!starUids.length) { addAIMessage("Couldn't match any urgent emails.", "error"); return; }
      addAIMessage(`Starring ${starUids.length} emails...`, "system");
      for (const uid of starUids) {
        try { await gideon.toggleFlag(uid, "flagged", currentFolder); } catch (e) {}
      }
      addAIMessage(`Starred ${starUids.length} emails.`, "system");
      await loadMessages();
    }},
    { label: "Ask AI to act", action: () => { $("#aiInput").value = "Based on the triage, "; $("#aiInput").focus(); } },
  ];

  for (const ba of bulkActions) {
    const btn = document.createElement("button");
    btn.style.cssText = "padding:3px 8px;background:var(--bg2);border:1px solid var(--bg3);color:var(--fg);border-radius:4px;cursor:pointer;font-size:10px";
    btn.textContent = ba.label;
    btn.addEventListener("click", () => { ba.action(); });
    bulkDiv.appendChild(btn);
  }

  $("#aiMessages").appendChild(bulkDiv);
  $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;
}

async function aiAnalyzeCurrent() {
  if (!currentMsg) { addAIMessage("Open an email first.", "error"); return; }
  addAIMessage("Analyzing email...", "system");
  const result = await gideon.aiAnalyze(currentMsg);
  if (result.error) { addAIMessage("Error: " + result.error, "error"); return; }
  addAIMessage(result.text, "assistant");

  // Show quick action buttons based on the analysis
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "ai-msg system";
  actionsDiv.style.cssText = "display:flex;flex-wrap:wrap;gap:4px";

  const actionDefs = [
    { label: "Reply", icon: "↩", action: () => openCompose("reply") },
    { label: "Forward", icon: "→", action: () => openCompose("forward") },
    { label: "Delete", icon: "🗑", action: async () => { if (confirm("Delete this email?")) { await gideon.deleteMessage(currentMsg.uid, currentFolder); addAIMessage("Deleted.", "system"); loadMessages(); } } },
    { label: "Star", icon: "⭐", action: async () => { await gideon.toggleFlag(currentMsg.uid, "flagged", currentFolder); addAIMessage("Flagged.", "system"); } },
    { label: "Archive", icon: "📁", action: () => { addAIMessage("Use drag-and-drop to move to a folder.", "system"); } },
    { label: "Draft Reply", icon: "✍", action: () => aiDraftReplyCurrent() },
    { label: "Create Task", icon: "📅", action: () => { $("#btnTask").click(); } },
  ];

  for (const ad of actionDefs) {
    const btn = document.createElement("button");
    btn.style.cssText = "padding:3px 8px;background:var(--bg2);border:1px solid var(--bg3);color:var(--fg);border-radius:4px;cursor:pointer;font-size:10px";
    btn.textContent = `${ad.icon} ${ad.label}`;
    btn.addEventListener("click", () => { ad.action(); actionsDiv.remove(); });
    actionsDiv.appendChild(btn);
  }

  $("#aiMessages").appendChild(actionsDiv);
  $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;
}

async function aiDraftReplyCurrent() {
  if (!currentMsg) { addAIMessage("Open an email first.", "error"); return; }
  addAIMessage("Drafting reply...", "system");
  const result = await gideon.aiDraftReply(currentMsg, "");
  if (result.error) {
    addAIMessage("Error: " + result.error, "error");
  } else {
    addAIMessage(result.text, "assistant");
    // Also offer to use it
    const useBtn = document.createElement("div");
    useBtn.className = "ai-msg system";
    useBtn.style.cursor = "pointer";
    useBtn.textContent = "Click here to use this draft in a reply";
    useBtn.addEventListener("click", () => {
      openCompose("reply");
      setTimeout(() => { $("#composeEditor").innerText = result.text; }, 100);
    });
    $("#aiMessages").appendChild(useBtn);
    $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;
  }
}

async function aiSendChat() {
  const input = $("#aiInput");
  const sendBtn = $("#aiSend");
  const msg = input.value.trim();
  if (!msg) return;

  input.value = "";
  input.disabled = true;
  sendBtn.disabled = true;
  sendBtn.textContent = "...";
  lastUserMessage = msg;
  addAIMessage(msg, "user");
  addAIMessage("Working...", "system");

  try {
    const result = await gideon.aiChat(msg, currentMsg || null);
    // Remove the "Working..." message
    const msgs = $("#aiMessages");
    const last = msgs.lastElementChild;
    if (last && last.textContent === "Working...") last.remove();

    if (result.error) addAIMessage("Error: " + result.error, "error");
    else addAIMessage(result.text, "assistant");
  } catch (e) {
    const msgs = $("#aiMessages");
    const last = msgs.lastElementChild;
    if (last && last.textContent === "Working...") last.remove();
    addAIMessage("Error: " + (e.message || e), "error");
  }

  input.disabled = false;
  sendBtn.disabled = false;
  sendBtn.textContent = "Send";
  input.focus();
}

// ── Standing Instructions ────────────────────────────────────────────────────
let instrVisible = false;

async function renderInstructions() {
  const list = await gideon.instructionsGet();
  const container = $("#aiInstrList");
  container.innerHTML = "";

  if (!list.length) {
    container.innerHTML = '<div style="font-size:10px;color:var(--fg2);padding:4px 0">No instructions yet. Type one below and press Enter.</div>';
  }

  for (const item of list) {
    const row = document.createElement("div");
    row.className = "ai-instr-item" + (item.enabled ? "" : " disabled");

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = item.enabled;
    toggle.addEventListener("change", async () => {
      await gideon.instructionsToggle(item.id);
      renderInstructions();
    });

    const text = document.createElement("span");
    text.className = "text";
    text.textContent = item.text;

    const del = document.createElement("button");
    del.textContent = "\u00d7";
    del.title = "Remove";
    del.addEventListener("click", async () => {
      await gideon.instructionsRemove(item.id);
      renderInstructions();
    });

    row.appendChild(toggle);
    row.appendChild(text);
    row.appendChild(del);
    container.appendChild(row);
  }
}

async function addInstruction(text) {
  if (!text.trim()) return;
  await gideon.instructionsAdd(text.trim());
  $("#aiInstrInput").value = "";
  renderInstructions();

  // AI confirms understanding
  addAIMessage(`New instruction: "${text.trim()}"`, "user");
  const result = await gideon.aiChat(
    `I just added this standing instruction for you to follow when checking my emails: "${text.trim()}". Confirm you understand in one sentence, and explain briefly how you'll apply it.`,
    null
  );
  if (result.error) addAIMessage("Error: " + result.error, "error");
  else addAIMessage(result.text, "assistant");
}

function bindAIEvents() {
  $("#btnAI").addEventListener("click", () => { toggleAI(); renderInstructions(); });
  $("#aiClose").addEventListener("click", toggleAI);
  $("#aiTriage").addEventListener("click", aiTriageInbox);
  $("#aiAnalyze").addEventListener("click", aiAnalyzeCurrent);
  $("#aiDraft").addEventListener("click", aiDraftReplyCurrent);
  $("#aiSend").addEventListener("click", aiSendChat);
  $("#aiInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); aiSendChat(); }
  });

  // Instructions
  $("#aiInstrToggle").addEventListener("click", () => {
    instrVisible = !instrVisible;
    $("#aiInstrList").style.display = instrVisible ? "block" : "none";
    $("#aiInstrAdd").style.display = instrVisible ? "block" : "none";
    $("#aiInstrToggle").querySelector("span").textContent = instrVisible ? "Hide Standing Instructions" : "Show Standing Instructions";
    if (instrVisible) renderInstructions();
  });
  $("#aiInstrInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addInstruction(e.target.value); }
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function escHtml(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Sanitize untrusted email HTML before it enters the privileged main document
// (compose quote/forward). The read pane is a sandboxed iframe, but the compose
// editor is not — raw email HTML here means script access to the gideon bridge.
function sanitizeEmailHtml(html) {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html"); // inert — nothing executes during parse
  doc.querySelectorAll("script, iframe, object, embed, link, meta, base, form").forEach((el) => el.remove());
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      const v = (attr.value || "").trim().toLowerCase();
      if (n.startsWith("on") || n === "srcdoc") el.removeAttribute(attr.name);
      else if ((n === "href" || n === "src" || n === "xlink:href") &&
               (v.startsWith("javascript:") || v.startsWith("vbscript:") || (v.startsWith("data:") && !v.startsWith("data:image/")))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (now.getFullYear() === d.getFullYear()) {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function formatDateFull(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString([], {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

// ── Interactive Calendar Time Picker ─────────────────────────────────────
// Returns a Promise that resolves with { date, startTime, endTime } or null if cancelled
function showTimePicker(event, existingEvents) {
  return new Promise((resolve) => {
    const picker = document.createElement("div");
    picker.className = "ai-msg assistant";
    picker.style.cssText = "padding:10px 12px";

    let selDate = event.date || new Date().toISOString().split("T")[0];
    let selStart = event.startTime || "09:00";
    let selDuration = 30; // minutes

    // Calculate duration from event if endTime exists
    if (event.endTime && event.startTime) {
      const [sh, sm] = event.startTime.split(":").map(Number);
      const [eh, em] = event.endTime.split(":").map(Number);
      selDuration = Math.max(15, (eh * 60 + em) - (sh * 60 + sm));
    }

    // Never default to a past time — push to next available hour
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    if (selDate === todayStr) {
      const [curH, curM] = [now.getHours(), now.getMinutes()];
      const [selH, selM] = selStart.split(":").map(Number);
      if (selH * 60 + selM < curH * 60 + curM) {
        // Round up to next 15-min slot
        const nextMin = Math.ceil((curH * 60 + curM) / 15) * 15;
        selStart = `${String(Math.floor(nextMin / 60)).padStart(2, "0")}:${String(nextMin % 60).padStart(2, "0")}`;
      }
    }
    let dayEvents = existingEvents || [];

    function calcEndTime() {
      const [h, m] = selStart.split(":").map(Number);
      const total = h * 60 + m + selDuration;
      return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    }

    function hasConflict() {
      const endTime = calcEndTime();
      return dayEvents.some((e) => {
        const es = e.start ? new Date(e.start) : null;
        const ee = e.end ? new Date(e.end) : null;
        if (!es || !ee) return false;
        const esHM = `${String(es.getHours()).padStart(2, "0")}:${String(es.getMinutes()).padStart(2, "0")}`;
        const eeHM = `${String(ee.getHours()).padStart(2, "0")}:${String(ee.getMinutes()).padStart(2, "0")}`;
        return selStart < eeHM && endTime > esHM;
      });
    }

    async function loadDay() {
      try {
        const result = await gideon.gcalGetDay(selDate);
        if (result.ok) dayEvents = result.events || [];
        else dayEvents = [];
      } catch (e) { dayEvents = []; }
      render();
    }

    function render() {
      picker.innerHTML = "";
      const endTime = calcEndTime();
      const conflict = hasConflict();

      // Date navigation
      const dateRow = document.createElement("div");
      dateRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px";

      const prevDay = document.createElement("button");
      prevDay.style.cssText = "background:var(--bg2);border:1px solid var(--bg3);color:var(--fg);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:12px";
      prevDay.textContent = "◀";
      prevDay.addEventListener("click", () => {
        const d = new Date(selDate + "T12:00:00");
        d.setDate(d.getDate() - 1);
        selDate = d.toISOString().split("T")[0];
        loadDay();
      });

      const dateInput = document.createElement("input");
      dateInput.type = "date";
      dateInput.value = selDate;
      dateInput.style.cssText = "flex:1;padding:4px 8px;background:var(--bg2);border:1px solid var(--bg3);border-radius:4px;color:var(--fg);font-size:12px;text-align:center";
      dateInput.addEventListener("change", () => {
        selDate = dateInput.value;
        loadDay();
      });

      const nextDay = document.createElement("button");
      nextDay.style.cssText = "background:var(--bg2);border:1px solid var(--bg3);color:var(--fg);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:12px";
      nextDay.textContent = "▶";
      nextDay.addEventListener("click", () => {
        const d = new Date(selDate + "T12:00:00");
        d.setDate(d.getDate() + 1);
        selDate = d.toISOString().split("T")[0];
        loadDay();
      });

      dateRow.appendChild(prevDay);
      dateRow.appendChild(dateInput);
      dateRow.appendChild(nextDay);
      picker.appendChild(dateRow);

      // Day label
      const dayLabel = document.createElement("div");
      const dayDate = new Date(selDate + "T12:00:00");
      dayLabel.style.cssText = "font-size:10px;color:var(--fg2);margin-bottom:6px;text-align:center";
      dayLabel.textContent = dayDate.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
      picker.appendChild(dayLabel);

      // Visual timeline — use scheduling hours from settings or default 8am-6pm
      const schedStartH = parseInt(localStorage.getItem("gm_sched_start") || "8");
      const schedEndH = parseInt(localStorage.getItem("gm_sched_end") || "18");
      const timeline = document.createElement("div");
      timeline.style.cssText = "position:relative;background:var(--bg2);border-radius:6px;padding:12px 4px;margin-bottom:8px;min-height:280px";

      const hours = [];
      for (let h = schedStartH; h <= schedEndH; h++) hours.push(h);
      const totalMin = (schedEndH - schedStartH) * 60;

      // Hour labels and grid lines
      for (const h of hours) {
        const pct = ((h - schedStartH) * 60 / totalMin * 100);
        const line = document.createElement("div");
        line.style.cssText = `position:absolute;left:44px;right:4px;top:calc(12px + ${pct}% * 0.92);height:1px;background:var(--border)`;
        timeline.appendChild(line);
        const label = document.createElement("div");
        label.style.cssText = `position:absolute;left:2px;top:calc(12px + ${pct}% * 0.92);font-size:9px;color:var(--fg2);transform:translateY(-50%);width:38px;text-align:right`;
        label.textContent = `${h > 12 ? h - 12 : h}${h >= 12 ? "pm" : "am"}`;
        timeline.appendChild(label);
      }

      // Existing events as blocks (with move option on conflicts)
      const conflictingEvents = [];
      for (const ev of dayEvents) {
        const es = ev.start ? new Date(ev.start) : null;
        const ee = ev.end ? new Date(ev.end) : null;
        if (!es || !ee) continue;
        const startMin = es.getHours() * 60 + es.getMinutes() - schedStartH * 60;
        const endMin = ee.getHours() * 60 + ee.getMinutes() - schedStartH * 60;
        if (startMin < 0 && endMin < 0) continue;

        // Check if this event conflicts with proposed
        const esHM = `${String(es.getHours()).padStart(2,"0")}:${String(es.getMinutes()).padStart(2,"0")}`;
        const eeHM = `${String(ee.getHours()).padStart(2,"0")}:${String(ee.getMinutes()).padStart(2,"0")}`;
        const isConflict = selStart < eeHM && endTime > esHM;
        if (isConflict) conflictingEvents.push(ev);

        const top = Math.max(0, startMin / totalMin * 92);
        const height = Math.max(2, (Math.min(endMin, totalMin) - Math.max(startMin, 0)) / totalMin * 92);
        const block = document.createElement("div");
        block.style.cssText = `position:absolute;left:46px;right:6px;top:calc(12px + ${top}%);height:${height}%;background:${isConflict ? "#2a1a1a" : "#2a2a32"};border-radius:3px;padding:2px 4px;overflow:hidden;border-left:2px solid ${isConflict ? "#ef4444" : "#64748b"};z-index:1`;
        block.innerHTML = `<div style="font-size:9px;color:${isConflict ? "#fca5a5" : "var(--fg2)"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(ev.title)}${isConflict ? " ⚠" : ""}</div>`;
        timeline.appendChild(block);
      }

      // Proposed event block (green, clickable to indicate selected)
      const [sh, sm] = selStart.split(":").map(Number);
      const propStartMin = sh * 60 + sm - schedStartH * 60;
      const propTop = Math.max(0, propStartMin / totalMin * 92);
      const propHeight = Math.max(3, selDuration / totalMin * 92);
      const propBlock = document.createElement("div");
      propBlock.style.cssText = `position:absolute;left:46px;right:6px;top:calc(12px + ${propTop}%);height:${propHeight}%;background:${conflict ? "#7f1d1d" : "#1a3a0a"};border:2px solid ${conflict ? "#ef4444" : "#4ade80"};border-radius:3px;padding:2px 6px;cursor:pointer;z-index:2`;
      propBlock.innerHTML = `<div style="font-size:9px;color:${conflict ? "#fca5a5" : "#86efac"};font-weight:600">${selStart}–${endTime} ${event.title || "New event"}${conflict ? " ⚠ CONFLICT" : ""}</div>`;
      timeline.appendChild(propBlock);

      // Click on timeline to move event
      timeline.addEventListener("click", (e) => {
        const rect = timeline.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const pct2 = y / rect.height;
        const clickMin = Math.round(pct2 * totalMin / 15) * 15 + schedStartH * 60;
        selStart = `${String(Math.floor(clickMin / 60)).padStart(2, "0")}:${String(clickMin % 60).padStart(2, "0")}`;
        render();
      });

      picker.appendChild(timeline);

      // Time controls
      const controls = document.createElement("div");
      controls.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap";

      const timeLabel = document.createElement("span");
      timeLabel.style.cssText = "font-size:11px;color:var(--fg2)";
      timeLabel.textContent = "Time:";

      const startInput = document.createElement("input");
      startInput.type = "time";
      startInput.value = selStart;
      startInput.style.cssText = "padding:3px 6px;background:var(--bg2);border:1px solid var(--bg3);border-radius:4px;color:var(--fg);font-size:11px";
      startInput.addEventListener("change", () => { selStart = startInput.value; render(); });

      const durLabel = document.createElement("span");
      durLabel.style.cssText = "font-size:11px;color:var(--fg2)";
      durLabel.textContent = "Duration:";

      const durDown = document.createElement("button");
      durDown.style.cssText = "padding:2px 6px;background:var(--bg2);border:1px solid var(--bg3);color:var(--fg);border-radius:3px;cursor:pointer;font-size:11px";
      durDown.textContent = "−";
      durDown.addEventListener("click", () => { selDuration = Math.max(15, selDuration - 15); render(); });

      const durDisplay = document.createElement("span");
      durDisplay.style.cssText = "font-size:11px;color:var(--fg);min-width:40px;text-align:center";
      durDisplay.textContent = selDuration >= 60 ? `${Math.floor(selDuration / 60)}h${selDuration % 60 ? selDuration % 60 + "m" : ""}` : `${selDuration}m`;

      const durUp = document.createElement("button");
      durUp.style.cssText = "padding:2px 6px;background:var(--bg2);border:1px solid var(--bg3);color:var(--fg);border-radius:3px;cursor:pointer;font-size:11px";
      durUp.textContent = "+";
      durUp.addEventListener("click", () => { selDuration = Math.min(480, selDuration + 15); render(); });

      controls.appendChild(timeLabel);
      controls.appendChild(startInput);
      controls.appendChild(durLabel);
      controls.appendChild(durDown);
      controls.appendChild(durDisplay);
      controls.appendChild(durUp);
      picker.appendChild(controls);

      // Conflict warning + move options
      if (conflict && conflictingEvents.length > 0) {
        const warnBox = document.createElement("div");
        warnBox.style.cssText = "background:#1a0a0a;border:1px solid #f0606033;border-radius:4px;padding:6px 8px;margin-bottom:6px";

        const warn = document.createElement("div");
        warn.style.cssText = "font-size:10px;color:#ef4444;font-weight:600;margin-bottom:4px";
        warn.textContent = `⚠ ${conflictingEvents.length} conflict${conflictingEvents.length > 1 ? "s" : ""} — adjust your time, or move the existing event:`;
        warnBox.appendChild(warn);

        for (const ce of conflictingEvents) {
          const ceRow = document.createElement("div");
          ceRow.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 0;font-size:10px";

          const ceLabel = document.createElement("span");
          ceLabel.style.cssText = "flex:1;color:#fca5a5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
          const ceStart = ce.start ? new Date(ce.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?";
          const ceEnd = ce.end ? new Date(ce.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?";
          ceLabel.textContent = `${ceStart}–${ceEnd}: ${ce.title}`;

          const moveBtn = document.createElement("button");
          moveBtn.style.cssText = "padding:2px 8px;background:var(--bg2);border:1px solid var(--bg3);color:var(--accent);border-radius:3px;cursor:pointer;font-size:9px;white-space:nowrap";
          moveBtn.textContent = "Move this →";
          moveBtn.addEventListener("click", async () => {
            if (!ce.id) { addAIMessage("Can't move — no event ID", "error"); return; }
            // Calculate: push the conflicting event to right after the proposed event
            const newStartStr = `${selDate}T${calcEndTime()}:00`;
            const ceDuration = ce.end && ce.start ? new Date(ce.end).getTime() - new Date(ce.start).getTime() : 3600000;
            const newEndDate = new Date(new Date(newStartStr).getTime() + ceDuration);
            const newEndStr = newEndDate.toISOString();

            moveBtn.textContent = "Moving...";
            moveBtn.disabled = true;
            const r = await gideon.gcalMoveEvent(ce.id, newStartStr, newEndStr);
            if (r.ok) {
              moveBtn.textContent = "Moved!";
              moveBtn.style.color = "#4ade80";
              // Reload the day to show updated layout
              await loadDay();
            } else {
              moveBtn.textContent = "Failed";
              moveBtn.style.color = "#ef4444";
              setTimeout(() => { moveBtn.textContent = "Move this →"; moveBtn.disabled = false; moveBtn.style.color = "var(--accent)"; }, 2000);
            }
          });

          ceRow.appendChild(ceLabel);
          ceRow.appendChild(moveBtn);
          warnBox.appendChild(ceRow);
        }

        picker.appendChild(warnBox);
      }

      // Action buttons
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:6px";

      const confirmBtn = document.createElement("button");
      confirmBtn.style.cssText = `padding:5px 16px;background:${conflict ? "var(--bg3)" : "#1a3a0a"};border:1px solid ${conflict ? "var(--fg2)" : "#4ade80"};color:${conflict ? "var(--fg2)" : "#86efac"};border-radius:4px;cursor:pointer;font-size:11px;font-weight:600`;
      confirmBtn.textContent = conflict ? "Confirm Anyway" : "Confirm";
      confirmBtn.addEventListener("click", () => {
        picker.remove();
        resolve({ date: selDate, startTime: selStart, endTime: calcEndTime() });
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.style.cssText = "padding:5px 12px;background:var(--bg2);border:1px solid var(--bg3);color:var(--fg2);border-radius:4px;cursor:pointer;font-size:11px";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => { picker.remove(); resolve(null); });

      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      picker.appendChild(actions);
    }

    $("#aiMessages").appendChild(picker);
    $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;
    loadDay();
  });
}

// ── Google Calendar connection banner ───────────────────────────────────
async function checkGcalConnection() {
  try {
    const r = await gideon.gcalCheckConnection();
    $("#btnCalendar").style.display = r.status === "ok" ? "block" : "none";
    if (r.status !== "expired") return; // ok or never connected — nothing to renew
    $("#gcalBanner").style.display = "flex";
    $("#gcalReconnect").onclick = async () => {
      $("#gcalReconnect").textContent = "Waiting for Google...";
      $("#gcalReconnect").disabled = true;
      const res = await gideon.gcalAuthorize();
      $("#gcalReconnect").textContent = "Reconnect";
      $("#gcalReconnect").disabled = false;
      if (res.ok) {
        $("#gcalBanner").style.display = "none";
        $("#btnCalendar").style.display = "block";
      } else {
        $("#gcalBannerText").textContent = "Reconnect failed: " + (res.error || "unknown error") + " — try again or use Settings.";
      }
    };
    $("#gcalBannerDismiss").onclick = () => { $("#gcalBanner").style.display = "none"; };
  } catch (e) { /* banner is best-effort */ }
}

// ── Calendar view ────────────────────────────────────────────────────────
let calCursor = new Date();

function showCalendar(show) {
  $("#calendarPane").style.display = show ? "flex" : "none";
  $("#listPane").style.display = show ? "none" : "flex";
  $("#readPane").style.display = show ? "none" : "flex";
  if (show) renderCalendar();
}

function _calDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function renderCalendar() {
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  $("#calTitle").textContent = calCursor.toLocaleString("default", { month: "long", year: "numeric" });

  // 6-week grid starting the Sunday on/before the 1st
  const first = new Date(y, m, 1);
  const gridStart = new Date(y, m, 1 - first.getDay());
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42);

  let events = [];
  try {
    const r = await gideon.gcalGetEvents(gridStart.toISOString(), gridEnd.toISOString());
    if (r.events) events = r.events;
    else if (r.error) console.error("Calendar events:", r.error);
  } catch (e) { console.error("Calendar events:", e); }

  const byDay = {};
  for (const ev of events) {
    const key = ev.allDay ? ev.start.slice(0, 10) : _calDayKey(new Date(ev.start));
    (byDay[key] = byDay[key] || []).push(ev);
  }

  const todayKey = _calDayKey(new Date());
  const grid = $("#calGrid");
  grid.innerHTML = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const key = _calDayKey(d);

    const cell = document.createElement("div");
    cell.className = "cal-day" + (d.getMonth() !== m ? " other-month" : "") + (key === todayKey ? " today" : "");
    cell.dataset.key = key;
    const num = document.createElement("div");
    num.className = "cal-day-num";
    num.textContent = d.getDate();
    cell.appendChild(num);

    const dayEvents = byDay[key] || [];
    const MAX_CHIPS = 4;
    for (const ev of dayEvents.slice(0, MAX_CHIPS)) {
      const chip = document.createElement("div");
      chip.className = "cal-event" + (ev.gideon ? " gideon" : "");
      chip.dataset.evId = ev.id;
      const time = ev.allDay ? "" : new Date(ev.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + " ";
      chip.textContent = time + ev.title;
      chip.title = "Click for details";
      chip.style.cursor = "pointer";
      chip.onclick = () => showCalEventModal(ev);
      cell.appendChild(chip);
    }
    if (dayEvents.length > MAX_CHIPS) {
      const more = document.createElement("div");
      more.className = "cal-event-more";
      more.textContent = `+${dayEvents.length - MAX_CHIPS} more`;
      cell.appendChild(more);
    }
    grid.appendChild(cell);
  }

  // Phase 2: append email-derived candidates once the (possibly slow) scan returns
  const seq = ++_calRenderSeq;
  try {
    const c = await gideon.calendarCandidatesScan(
      currentMessages.map((msg) => ({ uid: msg.uid, from: msg.from, subject: msg.subject, date: msg.date }))
    );
    if (seq !== _calRenderSeq) return; // a newer render replaced this grid
    for (const cand of c.items || []) {
      const cell = grid.querySelector(`.cal-day[data-key="${cand.date}"]`);
      if (!cell) continue;
      if (cand.kind === "cancel") {
        // Email says an event was canceled — find the matching calendar event
        const target = (byDay[cand.date] || []).find((ev) => _calTitleMatch(ev.title, cand.title));
        const chipEl = target ? cell.querySelector(`.cal-event[data-ev-id="${CSS.escape(target.id)}"]`) : null;
        if (target && chipEl) _calMarkCanceled(chipEl, target, cand);
        else cell.appendChild(_calCancelNoticeChip(cand));
      } else {
        cell.appendChild(_calCandidateChip(cand));
      }
    }
  } catch (e) { console.error("Calendar candidates:", e); }
}

let _calRenderSeq = 0;

// Loose title match: containment or ≥50% overlap of significant words
function _calTitleMatch(a, b) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = new Set(na.split(" ").filter((w) => w.length > 2));
  const wb = nb.split(" ").filter((w) => w.length > 2);
  if (!wa.size || !wb.length) return false;
  const overlap = wb.filter((w) => wa.has(w)).length;
  return overlap / Math.min(wa.size, wb.length) >= 0.5;
}

// Event detail dialog — overlays the calendar
function showCalEventModal(ev) {
  $("#calEvTitle").textContent = ev.title;
  $("#calEvBadge").style.display = ev.gideon ? "inline-block" : "none";

  const day = new Date(ev.start).toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const fmtT = (s) => new Date(s).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  $("#calEvWhen").textContent = ev.allDay ? `${day} — all day` : `${day}, ${fmtT(ev.start)} – ${fmtT(ev.end)}`;

  const loc = $("#calEvLocation");
  loc.style.display = ev.location ? "block" : "none";
  loc.textContent = ev.location ? "📍 " + ev.location : "";

  const people = $("#calEvPeople");
  const who = [ev.organizer ? `Organizer: ${ev.organizer}` : "", ev.attendees?.length ? `Attendees: ${ev.attendees.join(", ")}` : ""].filter(Boolean).join("\n");
  people.style.display = who ? "block" : "none";
  people.textContent = who;

  const desc = $("#calEvDesc");
  const descText = (ev.description || "").replace(/<[^>]+>/g, " ").replace(/\s{3,}/g, "\n").trim();
  desc.style.display = descText ? "block" : "none";
  desc.textContent = descText;

  const link = $("#calEvLink");
  link.style.display = ev.link ? "inline-block" : "none";
  link.href = ev.link || "#";

  $("#calEventModal").style.display = "flex";
}

$("#calEvClose").addEventListener("click", () => { $("#calEventModal").style.display = "none"; });
$("#calEvCloseBtn").addEventListener("click", () => { $("#calEventModal").style.display = "none"; });
$("#calEventModal").addEventListener("click", (e) => { if (e.target === $("#calEventModal")) $("#calEventModal").style.display = "none"; });

// Restyle an existing event chip as canceled-per-email, with a one-click fix button
function _calMarkCanceled(chipEl, ev, cand) {
  const text = chipEl.textContent;
  chipEl.classList.add("cancel-flagged");
  chipEl.textContent = "";
  chipEl.onclick = null; // buttons/label take over — don't also open the detail modal

  const label = document.createElement("span");
  label.className = "cal-cand-label clickable";
  label.textContent = "✖ " + text;
  label.title = `An email says this event was canceled:\n"${cand.subject}"\nFrom: ${cand.from}\n\nClick to open the email. ✖ removes the event from Google Calendar.`;
  label.onclick = () => { showCalendar(false); openMessage(cand.uid); };
  chipEl.appendChild(label);

  const btnFix = document.createElement("button");
  btnFix.className = "cal-cand-btn dismiss";
  btnFix.textContent = "✖";
  btnFix.title = "Remove this event from Google Calendar";
  btnFix.onclick = async () => {
    btnFix.disabled = true;
    const r = await gideon.gcalDeleteEvent(ev.id);
    if (r.ok) {
      await gideon.calendarCandidateResolve(cand.uid, cand.date);
      renderCalendar();
    } else {
      btnFix.disabled = false;
      label.textContent = "⚠ " + (r.error || "remove failed");
    }
  };
  chipEl.appendChild(btnFix);

  const btnKeep = document.createElement("button");
  btnKeep.className = "cal-cand-btn";
  btnKeep.textContent = "✓";
  btnKeep.title = "Keep the event — the cancellation notice is wrong / already handled";
  btnKeep.onclick = async () => {
    await gideon.calendarCandidateResolve(cand.uid, cand.date);
    renderCalendar();
  };
  chipEl.appendChild(btnKeep);
}

// Cancellation notice with no matching calendar event — informational only
function _calCancelNoticeChip(cand) {
  const chip = document.createElement("div");
  chip.className = "cal-event cancel-notice";

  const label = document.createElement("span");
  label.className = "cal-cand-label clickable";
  label.textContent = "✖ canceled: " + cand.title;
  label.title = `An email says this event was canceled, but no matching event was found on this day.\n"${cand.subject}"\nFrom: ${cand.from}\n\nClick to open the email`;
  label.onclick = () => { showCalendar(false); openMessage(cand.uid); };
  chip.appendChild(label);

  const btnX = document.createElement("button");
  btnX.className = "cal-cand-btn dismiss";
  btnX.textContent = "✕";
  btnX.title = "Dismiss";
  btnX.onclick = async () => {
    await gideon.calendarCandidateResolve(cand.uid, cand.date);
    chip.remove();
  };
  chip.appendChild(btnX);

  return chip;
}

function _calCandidateChip(cand) {
  const chip = document.createElement("div");
  chip.className = "cal-event candidate";

  // Row 1: time + title, with Add / Dismiss buttons
  const top = document.createElement("div");
  top.className = "cal-cand-top";

  const label = document.createElement("span");
  label.className = "cal-cand-label clickable";
  label.textContent = "✉ " + (cand.startTime ? cand.startTime + " " : "") + cand.title;
  label.title = "Possible event found in email — not on your calendar yet.\nClick to open the email.";
  label.onclick = () => { showCalendar(false); openMessage(cand.uid); };
  top.appendChild(label);

  const btnAdd = document.createElement("button");
  btnAdd.className = "cal-cand-btn";
  btnAdd.textContent = "+";
  btnAdd.title = "Add to Google Calendar";
  btnAdd.onclick = async () => {
    btnAdd.disabled = true;
    const r = await gideon.gcalCreateEvent({
      title: cand.title,
      date: cand.date,
      startTime: cand.startTime || undefined,
      endTime: cand.endTime || undefined,
      location: cand.location || "",
      description: `From email: "${cand.subject}" (${cand.from})`,
    });
    if (r.ok) {
      await gideon.calendarCandidateResolve(cand.uid, cand.date);
      renderCalendar();
    } else {
      btnAdd.disabled = false;
      label.textContent = "⚠ " + (r.error || "add failed");
    }
  };
  top.appendChild(btnAdd);

  const btnX = document.createElement("button");
  btnX.className = "cal-cand-btn dismiss";
  btnX.textContent = "✕";
  btnX.title = "Dismiss — not a real event";
  btnX.onclick = async () => {
    await gideon.calendarCandidateResolve(cand.uid, cand.date);
    chip.remove();
  };
  top.appendChild(btnX);
  chip.appendChild(top);

  // Row 2: sender
  const fromLine = document.createElement("div");
  fromLine.className = "cal-cand-meta";
  fromLine.textContent = "From: " + (cand.from || "unknown");
  fromLine.title = cand.from || "";
  chip.appendChild(fromLine);

  // Row 3: original subject (falls back to location/time detail)
  const detailLine = document.createElement("div");
  detailLine.className = "cal-cand-meta";
  detailLine.textContent = cand.location ? "📍 " + cand.location : "“" + (cand.subject || "") + "”";
  detailLine.title = `"${cand.subject}"` + (cand.location ? `\nLocation: ${cand.location}` : "");
  chip.appendChild(detailLine);

  return chip;
}

$("#btnCalendar").addEventListener("click", () => showCalendar($("#calendarPane").style.display === "none"));
$("#calClose").addEventListener("click", () => showCalendar(false));
$("#calToday").addEventListener("click", () => { calCursor = new Date(); renderCalendar(); });
$("#calPrev").addEventListener("click", () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); renderCalendar(); });
$("#calNext").addEventListener("click", () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); renderCalendar(); });

// ── Pending appointments banner ──────────────────────────────────────────
let currentPendingUid = null;

async function checkPendingAppointments() {
  const pending = await gideon.pendingAppointmentsGet();
  if (pending.length > 0) {
    const p = pending[0];
    currentPendingUid = p.uid;
    $("#pendingText").textContent = `Meeting detected: "${p.subject}" from ${p.from?.name || p.from?.address || "unknown"}`;
    $("#pendingBanner").style.display = "flex";
  } else {
    $("#pendingBanner").style.display = "none";
    currentPendingUid = null;
  }
}

// ── Setup Wizard ────────────────────────────────────────────────────────────
const WIZARD_STEPS = [
  {
    title: "Welcome to GideonMail",
    body: () => `
      <div style="text-align:center;padding:20px 0">
        <div style="font-size:40px;margin-bottom:12px">&#10024;</div>
        <div style="font-size:16px;font-weight:700;color:var(--fg);margin-bottom:8px">Your AI-powered email assistant</div>
        <div style="font-size:13px;color:var(--fg2);line-height:1.6">
          GideonMail connects to your IMAP email server and adds AI triage,<br>
          SMS alerts, calendar integration, and smart sender management.<br><br>
          Let's set up your connections.
        </div>
      </div>`,
    validate: () => true,
  },
  {
    title: "Email Account",
    body: () => `
      <div style="font-size:12px;color:var(--fg2);margin-bottom:12px">Connect to your IMAP/SMTP email server. This is required.</div>
      <div style="font-size:11px;color:var(--accent);margin-bottom:8px">Already configured? Skip this step.</div>
      <div style="font-size:11px;color:var(--fg2)">Configure your email account in <strong>Settings</strong> (gear icon in the sidebar). You need:<br>
      &bull; IMAP host, port, and credentials<br>
      &bull; SMTP host and port for sending<br><br>
      Your ISPConfig server typically uses port 143 (IMAP) and 587 (SMTP).</div>`,
    validate: () => true,
  },
  {
    title: "AI Assistant (Anthropic)",
    body: () => `
      <div style="font-size:12px;color:var(--fg2);margin-bottom:12px">Power up GideonMail with AI email triage, smart replies, and analysis.</div>
      <div style="padding:10px;background:var(--bg2);border-radius:6px;margin-bottom:10px">
        <div style="font-size:11px;font-weight:600;color:var(--accent);margin-bottom:6px">How to get your API key:</div>
        <div style="font-size:11px;color:var(--fg2);line-height:1.6">
          1. Go to <strong style="color:var(--fg)">console.anthropic.com</strong><br>
          2. Sign up or log in<br>
          3. Go to <strong style="color:var(--fg)">Settings → API Keys → Create Key</strong><br>
          4. Copy the key (starts with <code style="color:var(--accent)">sk-ant-</code>)<br>
          5. Add $5 credit under <strong style="color:var(--fg)">Settings → Billing</strong><br>
          6. Paste the key in <strong style="color:var(--fg)">Settings → Anthropic API Key</strong>
        </div>
      </div>
      <div style="font-size:10px;color:var(--fg2)">Cost: ~$0.003 per email triage. $5 lasts months of normal use.</div>`,
    validate: () => true,
  },
  {
    title: "SMS Notifications (Textbelt)",
    body: () => `
      <div style="font-size:12px;color:var(--fg2);margin-bottom:12px">Get texted when important emails arrive — even when GideonMail is minimized.</div>
      <div style="padding:10px;background:var(--bg2);border-radius:6px;margin-bottom:10px">
        <div style="font-size:11px;font-weight:600;color:var(--warm);margin-bottom:6px">How to set up SMS:</div>
        <div style="font-size:11px;color:var(--fg2);line-height:1.6">
          1. Go to <strong style="color:var(--fg)">textbelt.com</strong><br>
          2. Buy an API key ($10 = 1,000 texts to Canada/US)<br>
          3. In Settings, enter your <strong style="color:var(--fg)">phone number</strong> and <strong style="color:var(--fg)">Textbelt key</strong><br>
          4. Click <strong style="color:var(--fg)">Send Test SMS</strong> to verify
        </div>
      </div>
      <div style="font-size:10px;color:var(--fg2)">SMS triggers: VIP senders, AI urgency detection, meeting detection, conversation alerts.</div>`,
    validate: () => true,
  },
  {
    title: "Google Calendar",
    body: () => `
      <div style="font-size:12px;color:var(--fg2);margin-bottom:12px">Create calendar events from emails with one click. See your schedule when booking.</div>
      <div style="padding:10px;background:var(--bg2);border-radius:6px;margin-bottom:10px">
        <div style="font-size:11px;font-weight:600;color:var(--warm);margin-bottom:6px">How to connect Google Calendar:</div>
        <div style="font-size:11px;color:var(--fg2);line-height:1.6">
          1. Go to <strong style="color:var(--fg)">console.cloud.google.com</strong><br>
          2. Create a project (or use existing)<br>
          3. <strong style="color:var(--fg)">APIs & Services → Library</strong> → enable <strong style="color:var(--fg)">Google Calendar API</strong><br>
          4. <strong style="color:var(--fg)">APIs & Services → Credentials → Create → OAuth 2.0 Client ID</strong><br>
          5. Type: <strong style="color:var(--fg)">Web application</strong><br>
          6. Authorized redirect URI: <code style="color:var(--accent)">http://localhost:39847/oauth/callback</code><br>
          7. Copy <strong style="color:var(--fg)">Client ID</strong> and <strong style="color:var(--fg)">Client Secret</strong><br>
          8. Paste both in <strong style="color:var(--fg)">Settings → Google Calendar</strong> → click <strong style="color:var(--fg)">Connect</strong>
        </div>
      </div>
      <div style="font-size:10px;color:var(--fg2)">Free. Uses OAuth with refresh tokens — stays connected permanently.</div>`,
    validate: () => true,
  },
  {
    title: "You're all set!",
    body: () => `
      <div style="text-align:center;padding:20px 0">
        <div style="font-size:40px;margin-bottom:12px">&#9989;</div>
        <div style="font-size:16px;font-weight:700;color:var(--success);margin-bottom:12px">GideonMail is ready</div>
        <div style="font-size:12px;color:var(--fg2);line-height:1.8">
          <strong style="color:var(--fg)">Quick tips:</strong><br>
          &#9776; <strong>Rules</strong> — manage People (VIP/Watch/Blocked/Muted), AI instructions, security filters<br>
          &#10024; <strong>AI</strong> — triage inbox, analyze emails, draft replies, search & delete<br>
          &#128197; <strong>Task</strong> — create calendar events from emails with conflict detection<br>
          &#128737; <strong>Scan</strong> — run security filters on any email<br>
          Drag emails to folders on the left to organize<br>
          Use "Add sender to..." dropdown when reading any email
        </div>
      </div>`,
    validate: () => true,
  },
];

let wizardCurrentStep = 0;

function showWizard() {
  wizardCurrentStep = 0;
  renderWizardStep();
  $("#wizardModal").style.display = "flex";
}

function renderWizardStep() {
  const step = WIZARD_STEPS[wizardCurrentStep];
  $("#wizardTitle").textContent = step.title;
  $("#wizardStep").textContent = `Step ${wizardCurrentStep + 1} of ${WIZARD_STEPS.length}`;
  $("#wizardBody").innerHTML = step.body();
  $("#wizardBack").style.display = wizardCurrentStep === 0 ? "none" : "";
  $("#wizardNext").textContent = wizardCurrentStep === WIZARD_STEPS.length - 1 ? "Get Started" : "Next";
  $("#wizardSkip").style.display = wizardCurrentStep === WIZARD_STEPS.length - 1 ? "none" : "";
}

function bindWizardEvents() {
  $("#wizardNext").addEventListener("click", () => {
    if (wizardCurrentStep < WIZARD_STEPS.length - 1) {
      wizardCurrentStep++;
      renderWizardStep();
    } else {
      $("#wizardModal").style.display = "none";
      localStorage.setItem("gideonmail_wizard_done", "1");
    }
  });
  $("#wizardBack").addEventListener("click", () => {
    if (wizardCurrentStep > 0) { wizardCurrentStep--; renderWizardStep(); }
  });
  $("#wizardSkip").addEventListener("click", () => {
    $("#wizardModal").style.display = "none";
    localStorage.setItem("gideonmail_wizard_done", "1");
  });
  // Help button re-opens wizard
  $("#btnHelp").addEventListener("click", showWizard);
}

// ── Boot ────────────────────────────────────────────────────────────────────
bindWizardEvents();
if (!localStorage.getItem("gideonmail_wizard_done")) {
  setTimeout(showWizard, 500);
}

// Check for updates on startup
(async () => {
  try {
    const ver = await gideon.getVersion();
    const update = await gideon.checkUpdate();
    // Show version in sidebar
    const logo = $(".logo");
    if (logo) logo.title = `GideonMail v${ver}`;

    if (!update.upToDate) {
      const banner = $("#updateBanner");
      const text = $("#updateText");
      if (banner && text) {
        text.textContent = `Update available: v${update.latest} (you have v${update.current})`;
        banner.style.display = "block";
        banner.addEventListener("click", () => {
          window.open(update.url);
        });
      }
    }
  } catch (e) {}
})();

init();
