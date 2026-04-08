// app.js — LUBDUB Share frontend

// ── DOM References ──

const deviceBadge = document.querySelector("#device-badge");
const nearbyDevices = document.querySelector("#nearby-devices");
const nearbyCount = document.querySelector("#nearby-count");
const incomingRequests = document.querySelector("#incoming-requests");
const requestCount = document.querySelector("#request-count");
const connectionStatus = document.querySelector("#connection-status");
const connectionPill = document.querySelector("#connection-pill");
const peers = document.querySelector("#peers");
const received = document.querySelector("#received");
const receivedCount = document.querySelector("#received-count");
const diagnostics = document.querySelector("#diagnostics");
const targetSelect = document.querySelector("#target-device");
const sendStatus = document.querySelector("#send-status");
const fileInput = document.querySelector("#file-input");
const dropZone = document.querySelector("#drop-zone");
const fileSelected = document.querySelector("#file-selected");
const selectedFileName = document.querySelector("#selected-file-name");
const selectedFileSize = document.querySelector("#selected-file-size");
const clearFileBtn = document.querySelector("#clear-file");
const sendBtn = document.querySelector("#send-btn");
const progressContainer = document.querySelector("#progress-container");
const progressPhase = document.querySelector("#progress-phase");
const progressPct = document.querySelector("#progress-pct");
const progressFill = document.querySelector("#progress-fill");
const progressSpeed = document.querySelector("#progress-speed");
const progressDetail = document.querySelector("#progress-detail");
const inviteCodeInput = document.querySelector("#invite-code");
const hostSession = document.querySelector("#host-session");

// ── Utilities ──

