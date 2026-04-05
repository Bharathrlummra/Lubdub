const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");

const {
  joinHostedNetwork,
  readHostedStatus,
  startHostedNetwork,
  stopHostedNetwork,
} = require("./wifiDirectManager");
const { discoverHost } = require("./networkDiscovery");
const { createNearbyDiscovery } = require("./nearbyDiscovery");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const RECEIVED_DIR = path.join(ROOT, "Received");
const HOST_SCRIPT = path.join(ROOT, "scripts", "start-wifi-direct-host.ps1");
const JOIN_SCRIPT = path.join(ROOT, "scripts", "join-wifi-direct.ps1");
const PORT = Number(process.env.APP_PORT || 48621);
const DEVICE_ID_FILE = path.join(RUNTIME_DIR, "device-id.txt");
const MAX_JSON_BYTES = 256 * 1024;
const NEARBY_DEVICE_STALE_MS = 12000;

const state = {
  deviceId: "",
  deviceName: process.env.DEVICE_NAME || os.hostname(),
  hostedSession: null,
  joinedSession: null,
  peers: new Map(),
  nearbyDevices: new Map(),
  connectionRequests: new Map(),
  receivedFiles: [],
};

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function stripIpv6Prefix(address) {
  return address.replace(/^::ffff:/, "");
}

function getRole() {
  return state.hostedSession ? "host" : state.joinedSession ? "client" : "idle";
}

async function ensureDirectories() {
  await fsp.mkdir(RUNTIME_DIR, { recursive: true });
  await fsp.mkdir(RECEIVED_DIR, { recursive: true });
}

async function getOrCreateDeviceId() {
  if (fs.existsSync(DEVICE_ID_FILE)) {
    return (await fsp.readFile(DEVICE_ID_FILE, "utf8")).trim();
  }

  const deviceId = crypto.randomUUID();
  await fsp.writeFile(DEVICE_ID_FILE, deviceId, "utf8");
  return deviceId;
}

function createPassphrase() {
  return crypto.randomBytes(9).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
}

function createHostedSession() {
  const sessionId = crypto.randomBytes(4).toString("hex");
  const ssid = `LUBDUB-${sessionId.toUpperCase()}`;
  const passphrase = createPassphrase();
  const invitePayload = {
    sessionId,
    ssid,
    passphrase,
    port: PORT,
    hostName: state.deviceName,
  };

  return {
    sessionId,
    ssid,
    passphrase,
    inviteCode: base64UrlEncode(JSON.stringify(invitePayload)),
    port: PORT,
    startedAt: new Date().toISOString(),
    statusFile: path.join(RUNTIME_DIR, `wifi-direct-${sessionId}.json`),
    stopFile: path.join(RUNTIME_DIR, `wifi-direct-${sessionId}.stop`),
  };
}

function pruneStaleNearbyDevices() {
  const staleBefore = Date.now() - NEARBY_DEVICE_STALE_MS;

  for (const [deviceId, device] of state.nearbyDevices.entries()) {
    if (device.lastSeenMs < staleBefore) {
      state.nearbyDevices.delete(deviceId);
    }
  }
}

function listNearbyDevices() {
  pruneStaleNearbyDevices();

  return Array.from(state.nearbyDevices.values())
    .sort((left, right) => left.deviceName.localeCompare(right.deviceName))
    .map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      ip: device.ip,
      port: device.port,
      role: device.role,
      acceptingRequests: device.acceptingRequests,
      lastSeenAt: device.lastSeenAt,
    }));
}

function listConnectionRequests() {
  return Array.from(state.connectionRequests.values())
    .sort((left, right) => right.sentAt.localeCompare(left.sentAt))
    .map((request) => ({
      requestId: request.requestId,
      senderDeviceId: request.senderDeviceId,
      senderName: request.senderName,
      sessionId: request.sessionId,
      ssid: request.ssid,
      status: request.status,
      errorMessage: request.errorMessage,
      sentAt: request.sentAt,
    }));
}

