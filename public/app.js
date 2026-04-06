const deviceCard = document.querySelector("#device-card");
const hostSession = document.querySelector("#host-session");
const joinStatus = document.querySelector("#join-status");
const nearbyDevices = document.querySelector("#nearby-devices");
const incomingRequests = document.querySelector("#incoming-requests");
const peers = document.querySelector("#peers");
const received = document.querySelector("#received");
const targetSelect = document.querySelector("#target-device");
const sendStatus = document.querySelector("#send-status");
const inviteCodeInput = document.querySelector("#invite-code");
const fileInput = document.querySelector("#file-input");

function renderList(container, items, emptyText, renderItem) {
  if (!items.length) {
    container.innerHTML = `<p class="empty">${emptyText}</p>`;
    return;
  }

  container.innerHTML = items.map(renderItem).join("");
}

function describeRole(role) {
  if (role === "host") {
    return "Hosting";
  }

  if (role === "client") {
    return "Connected";
  }

  return "Idle";
}

function renderState(payload) {
  deviceCard.innerHTML = `
    <article class="card">
      <span class="label">Name</span>
      <strong>${payload.device.name}</strong>
    </article>
    <article class="card">
      <span class="label">Device ID</span>
      <strong>${payload.device.id}</strong>
    </article>
    <article class="card">
      <span class="label">Role</span>
      <strong>${payload.role}</strong>
    </article>
  `;

  if (payload.hostedSession) {
    hostSession.innerHTML = `
      <article class="card card-full">
        <span class="label">SSID</span>
        <strong>${payload.hostedSession.ssid}</strong>
      </article>
      <article class="card card-full">
        <span class="label">Passphrase</span>
        <strong>${payload.hostedSession.passphrase}</strong>
      </article>
      <article class="card card-full">
        <span class="label">Invite Code</span>
        <textarea readonly rows="6">${payload.hostedSession.inviteCode}</textarea>
      </article>
      <article class="card card-full">
        <span class="label">Status</span>
        <strong>${payload.hostedSession.status?.status || "Starting"}</strong>
        <p class="muted">${payload.hostedSession.status?.message || ""}</p>
      </article>
    `;
  } else {
    hostSession.innerHTML = `<p class="empty">No hosted session is active.</p>`;
  }

  const joiningRequest = payload.pendingConnectionRequests.find((request) => request.status === "joining");
  const failedRequest = payload.pendingConnectionRequests.find((request) => request.errorMessage);

  if (payload.joinedSession) {
    joinStatus.innerHTML = `
      <article class="card card-full">
        <span class="label">Connected to</span>
        <strong>${payload.joinedSession.hostName}</strong>
      </article>
      <article class="card card-full">
        <span class="label">Host IP</span>
        <strong>${payload.joinedSession.hostIp}</strong>
      </article>
      <article class="card card-full">
        <span class="label">Session</span>
        <strong>${payload.joinedSession.ssid}</strong>
      </article>
    `;
  } else if (joiningRequest) {
    joinStatus.innerHTML = `
      <article class="card card-full">
        <span class="label">Connecting</span>
        <strong>${joiningRequest.ssid}</strong>
        <p class="muted">Approval was accepted. Joining the Wi-Fi Direct session now...</p>
      </article>
    `;
  } else if (failedRequest) {
    joinStatus.innerHTML = `<p class="error">${failedRequest.errorMessage}</p>`;
  } else if (!joinStatus.querySelector(".success,.error,.muted")) {
    joinStatus.innerHTML = `<p class="empty">This device has not joined a host session yet.</p>`;
  }

  renderList(
    nearbyDevices,
    payload.nearbyDevices,
    "No nearby devices discovered yet. Keep both PCs open on this screen.",
    (device) => {
      const canRequest = payload.role !== "client" && device.acceptingRequests;
      const buttonMarkup = canRequest
        ? `<button data-pair-target="${device.deviceId}">Send Connect Request</button>`
        : `<button disabled>${device.acceptingRequests ? "Unavailable" : "Busy"}</button>`;

      return `
        <article class="card card-full">
          <span class="label">${device.deviceName}</span>
          <strong>${describeRole(device.role)}</strong>
          <p class="muted">${device.ip}:${device.port}</p>
          <p class="muted">Last seen ${new Date(device.lastSeenAt).toLocaleTimeString()}</p>
          <div class="actions compact-actions">
            ${buttonMarkup}
          </div>
        </article>
      `;
    },
  );

  renderList(
    incomingRequests,
    payload.pendingConnectionRequests,
    "No connection requests waiting for approval.",
    (request) => {
      const isJoining = request.status === "joining";
      const statusText = isJoining ? "Connecting after approval..." : "Ready for approval";
      const errorMarkup = request.errorMessage
        ? `<p class="error">${request.errorMessage}</p>`
        : "";

      return `
        <article class="card card-full">
          <span class="label">${request.senderName}</span>
          <strong>${request.ssid}</strong>
          <p class="muted">${statusText}</p>
          <p class="muted">Requested at ${new Date(request.sentAt).toLocaleString()}</p>
          ${errorMarkup}
          <div class="actions compact-actions">
            <button data-request-action="approve" data-request-id="${request.requestId}" ${
              isJoining ? "disabled" : ""
            }>Approve & Connect</button>
            <button class="secondary" data-request-action="reject" data-request-id="${request.requestId}" ${
              isJoining ? "disabled" : ""
            }>Decline</button>
          </div>
        </article>
      `;
    },
  );

  renderList(
    peers,
    payload.peers,
    "No peers connected yet.",
    (peer) => `
      <article class="card card-full">
        <span class="label">${peer.deviceName}</span>
        <strong>${peer.ip}:${peer.port}</strong>
        <p class="muted">Connected at ${new Date(peer.connectedAt).toLocaleString()}</p>
      </article>
    `,
  );

  renderList(
    received,
    payload.receivedFiles,
    "No files received yet.",
    (file) => `
      <article class="card card-full">
        <span class="label">${file.originalName}</span>
        <strong>${(file.size / 1024).toFixed(1)} KB</strong>
        <p class="muted">From ${file.senderName}</p>
        <p class="muted">${file.savedPath}</p>
      </article>
    `,
  );

  targetSelect.innerHTML = payload.targets.length
    ? payload.targets
        .map(
          (target) =>
            `<option value="${target.deviceId}">${target.deviceName} (${target.role})</option>`,
        )
        .join("")
    : `<option value="">No target available</option>`;
}

