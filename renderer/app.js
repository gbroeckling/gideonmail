// GideonMail — Renderer
// Single-account IMAP/SMTP email client

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

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
}

function bindEvents() {
  $("#btnCompose").addEventListener("click", () => openCompose("new"));
  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnRefresh").addEventListener("click", () => loadMessages());
  $("#btnPrev").addEventListener("click", () => { if (currentPage > 0) { currentPage--; loadMessages(); } });
  $("#btnNext").addEventListener("click", () => { currentPage++; loadMessages(); });

  // Search
  let searchTimer;
  $("#searchInput").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => {
      if (q.length >= 2) searchMail(q);
      else loadMessages();
    }, 400);
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

    // Step 1: AI extracts event details
    const extracted = await gideon.aiExtractEvent(currentMsg);
    if (extracted.error) {
      addAIMessage("Error extracting event: " + extracted.error, "error");
      taskInProgress = false;
      return;
    }
    const event = extracted.event;

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
    const list = e.target.value;
    if (!list || !currentMsg) { e.target.value = ""; return; }
    const addr = currentMsg.from?.address || "";
    const name = currentMsg.from?.name || "";
    if (!addr) { e.target.value = ""; return; }

    await gideon.peopleAdd({ address: addr, name: name, role: list });
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
      const sections = { people: "rulesPeople", instructions: "rulesInstructions", security: "rulesSecurity", conversations: "rulesConversations", sms: "rulesSms" };
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
    div.innerHTML = `<span>${escHtml(f.name)}</span>`;
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

// ── Message list ────────────────────────────────────────────────────────────
async function loadMessages() {
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
  const total = result.total || 0;

  renderMessageList();

  // Pagination
  $("#btnPrev").disabled = currentPage === 0;
  $("#btnNext").disabled = (currentPage + 1) * 50 >= total;
  $("#pageInfo").textContent = total > 0 ? `${currentPage * 50 + 1}–${Math.min((currentPage + 1) * 50, total)} of ${total}` : "Empty";
}

let senderStatuses = {};