function esc(text) {
  if (text === null || text === undefined) return "";
  const div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return "";
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m left`;
  return `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m left`;
}

function timeAgo(isoString) {
  const delta = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return new Date(isoString).toLocaleTimeString();
}

// ── Render helpers ──

function renderEmpty(text) {
  return `<p class="empty-text">${esc(text)}</p>`;
}

function renderList(container, items, emptyText, renderItem) {
  if (!items || !items.length) {
    container.innerHTML = renderEmpty(emptyText);
    return;
  }
  container.innerHTML = items.map(renderItem).join("");
}

// ── State Rendering ──

function renderState(payload) {
  // Device badge
  deviceBadge.textContent = `${payload.device.name} · ${payload.role}`;

  // Connection pill
  connectionPill.className = "status-pill";
  if (payload.role === "host") {
    connectionPill.classList.add("hosting");
    connectionPill.textContent = "Hosting";
  } else if (payload.role === "client") {
    connectionPill.classList.add("connected");
    connectionPill.textContent = "Connected";
  } else {
    connectionPill.textContent = "Idle";
  }

  // Connection status
  if (payload.joinedSession) {
    connectionStatus.innerHTML = `
      <div class="card">
        <div class="card-title">Connected to ${esc(payload.joinedSession.hostName)}</div>
        <div class="card-meta">${esc(payload.joinedSession.ssid)} · ${esc(payload.joinedSession.hostIp)}</div>
      </div>`;
  } else if (payload.hostedSession) {
    connectionStatus.innerHTML = `
      <div class="card">
        <div class="card-title">Hosting ${esc(payload.hostedSession.ssid)}</div>
        <div class="card-meta">Status: ${esc(payload.hostedSession.status?.status || "Starting")} · ${esc(payload.hostedSession.status?.message || "")}</div>
      </div>`;
  } else {
    const joiningReq = payload.pendingConnectionRequests.find(r => r.status === "joining");
    const failedReq = payload.pendingConnectionRequests.find(r => r.errorMessage);
    if (joiningReq) {
      connectionStatus.innerHTML = `
        <div class="card">
          <div class="card-title">Connecting to ${esc(joiningReq.ssid)}...</div>
          <div class="card-meta">Approved. Joining Wi-Fi Direct session now.</div>
        </div>`;
    } else if (failedReq) {
      connectionStatus.innerHTML = `<div class="msg msg-error">${esc(failedReq.errorMessage)}</div>`;
    } else {
      connectionStatus.innerHTML = renderEmpty("Not connected. Select a nearby device to start.");
    }
  }

  // Nearby devices
  nearbyCount.textContent = payload.nearbyDevices.length;
  renderList(nearbyDevices, payload.nearbyDevices,
    "Scanning... Keep both PCs on this screen.",
    (device) => {
      const canRequest = payload.role !== "client" && device.acceptingRequests;
      const btnHtml = canRequest
        ? `<button class="btn btn-primary btn-sm" data-pair-target="${esc(device.deviceId)}">Connect</button>`
        : `<button class="btn btn-secondary btn-sm" disabled>${device.acceptingRequests ? "Unavailable" : "Busy"}</button>`;
      return `
        <div class="card">
          <div class="card-title">${esc(device.deviceName)}</div>
          <div class="card-meta">${esc(device.ip)}:${esc(device.port)} · ${timeAgo(device.lastSeenAt)}</div>
          <div class="card-actions">${btnHtml}</div>
        </div>`;
    }
  );

  // Connection requests
  requestCount.textContent = payload.pendingConnectionRequests.length;
  renderList(incomingRequests, payload.pendingConnectionRequests,
    "No pending requests.",
    (req) => {
      const isJoining = req.status === "joining";
      const errorHtml = req.errorMessage ? `<div class="msg msg-error" style="margin-top:8px">${esc(req.errorMessage)}</div>` : "";
      return `
        <div class="card">
          <div class="card-title">${esc(req.senderName)}</div>
          <div class="card-meta">${esc(req.ssid)} · ${isJoining ? "Connecting..." : "Awaiting approval"}</div>
          ${errorHtml}
          <div class="card-actions">
            <button class="btn btn-primary btn-sm" data-request-action="approve" data-request-id="${esc(req.requestId)}" ${isJoining ? "disabled" : ""}>Approve</button>
            <button class="btn btn-outline btn-sm" data-request-action="reject" data-request-id="${esc(req.requestId)}" ${isJoining ? "disabled" : ""}>Decline</button>
          </div>
        </div>`;
    }
  );

  // Peers
  renderList(peers, payload.peers, "No peers connected.",
    (peer) => `
      <div class="card">
        <div class="card-title">${esc(peer.deviceName)}</div>
        <div class="card-meta">${esc(peer.ip)}:${esc(peer.port)}</div>
      </div>`
  );

  // Received files
  receivedCount.textContent = payload.receivedFiles.length;
  renderList(received, payload.receivedFiles.slice(0, 10), "No files received yet.",
    (file) => {
      let hashHtml = "";
      if (file.hashVerified === true) {
        hashHtml = `<span class="hash-badge hash-verified">✓ Verified</span>`;
      } else if (file.hashVerified === false) {
        hashHtml = `<span class="hash-badge hash-failed">✕ Hash mismatch</span>`;
      }
      return `
        <div class="card">
          <div class="card-title">${esc(file.originalName)} ${hashHtml}</div>
          <div class="card-meta">${formatBytes(file.size)} · from ${esc(file.senderName)} · ${timeAgo(file.receivedAt)}</div>
        </div>`;
    }
  );

  // Diagnostics
  renderList(diagnostics, (payload.diagnostics || []).slice(0, 15), "No logs yet.",
    (entry) => `
      <div class="card">
        <div class="card-title">${esc(entry.event)}</div>
        <div class="card-meta">${timeAgo(entry.time)}</div>
        <pre class="diag-pre">${esc(JSON.stringify(entry.details, null, 2))}</pre>
      </div>`
  );

  // Targets
  const prevValue = targetSelect.value;
  targetSelect.innerHTML = payload.targets.length
    ? payload.targets.map(t =>
        `<option value="${esc(t.deviceId)}">${esc(t.deviceName)} (${esc(t.role)})</option>`
      ).join("")
    : `<option value="">No target available</option>`;
  if (prevValue && [...targetSelect.options].some(o => o.value === prevValue)) {
    targetSelect.value = prevValue;
  }
  updateSendButton();

  // Host session (in details panel)
  if (payload.hostedSession) {
    hostSession.innerHTML = `
      <div class="card">
        <div class="card-title">${esc(payload.hostedSession.ssid)}</div>
        <div class="card-meta">Pass: ${esc(payload.hostedSession.passphrase)}</div>
        <div class="card-meta">Status: ${esc(payload.hostedSession.status?.status || "Starting")}</div>
      </div>`;
  } else {
    hostSession.innerHTML = renderEmpty("No active host session.");
  }
}

// ── File Selection ──

let selectedFile = null;

function showFileSelection(file) {
  selectedFile = file;
  selectedFileName.textContent = file.name;
  selectedFileSize.textContent = formatBytes(file.size);
  fileSelected.hidden = false;
  dropZone.style.display = "none";
  updateSendButton();
}

function clearFileSelection() {
  selectedFile = null;
  fileInput.value = "";
  fileSelected.hidden = true;
  dropZone.style.display = "";
  updateSendButton();
}

function updateSendButton() {
  sendBtn.disabled = !selectedFile || !targetSelect.value;
}

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) showFileSelection(fileInput.files[0]);
});

clearFileBtn.addEventListener("click", clearFileSelection);

// Drop zone
dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer.files[0]) showFileSelection(e.dataTransfer.files[0]);
});

targetSelect.addEventListener("change", updateSendButton);

// ── API Helpers ──

async function fetchState() {
  try {
    const res = await fetch("/api/state");
    const payload = await res.json();
    renderState(payload);
  } catch {
    // Silently retry on next poll.
  }
}

async function postJson(url, body = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || "Request failed.");
  if (payload.device) renderState(payload);
  return payload;
}

function showStatus(type, msg) {
  sendStatus.innerHTML = `<div class="msg msg-${type}">${esc(msg)}</div>`;
}

// ── Progress Polling ──

let progressInterval = null;
let lastProgressBytes = 0;
let lastProgressTime = 0;

function startProgressPolling() {
  progressContainer.hidden = false;
  lastProgressBytes = 0;
  lastProgressTime = Date.now();

  progressInterval = setInterval(async () => {
    try {
      const res = await fetch("/api/transfer/progress");
      const data = await res.json();

      if (!data.active || !data.transfer) {
        stopProgressPolling();
        return;
      }

      const t = data.transfer;
      const phaseLabels = {
        caching: "Caching upload...",
        transferring: "Transferring...",
        verifying: "Verifying integrity...",
        complete: "Complete ✓",
        error: "Failed",
      };
      progressPhase.textContent = phaseLabels[t.phase] || t.phase;

      let pct = 0;
      let currentBytes = 0;

      if (t.phase === "caching") {
        pct = t.size > 0 ? Math.round((t.bytesCached / t.size) * 100) : 0;
        currentBytes = t.bytesCached;
      } else if (t.phase === "transferring" || t.phase === "verifying") {
        pct = t.totalChunks > 0 ? Math.round((t.chunksSent / t.totalChunks) * 100) : 0;
        currentBytes = t.chunksSent * (t.size / (t.totalChunks || 1));
      } else if (t.phase === "complete") {
        pct = 100;
        currentBytes = t.size;
      }

      progressPct.textContent = `${Math.min(pct, 100)}%`;
      progressFill.style.width = `${Math.min(pct, 100)}%`;

      // Speed calculation
      const now = Date.now();
      const elapsed = (now - lastProgressTime) / 1000;
      if (elapsed > 0.5) {
        const speed = (currentBytes - lastProgressBytes) / elapsed;
        progressSpeed.textContent = speed > 0 ? formatSpeed(speed) : "";
        const remaining = t.size - currentBytes;
        progressDetail.textContent = speed > 0 ? formatEta(remaining / speed) : formatBytes(t.size);
        lastProgressBytes = currentBytes;
        lastProgressTime = now;
      }

      if (t.phase === "complete") {
        progressPhase.textContent = t.hashVerified === true
          ? "Complete ✓ Verified"
          : t.hashVerified === false
            ? "Complete ⚠ Hash mismatch"
            : "Complete ✓";
        setTimeout(() => stopProgressPolling(), 3000);
      }

      if (t.phase === "error") {
        progressPhase.textContent = `Failed: ${t.error || "Unknown error"}`;
        setTimeout(() => stopProgressPolling(), 5000);
      }
    } catch {
      // Retry next poll.
    }
  }, 500);
}

function stopProgressPolling() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
  setTimeout(() => {
    progressContainer.hidden = true;
    progressFill.style.width = "0%";
    progressPct.textContent = "0%";
    progressSpeed.textContent = "";
    progressDetail.textContent = "";
  }, 300);
}

// ── Send File ──

sendBtn.addEventListener("click", async () => {
  if (!selectedFile || !targetSelect.value) return;

  const file = selectedFile;
  const targetDeviceId = targetSelect.value;

  sendBtn.disabled = true;
  showStatus("info", `Sending ${file.name}...`);
  startProgressPolling();

  try {
    const res = await fetch(`/api/files/send?targetDeviceId=${encodeURIComponent(targetDeviceId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-file-name": file.name,
        "x-file-size": String(file.size),
        "x-file-last-modified": String(file.lastModified || 0),
      },
      body: file,
    });

    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || "File transfer failed.");

    const hashMsg = payload.hashVerified === true
      ? " · Integrity verified ✓"
      : payload.hashVerified === false
        ? " · ⚠ Hash mismatch!"
        : "";
    showStatus("success", `${file.name} sent successfully${hashMsg}`);
    clearFileSelection();
  } catch (error) {
    showStatus("error", error.message);
  } finally {
    sendBtn.disabled = false;
    updateSendButton();
    stopProgressPolling();
  }
});