async function fetchState() {
  const response = await fetch("/api/state");
  const payload = await response.json();
  renderState(payload);
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  renderState(payload);
  return payload;
}

document.querySelector("#start-host").addEventListener("click", async () => {
  sendStatus.innerHTML = `<p class="muted">Starting Wi-Fi Direct host session...</p>`;
  try {
    await postJson("/api/host/start");
    sendStatus.innerHTML = `<p class="success">Host session is ready.</p>`;
  } catch (error) {
    sendStatus.innerHTML = `<p class="error">${error.message}</p>`;
  }
});

document.querySelector("#stop-host").addEventListener("click", async () => {
  try {
    await postJson("/api/host/stop");
    sendStatus.innerHTML = `<p class="muted">Host session stopped.</p>`;
  } catch (error) {
    sendStatus.innerHTML = `<p class="error">${error.message}</p>`;
  }
});

document.querySelector("#join-session").addEventListener("click", async () => {
  joinStatus.innerHTML = `<p class="muted">Joining Wi-Fi Direct session and locating the host...</p>`;
  try {
    await postJson("/api/session/join", {
      inviteCode: inviteCodeInput.value.trim(),
    });
    joinStatus.innerHTML = `<p class="success">Joined session successfully.</p>`;
    inviteCodeInput.value = "";
  } catch (error) {
    joinStatus.innerHTML = `<p class="error">${error.message}</p>`;
  }
});

nearbyDevices.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-pair-target]");
  if (!button) {
    return;
  }

  sendStatus.innerHTML = `<p class="muted">Sending connection request...</p>`;

  try {
    await postJson("/api/pair/request", {
      targetDeviceId: button.dataset.pairTarget,
    });
    sendStatus.innerHTML = `<p class="success">Connection request sent. The other device can approve and connect now.</p>`;
  } catch (error) {
    sendStatus.innerHTML = `<p class="error">${error.message}</p>`;
  }
});

incomingRequests.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-request-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.requestAction;
  const requestId = button.dataset.requestId;

  if (action === "approve") {
    joinStatus.innerHTML = `<p class="muted">Approving request and connecting automatically...</p>`;
  }

  try {
    await postJson(`/api/pair/${action}`, { requestId });

    if (action === "approve") {
      joinStatus.innerHTML = `<p class="muted">Approved. Connecting automatically...</p>`;
    } else {
      joinStatus.innerHTML = `<p class="muted">Connection request declined.</p>`;
    }
  } catch (error) {
    joinStatus.innerHTML = `<p class="error">${error.message}</p>`;
  }
});

document.querySelector("#send-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = fileInput.files[0];
  const targetDeviceId = targetSelect.value;

  if (!file || !targetDeviceId) {
    sendStatus.innerHTML = `<p class="error">Choose a target device and a file first.</p>`;
    return;
  }

  sendStatus.innerHTML = `<p class="muted">Sending ${file.name}...</p>`;

  try {
    const response = await fetch(`/api/files/send?targetDeviceId=${encodeURIComponent(targetDeviceId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-file-name": file.name,
      },
      body: file,
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "File transfer failed.");
    }

    sendStatus.innerHTML = `<p class="success">${file.name} sent successfully.</p>`;
    fileInput.value = "";
  } catch (error) {
    sendStatus.innerHTML = `<p class="error">${error.message}</p>`;
  }
});

fetchState();
setInterval(fetchState, 3000);