function serialiseState(hostedStatus = null) {
  const peers = Array.from(state.peers.values()).sort((left, right) =>
    left.deviceName.localeCompare(right.deviceName),
  );

  const targets = state.hostedSession
    ? peers.map((peer) => ({
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        role: "peer",
      }))
    : state.joinedSession
      ? [
          {
            deviceId: "host",
            deviceName: state.joinedSession.hostName,
            role: "host",
          },
        ]
      : [];

  return {
    device: {
      id: state.deviceId,
      name: state.deviceName,
      port: PORT,
    },
    role: getRole(),
    hostedSession: state.hostedSession
      ? {
          sessionId: state.hostedSession.sessionId,
          ssid: state.hostedSession.ssid,
          passphrase: state.hostedSession.passphrase,
          inviteCode: state.hostedSession.inviteCode,
          startedAt: state.hostedSession.startedAt,
          status: hostedStatus,
        }
      : null,
    joinedSession: state.joinedSession,
    peers,
    targets,
    nearbyDevices: listNearbyDevices(),
    pendingConnectionRequests: listConnectionRequests(),
    receivedFiles: state.receivedFiles.slice(0, 10),
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) {
      throw new Error("JSON body too large.");
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(requestPath, response) {
  const resolvedPath = requestPath === "/" ? "/index.html" : requestPath;
  const relativePath = path.normalize(resolvedPath).replace(/^([/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, relativePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    json(response, 403, { error: "Forbidden" });
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    json(response, 404, { error: "Not found" });
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream",
  });

  fs.createReadStream(filePath).pipe(response);
}

async function readErrorResponse(upstream) {
  try {
    const payload = await upstream.json();
    return payload.error || payload.message || `Request failed with status ${upstream.status}.`;
  } catch {
    const message = await upstream.text();
    return message || `Request failed with status ${upstream.status}.`;
  }
}

async function registerWithHost(hostIp, sessionId, port) {
  const response = await fetch(`http://${hostIp}:${port}/api/session/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId,
      peer: {
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        port: PORT,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorResponse(response));
  }
}

function sanitiseFilename(value) {
  const fallback = "incoming-file";
  const filename = (value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return filename || fallback;
}

function resolveTarget(targetDeviceId) {
  if (targetDeviceId === "host" && state.joinedSession) {
    return {
      deviceName: state.joinedSession.hostName,
      ip: state.joinedSession.hostIp,
      port: state.joinedSession.port,
    };
  }

  return state.peers.get(targetDeviceId) || null;
}

function resolveNearbyDevice(targetDeviceId) {
  pruneStaleNearbyDevices();
  return state.nearbyDevices.get(targetDeviceId) || null;
}

function rememberNearbyDevice(payload) {
  if (!payload.deviceId || payload.deviceId === state.deviceId) {
    return;
  }

  state.nearbyDevices.set(payload.deviceId, {
    deviceId: payload.deviceId,
    deviceName: payload.deviceName || "Unknown device",
    ip: payload.ip,
    port: Number(payload.port) || PORT,
    role: payload.role || "idle",
    acceptingRequests: Boolean(payload.acceptingRequests),
    lastSeenAt: new Date().toISOString(),
    lastSeenMs: Date.now(),
  });
}

async function handleFileReceive(request, response) {
  const originalName = sanitiseFilename(request.headers["x-file-name"]);
  const senderName = request.headers["x-sender-name"] || "Unknown device";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const storedName = `${timestamp}-${originalName}`;
  const targetPath = path.join(RECEIVED_DIR, storedName);

  await pipeline(request, fs.createWriteStream(targetPath));

  const stats = await fsp.stat(targetPath);
  state.receivedFiles.unshift({
    id: crypto.randomUUID(),
    originalName,
    storedName,
    savedPath: targetPath,
    senderName,
    size: stats.size,
    receivedAt: new Date().toISOString(),
  });

  json(response, 200, {
    ok: true,
    savedPath: targetPath,
  });
}

async function handleFileSend(request, response, url) {
  const targetDeviceId = url.searchParams.get("targetDeviceId");
  if (!targetDeviceId) {
    json(response, 400, { error: "targetDeviceId is required." });
    return;
  }

  const target = resolveTarget(targetDeviceId);
  if (!target) {
    json(response, 404, { error: "Target device is not connected." });
    return;
  }

  const upstream = await fetch(`http://${target.ip}:${target.port}/api/files/receive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-file-name": request.headers["x-file-name"] || "incoming-file",
      "x-sender-id": state.deviceId,
      "x-sender-name": state.deviceName,
    },
    body: request,
    duplex: "half",
  });

  if (!upstream.ok) {
    json(response, 502, {
      error: `Peer rejected transfer with status ${upstream.status}.`,
    });
    return;
  }

  const payload = await upstream.json();
  json(response, 200, payload);
}

async function ensureHostedSession() {
  if (state.hostedSession) {
    return {
      created: false,
      hostedStatus: await readHostedStatus(state.hostedSession.statusFile),
    };
  }

  const session = createHostedSession();
  await startHostedNetwork({
    ssid: session.ssid,
    passphrase: session.passphrase,
    statusFile: session.statusFile,
    stopFile: session.stopFile,
    scriptPath: HOST_SCRIPT,
  });

  state.hostedSession = session;
  state.joinedSession = null;
  state.peers.clear();
  state.connectionRequests.clear();

  return {
    created: true,
    hostedStatus: await readHostedStatus(session.statusFile),
  };
}

async function joinSessionFromInviteCode(inviteCode) {
  if (!inviteCode) {
    throw new Error("inviteCode is required.");
  }

  if (state.hostedSession) {
    await stopHostedNetwork();
    state.hostedSession = null;
    state.peers.clear();
  }

  state.joinedSession = null;

  const invitePayload = JSON.parse(base64UrlDecode(inviteCode));
  await joinHostedNetwork({
    ssid: invitePayload.ssid,
    passphrase: invitePayload.passphrase,
    scriptPath: JOIN_SCRIPT,
  });

  const discoveredHost = await discoverHost({
    sessionId: invitePayload.sessionId,
    port: invitePayload.port,
  });

  if (!discoveredHost) {
    throw new Error("Joined the Wi-Fi Direct session, but could not find the host service.");
  }

  await registerWithHost(discoveredHost.ip, invitePayload.sessionId, invitePayload.port);

  state.connectionRequests.clear();
  state.joinedSession = {
    sessionId: invitePayload.sessionId,
    ssid: invitePayload.ssid,
    hostName: invitePayload.hostName,
    hostIp: discoveredHost.ip,
    port: invitePayload.port,
    connectedAt: new Date().toISOString(),
  };
}

async function handleHostStart(response) {
  const { created, hostedStatus } = await ensureHostedSession();
  json(response, created ? 201 : 200, serialiseState(hostedStatus));
}

async function handleHostStop(response) {
  if (state.hostedSession) {
    await stopHostedNetwork();
  }

  state.hostedSession = null;
  state.peers.clear();
  json(response, 200, serialiseState(null));
}

async function handleSessionJoin(request, response) {
  const body = await readJsonBody(request);
  if (!body.inviteCode) {
    json(response, 400, { error: "inviteCode is required." });
    return;
  }

  await joinSessionFromInviteCode(body.inviteCode);
  json(response, 200, serialiseState(null));
}

async function handlePairRequest(request, response) {
  const body = await readJsonBody(request);
  if (!body.targetDeviceId) {
    json(response, 400, { error: "targetDeviceId is required." });
    return;
  }

  if (state.joinedSession) {
    json(response, 409, { error: "This device is already connected to a host session." });
    return;
  }

  const target = resolveNearbyDevice(body.targetDeviceId);
  if (!target) {
    json(response, 404, { error: "The nearby device is no longer reachable." });
    return;
  }

  if (!target.acceptingRequests) {
    json(response, 409, {
      error: "The selected device is busy right now. Ask them to return to the idle screen first.",
    });
    return;
  }

  const { hostedStatus } = await ensureHostedSession();
  const requestId = crypto.randomUUID();
  const upstream = await fetch(`http://${target.ip}:${target.port}/api/pair/incoming`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestId,
      inviteCode: state.hostedSession.inviteCode,
      sender: {
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        port: PORT,
      },
      session: {
        sessionId: state.hostedSession.sessionId,
        ssid: state.hostedSession.ssid,
        startedAt: state.hostedSession.startedAt,
      },
    }),
  });

  if (!upstream.ok) {
    throw new Error(await readErrorResponse(upstream));
  }

  json(response, 200, serialiseState(hostedStatus));
}