async function renderMessageList() {
  const list = $("#messageList");
  list.innerHTML = "";

  // Bulk fetch sender list statuses for coloring
  try {
    senderStatuses = await gideon.senderStatusBulk(currentMessages) || {};
  } catch (e) { senderStatuses = {}; }

  for (const m of currentMessages) {
    const status = senderStatuses[m.from?.address] || null;
    const div = document.createElement("div");
    div.className = "msg-row" + (!m.seen ? " unread" : "") + (m.uid === currentUid ? " active" : "");

    // Color based on list membership
    if (status === "whitelist") {
      div.style.cssText = "background:#f0f0f2;color:#111113;border-left:3px solid #7c6cff";
    } else if (status === "watch") {
      div.style.cssText = "background:#1c1a10;color:#fef3c7;border-left:3px solid #ff9f43";
    } else if (status === "blacklist") {
      div.style.cssText = "background:#1a0a0a;color:#fecaca;border-left:3px solid #f06060";
    } else if (status === "greylist") {
      div.style.cssText = "background:#1a1a1f;color:#7dd3fc;border-left:3px solid #38bdf8";
    }

    const subjectColor = status === "whitelist" ? "color:#2a2a32" : status === "watch" ? "color:#fbbf24" : status === "blacklist" ? "color:#fca5a5" : status === "greylist" ? "color:#7dd3fc" : "";
    const fromColor = status === "whitelist" ? "color:#444" : status === "watch" ? "color:#ff9f43" : status === "greylist" ? "color:#38bdf8" : "";
    const dateColor = status === "whitelist" ? "color:#666" : "";
    const badge = status === "whitelist" ? '<span style="color:#7c6cff;font-size:10px;font-weight:600">VIP</span>'
      : status === "watch" ? '<span style="color:#ff9f43;font-size:10px">WATCH</span>'
      : status === "blacklist" ? '<span style="color:#f06060;font-size:10px">BLOCKED</span>'
      : status === "greylist" ? '<span style="color:#38bdf8;font-size:10px">MUTED</span>'
      : "";

    div.innerHTML = `
      <div class="msg-top">
        <span class="msg-from" style="${fromColor}">${escHtml(m.from?.name || m.from?.address || "Unknown")}</span>
        <span class="msg-date" style="${dateColor}">${formatDate(m.date)}</span>
      </div>
      <div class="msg-subject" style="${subjectColor}">${escHtml(m.subject)}</div>
      <div class="msg-icons">
        ${m.flagged ? '<span class="star">&#9733;</span>' : ""}
        ${m.hasAttachments ? '<span class="clip">&#128206;</span>' : ""}
        ${badge}
      </div>
    `;
    div.addEventListener("click", () => openMessage(m.uid));

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
}

// ── Read message ────────────────────────────────────────────────────────────
async function openMessage(uid) {
  currentUid = uid;
  renderMessageList(); // highlight active

  $("#readPlaceholder").style.display = "none";
  $("#readContent").style.display = "flex";
  $("#readHeader").innerHTML = `<div style="color:var(--fg2);font-size:12px">Loading...</div>`;

  const msg = await gideon.fetchMessage(uid);
  if (msg.error) {
    $("#readHeader").innerHTML = `<div style="color:var(--danger)">${escHtml(msg.error)}</div>`;
    return;
  }

  currentMsg = msg;

  // Mark as read in list
  const listMsg = currentMessages.find((m) => m.uid === uid);
  if (listMsg) { listMsg.seen = true; renderMessageList(); }

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
    const labels = { vip: "VIP", watch: "WATCHING", blocked: "BLOCKED", muted: "MUTED" };
    const colors = { vip: "#3b82f6", watch: "#f59e0b", blocked: "#ef4444", muted: "#64748b" };
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

  const result = await gideon.deleteMessage(currentUid);
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
  await gideon.toggleFlag(currentUid, "flagged");
  const m = currentMessages.find((m) => m.uid === currentUid);
  if (m) m.flagged = !m.flagged;
  renderMessageList();
  $("#btnStar").innerHTML = m?.flagged ? "&#9733;" : "&#9734;";
  $("#btnStar").style.color = m?.flagged ? "#fbbf24" : "";
}

async function downloadAttachment(uid, filename) {
  const result = await gideon.fetchAttachment(uid, filename);
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
async function searchMail(query) {
  const result = await gideon.searchMessages(query);
  if (result.error) return;
  currentMessages = result.messages || [];
  renderMessageList();
  $("#pageInfo").textContent = `${currentMessages.length} results`;
  $("#btnPrev").disabled = true;
  $("#btnNext").disabled = true;
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
      ${currentMsg.html || escHtml(currentMsg.text || "")}
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
      ${currentMsg.html || escHtml(currentMsg.text || "")}
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
      ${currentMsg.html || escHtml(currentMsg.text || "")}`;
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
    opts.references = currentMsg?.references;
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
  $("#cfgTextbeltKey").value = smsCfg.textbeltKey || "";
  $("#cfgSmsResult").textContent = "";
  const alState = await gideon.autolaunchGet();
  $("#cfgAutoLaunch").checked = alState.enabled;
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
}

async function saveSettings() {
  await saveSettingsQuiet();
  $("#settingsModal").style.display = "none";
  loadFolders();
  loadMessages();
}

// ── Unified People renderer ─────────────────────────────────────────────
const ROLE_COLORS = { vip: "#3b82f6", watch: "#f59e0b", blocked: "#ef4444", muted: "#64748b" };
const ROLE_LABELS = { vip: "VIP", watch: "Watch", blocked: "Blocked", muted: "Muted" };
const ROLE_DESC = { vip: "Always texts you", watch: "AI analyzes + actions", blocked: "Dark red, auto-deletes in 7 days", muted: "Grey, no notifications" };

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
  const groups = { vip: [], watch: [], blocked: [], muted: [] };
  for (const p of people) groups[p.role]?.push(p);

  for (const role of ["vip", "watch", "blocked", "muted"]) {
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
      info.innerHTML = `<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.name || item.address}</div>` +
        (item.name ? `<div style="font-size:10px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis">${item.address}</div>` : "");

      // Role dropdown (change role inline)
      const roleSel = document.createElement("select");
      roleSel.style.cssText = "padding:2px 4px;background:var(--bg2);border:1px solid var(--bg3);border-radius:3px;color:var(--fg);font-size:10px;cursor:pointer";
      for (const r of ["vip", "watch", "blocked", "muted"]) {
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
    info.innerHTML = `<div style="font-weight:600;font-size:12px">${item.name || item.address}</div>` +
      (item.name ? `<div style="font-size:10px;color:var(--fg2)">${item.address}</div>` : "");

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
  $("#sfPhishtank").checked = sf.phishtank || false;
  $("#sfAbuseipdb").checked = sf.abuseipdb || false;
  $("#sfClamav").checked = sf.clamav || false;
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
  $("#rulesModal").style.display = "flex";
  renderPeople();
  renderSettingsInstructions();
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
    phishtank: $("#sfPhishtank").checked,
    abuseipdb: $("#sfAbuseipdb").checked,
    clamav: $("#sfClamav").checked,
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
    { label: "Delete all LOW", action: async () => { addAIMessage("Tell me which emails to delete — e.g., 'delete all newsletters' or 'delete #3, #5, #7'", "system"); } },
    { label: "Star all URGENT", action: async () => { addAIMessage("Starring urgent emails... Tell me which ones to star.", "system"); } },
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
    { label: "Delete", icon: "🗑", action: async () => { if (confirm("Delete this email?")) { await gideon.deleteMessage(currentMsg.uid); addAIMessage("Deleted.", "system"); loadMessages(); } } },
    { label: "Star", icon: "⭐", action: async () => { await gideon.toggleFlag(currentMsg.uid, "flagged"); addAIMessage("Flagged.", "system"); } },
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