// ── Nearby device pairing ──

nearbyDevices.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-pair-target]");
  if (!btn) return;
  btn.disabled = true;
  showStatus("info", "Sending connection request...");
  try {
    await postJson("/api/pair/request", { targetDeviceId: btn.dataset.pairTarget });
    showStatus("success", "Request sent. The other device can approve now.");
  } catch (error) {
    showStatus("error", error.message);
  }
});

// ── Connection request handling ──

incomingRequests.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-request-action]");
  if (!btn) return;
  const action = btn.dataset.requestAction;
  const requestId = btn.dataset.requestId;
  btn.disabled = true;
  try {
    await postJson(`/api/pair/${action}`, { requestId });
    if (action === "approve") {
      showStatus("info", "Approved. Connecting...");
    }
  } catch (error) {
    showStatus("error", error.message);
  }
});

// ── Host controls ──

document.querySelector("#start-host").addEventListener("click", async () => {
  showStatus("info", "Starting host session...");
  try {
    await postJson("/api/host/start");
    showStatus("success", "Host session active.");
  } catch (error) {
    showStatus("error", error.message);
  }
});

document.querySelector("#stop-host").addEventListener("click", async () => {
  try {
    await postJson("/api/host/stop");
    showStatus("info", "Host session stopped.");
  } catch (error) {
    showStatus("error", error.message);
  }
});

// ── Manual join ──

document.querySelector("#join-session").addEventListener("click", async () => {
  showStatus("info", "Joining session...");
  try {
    await postJson("/api/session/join", { inviteCode: inviteCodeInput.value.trim() });
    showStatus("success", "Joined session successfully.");
    inviteCodeInput.value = "";
  } catch (error) {
    showStatus("error", error.message);
  }
});

// ── Theme Toggle ──

const themeToggle = document.querySelector("#theme-toggle");
const themeIcon = themeToggle.querySelector(".theme-icon");

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeIcon.textContent = theme === "dark" ? "🌙" : "☀️";
  localStorage.setItem("lubdub-theme", theme);
}

themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});

// Restore saved theme
const savedTheme = localStorage.getItem("lubdub-theme") || "dark";
applyTheme(savedTheme);

// ── Polling ──

fetchState();
setInterval(fetchState, 3000);