async function handleIncomingPairRequest(request, response) {
  const body = await readJsonBody(request);
  if (!body.requestId || !body.inviteCode || !body.sender?.deviceId || !body.session?.sessionId) {
    json(response, 400, { error: "Incomplete connection request payload." });
    return;
  }

  if (state.hostedSession || state.joinedSession) {
    json(response, 409, {
      error: "This device is busy and cannot accept a new connection request right now.",
    });
    return;
  }

  for (const [requestId, existingRequest] of state.connectionRequests.entries()) {
    const sameSender = existingRequest.senderDeviceId === body.sender.deviceId;
    const sameSession = existingRequest.sessionId === body.session.sessionId;
    if (sameSender || sameSession) {
      state.connectionRequests.delete(requestId);
    }
  }

  state.connectionRequests.set(body.requestId, {
    requestId: body.requestId,
    inviteCode: body.inviteCode,
    senderDeviceId: body.sender.deviceId,
    senderName: body.sender.deviceName || "Unknown device",
    senderIp: stripIpv6Prefix(request.socket.remoteAddress || ""),
    sessionId: body.session.sessionId,
    ssid: body.session.ssid,
    sentAt: new Date().toISOString(),
    status: "pending",
    errorMessage: null,
  });

  json(response, 200, { ok: true });
}

async function handlePairApprove(request, response) {
  const body = await readJsonBody(request);
  if (!body.requestId) {
    json(response, 400, { error: "requestId is required." });
    return;
  }

  const pendingRequest = state.connectionRequests.get(body.requestId);
  if (!pendingRequest) {
    json(response, 404, { error: "That connection request is no longer available." });
    return;
  }

  pendingRequest.status = "joining";
  pendingRequest.errorMessage = null;

  try {
    await joinSessionFromInviteCode(pendingRequest.inviteCode);
    state.connectionRequests.delete(body.requestId);
    json(response, 200, serialiseState(null));
  } catch (error) {
    pendingRequest.status = "pending";
    pendingRequest.errorMessage = error.message;
    throw error;
  }
}

async function handlePairReject(request, response) {
  const body = await readJsonBody(request);
  if (!body.requestId) {
    json(response, 400, { error: "requestId is required." });
    return;
  }

  if (!state.connectionRequests.delete(body.requestId)) {
    json(response, 404, { error: "That connection request is no longer available." });
    return;
  }

  json(response, 200, serialiseState(null));
}

async function handlePeerRegister(request, response) {
  if (!state.hostedSession) {
    json(response, 409, { error: "This device is not hosting a session." });
    return;
  }

  const body = await readJsonBody(request);
  if (body.sessionId !== state.hostedSession.sessionId) {
    json(response, 403, { error: "Session mismatch." });
    return;
  }

  const remoteIp = stripIpv6Prefix(request.socket.remoteAddress || "");
  const peer = {
    deviceId: body.peer.deviceId,
    deviceName: body.peer.deviceName,
    port: body.peer.port,
    ip: remoteIp,
    connectedAt: new Date().toISOString(),
  };

  state.peers.set(peer.deviceId, peer);

  json(response, 200, {
    ok: true,
    host: {
      deviceId: state.deviceId,
      deviceName: state.deviceName,
    },
  });
}

async function handleProbe(url, response) {
  const sessionId = url.searchParams.get("sessionId");

  if (!state.hostedSession || sessionId !== state.hostedSession.sessionId) {
    json(response, 404, { ok: false });
    return;
  }

  json(response, 200, {
    ok: true,
    sessionId,
    deviceName: state.deviceName,
  });
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/state") {
      const hostedStatus = state.hostedSession
        ? await readHostedStatus(state.hostedSession.statusFile)
        : null;
      json(response, 200, serialiseState(hostedStatus));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/host/start") {
      await handleHostStart(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/host/stop") {
      await handleHostStop(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/host/probe") {
      await handleProbe(url, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/join") {
      await handleSessionJoin(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pair/request") {
      await handlePairRequest(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pair/incoming") {
      await handleIncomingPairRequest(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pair/approve") {
      await handlePairApprove(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pair/reject") {
      await handlePairReject(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/register") {
      await handlePeerRegister(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/files/send") {
      await handleFileSend(request, response, url);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/files/receive") {
      await handleFileReceive(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/files/received") {
      json(response, 200, { files: state.receivedFiles });
      return;
    }

    if (request.method === "GET") {
      await serveStatic(url.pathname, response);
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 500, {
      error: error.message,
    });
  }
}

async function main() {
  await ensureDirectories();
  state.deviceId = await getOrCreateDeviceId();

  const nearbyDiscovery = createNearbyDiscovery({
    getAdvertisement: () => ({
      deviceId: state.deviceId,
      deviceName: state.deviceName,
      port: PORT,
      role: getRole(),
      acceptingRequests: !state.hostedSession && !state.joinedSession,
    }),
    onPeerDiscovered: rememberNearbyDevice,
  });

  const server = http.createServer((request, response) => {
    route(request, response);
  });

  await new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`LUBDUB listening on http://localhost:${PORT}`);
      resolve();
    });
  });

  try {
    await nearbyDiscovery.start();
  } catch (error) {
    console.warn(`Nearby discovery unavailable: ${error.message}`);
  }

  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    try {
      await stopHostedNetwork();
      await nearbyDiscovery.stop();
    } finally {
      server.close(() => process.exit(0));
    }
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
