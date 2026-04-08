//server.js
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
const {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_TRANSFER_LANES,
  createChunkedTransferServer,
  getTransferPort,
  sendChunkedTransfer,
} = require("./chunkedTcpTransfer");
const { discoverHost: scanForHost } = require("./networkDiscovery");
const { createNearbyDiscovery } = require("./nearbyDiscovery");
const { createWiFiDirectDiscovery } = require("./wifiDirectDiscovery");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const RECEIVED_DIR = path.join(ROOT, "Received");
const TRANSFER_STATE_DIR = path.join(RUNTIME_DIR, "transfers");
const OUTGOING_TRANSFER_DIR = path.join(TRANSFER_STATE_DIR, "outgoing");
const INCOMING_TRANSFER_DIR = path.join(TRANSFER_STATE_DIR, "incoming");
const HOST_SCRIPT = path.join(ROOT, "scripts", "start-wifi-direct-host.ps1");
const JOIN_SCRIPT = path.join(ROOT, "scripts", "join-wifi-direct.ps1");
const PORT = Number(process.env.APP_PORT || 48621);
const TRANSFER_PORT = getTransferPort(PORT);
const DEVICE_ID_FILE = path.join(RUNTIME_DIR, "device-id.txt");
const LOG_FILE = path.join(RUNTIME_DIR, "lubdub-debug.log");
const MAX_JSON_BYTES = 256 * 1024;
const NEARBY_DEVICE_STALE_MS = 12000;
const MAX_DIAGNOSTIC_ENTRIES = 40;

const state = {
  deviceId: "",
  deviceName: process.env.DEVICE_NAME || os.hostname(),
  hostedSession: null,
  joinedSession: null,
  peers: new Map(),
  nearbyDevices: new Map(),
  connectionRequests: new Map(),
  receivedFiles: [],
  diagnostics: [],
  incomingTransfers: new Map(),
};

const services = {
  transferServer: null,
  wifiDirectDiscovery: null,
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
  await fsp.mkdir(TRANSFER_STATE_DIR, { recursive: true });
  await fsp.mkdir(OUTGOING_TRANSFER_DIR, { recursive: true });
  await fsp.mkdir(INCOMING_TRANSFER_DIR, { recursive: true });
  await fsp.appendFile(LOG_FILE, "", "utf8");
}

function pushDiagnostic(event, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    event,
    details,
  };

  state.diagnostics.unshift(entry);
  if (state.diagnostics.length > MAX_DIAGNOSTIC_ENTRIES) {
    state.diagnostics.length = MAX_DIAGNOSTIC_ENTRIES;
  }

  const line = `[LUBDUB DEBUG] ${entry.time} ${event} ${JSON.stringify(details)}`;
  if (event.includes("error")) {
    console.error(line);
  } else {
    console.log(line);
  }

  fsp.appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, "utf8").catch(() => {});
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
      transferPort: TRANSFER_PORT,
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
    diagnostics: state.diagnostics.slice(0, 12),
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
  pushDiagnostic("register.start", { hostIp, port, sessionId });
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
        transferPort: TRANSFER_PORT,
      },
    }),
  });

  if (!response.ok) {
    const message = await readErrorResponse(response);
    pushDiagnostic("register.error", { hostIp, port, sessionId, message });
    throw new Error(message);
  }

  pushDiagnostic("register.success", { hostIp, port, sessionId });
  return response.json();
}

function sanitiseFilename(value) {
  const fallback = "incoming-file";
  const filename = (value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return filename || fallback;
}

function createChunkedFileId({ senderDeviceId, originalName, size, lastModified }) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        senderDeviceId,
        originalName,
        size,
        lastModified,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

function createStoredFilename(originalName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${sanitiseFilename(originalName)}`;
}

function getIncomingTransferStatePath(fileId) {
  return path.join(INCOMING_TRANSFER_DIR, `${fileId}.json`);
}

function getIncomingTransferPartialPath(fileId) {
  return path.join(INCOMING_TRANSFER_DIR, `${fileId}.part`);
}

function getOutgoingTransferPath(transferId, originalName) {
  return path.join(OUTGOING_TRANSFER_DIR, `${transferId}-${sanitiseFilename(originalName)}`);
}

function getChunkCount(size, chunkSize) {
  if (!Number.isFinite(size) || size <= 0) {
    return 0;
  }

  return Math.ceil(size / chunkSize);
}

function buildPendingChunkIndexes(totalChunks, completedChunks) {
  const completed = completedChunks instanceof Set ? completedChunks : new Set(completedChunks || []);
  const pending = [];

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    if (!completed.has(chunkIndex)) {
      pending.push(chunkIndex);
    }
  }

  return pending;
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isCompatibleIncomingTransfer(session, manifest) {
  return (
    session &&
    session.fileId === manifest.fileId &&
    session.senderDeviceId === manifest.senderDeviceId &&
    session.originalName === manifest.originalName &&
    session.size === manifest.size &&
    session.chunkSize === manifest.chunkSize
  );
}

async function persistIncomingTransferState(session) {
  const payload = {
    transferId: session.transferId,
    fileId: session.fileId,
    originalName: session.originalName,
    senderDeviceId: session.senderDeviceId,
    senderName: session.senderName,
    size: session.size,
    lastModified: session.lastModified,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    storedName: session.storedName,
    savedPath: session.savedPath,
    partialPath: session.partialPath,
    completedChunks: Array.from(session.completedChunks).sort((left, right) => left - right),
    updatedAt: new Date().toISOString(),
  };

  await fsp.writeFile(session.statePath, JSON.stringify(payload, null, 2), "utf8");
  session.dirtyChunkCount = 0;
}

async function flushIncomingTransferState(session) {
  if (!session || session.dirtyChunkCount === 0) {
    return;
  }

  await session.writeQueue;
  if (session.dirtyChunkCount === 0) {
    return;
  }

  await persistIncomingTransferState(session);
}

function queueIncomingTransferWrite(session, operation) {
  const nextWrite = session.writeQueue.then(operation);
  session.writeQueue = nextWrite.catch(() => {});
  return nextWrite;
}

async function closeIncomingTransferSession(session) {
  if (!session || session.closed) {
    return;
  }

  session.closed = true;
  await session.writeQueue;
  await session.fileHandle.close();
}

async function closeAllIncomingTransferSessions() {
  const sessions = Array.from(state.incomingTransfers.values());
  await Promise.all(
    sessions.map(async (session) => {
      try {
        await closeIncomingTransferSession(session);
      } catch {
        // Best-effort cleanup while shutting down.
      }
    }),
  );
}

async function createIncomingTransferSession(manifest) {
  const storedName = createStoredFilename(manifest.originalName);
  const savedPath = path.join(RECEIVED_DIR, storedName);
  const partialPath = getIncomingTransferPartialPath(manifest.fileId);
  const statePath = getIncomingTransferStatePath(manifest.fileId);
  const fileHandle = await fsp.open(partialPath, "w+");
  await fileHandle.truncate(manifest.size);

  const session = {
    transferId: manifest.transferId,
    fileId: manifest.fileId,
    originalName: manifest.originalName,
    senderDeviceId: manifest.senderDeviceId,
    senderName: manifest.senderName,
    size: manifest.size,
    lastModified: manifest.lastModified,
    chunkSize: manifest.chunkSize,
    totalChunks: manifest.totalChunks,
    storedName,
    savedPath,
    partialPath,
    statePath,
    fileHandle,
    completedChunks: new Set(),
    dirtyChunkCount: 0,
    writeQueue: Promise.resolve(),
    closed: false,
  };

  await persistIncomingTransferState(session);
  state.incomingTransfers.set(session.fileId, session);
  return session;
}

async function loadIncomingTransferSession(manifest) {
  const statePath = getIncomingTransferStatePath(manifest.fileId);
  const partialPath = getIncomingTransferPartialPath(manifest.fileId);

  if (!(await pathExists(statePath)) || !(await pathExists(partialPath))) {
    return null;
  }

  const rawState = await fsp.readFile(statePath, "utf8");
  const persisted = JSON.parse(rawState);
  const completedChunks = Array.isArray(persisted.completedChunks) ? persisted.completedChunks : [];
  const session = {
    transferId: manifest.transferId,
    fileId: manifest.fileId,
    originalName: persisted.originalName,
    senderDeviceId: persisted.senderDeviceId,
    senderName: manifest.senderName || persisted.senderName,
    size: persisted.size,
    lastModified: persisted.lastModified,
    chunkSize: persisted.chunkSize,
    totalChunks: persisted.totalChunks,
    storedName: persisted.storedName,
    savedPath: persisted.savedPath,
    partialPath,
    statePath,
    fileHandle: await fsp.open(partialPath, "r+"),
    completedChunks: new Set(completedChunks),
    dirtyChunkCount: 0,
    writeQueue: Promise.resolve(),
    closed: false,
  };

  if (!isCompatibleIncomingTransfer(session, manifest)) {
    await session.fileHandle.close();
    return null;
  }

  state.incomingTransfers.set(session.fileId, session);
  return session;
}

async function prepareIncomingChunkTransfer(manifest) {
  let session = state.incomingTransfers.get(manifest.fileId);

  if (!isCompatibleIncomingTransfer(session, manifest)) {
    if (session) {
      await closeIncomingTransferSession(session);
      state.incomingTransfers.delete(manifest.fileId);
    }

    session = await loadIncomingTransferSession(manifest);
  }

  if (!session) {
    session = await createIncomingTransferSession(manifest);
  }

  session.transferId = manifest.transferId;
  session.senderName = manifest.senderName;
  session.lastModified = manifest.lastModified;

  const pendingChunks = buildPendingChunkIndexes(session.totalChunks, session.completedChunks);
  pushDiagnostic("transfer.chunk.prepare", {
    transferId: manifest.transferId,
    fileId: manifest.fileId,
    originalName: manifest.originalName,
    chunkSize: manifest.chunkSize,
    totalChunks: session.totalChunks,
    completedChunks: session.completedChunks.size,
    pendingChunks: pendingChunks.length,
  });

  return {
    transferId: manifest.transferId,
    fileId: manifest.fileId,
    chunkSize: manifest.chunkSize,
    totalChunks: session.totalChunks,
    pendingChunks,
    transferPort: TRANSFER_PORT,
  };
}

async function recordIncomingChunk(chunkHeader, body) {
  const session = state.incomingTransfers.get(chunkHeader.fileId);
  if (!session) {
    throw new Error(`No prepared transfer exists for file ${chunkHeader.fileId}.`);
  }

  if (chunkHeader.transferId !== session.transferId) {
    throw new Error("Transfer session mismatch while writing a chunk.");
  }

  if (body.length !== chunkHeader.length) {
    throw new Error(
      `Chunk ${chunkHeader.chunkIndex} length mismatch. Expected ${chunkHeader.length}, got ${body.length}.`,
    );
  }

  if (!Number.isInteger(chunkHeader.chunkIndex) || chunkHeader.chunkIndex < 0 || chunkHeader.chunkIndex >= session.totalChunks) {
    throw new Error(`Chunk index ${chunkHeader.chunkIndex} is outside the expected range.`);
  }

  if (chunkHeader.offset + chunkHeader.length > session.size) {
    throw new Error(`Chunk ${chunkHeader.chunkIndex} exceeds the expected file size.`);
  }

  await queueIncomingTransferWrite(session, async () => {
    if (!session.completedChunks.has(chunkHeader.chunkIndex)) {
      const { bytesWritten } = await session.fileHandle.write(
        body,
        0,
        body.length,
        chunkHeader.offset,
      );
      if (bytesWritten !== body.length) {
        throw new Error(
          `Chunk ${chunkHeader.chunkIndex} write mismatch. Expected ${body.length}, wrote ${bytesWritten}.`,
        );
      }

      session.completedChunks.add(chunkHeader.chunkIndex);
      session.dirtyChunkCount += 1;

      if (session.dirtyChunkCount >= 16) {
        await persistIncomingTransferState(session);
      }
    }
  });
}

async function handleIncomingTransferLaneComplete(chunkHeader) {
  const session = state.incomingTransfers.get(chunkHeader.fileId);
  if (!session) {
    return;
  }

  await flushIncomingTransferState(session);
  pushDiagnostic("transfer.chunk.lane.received", {
    transferId: session.transferId,
    fileId: session.fileId,
    laneId: chunkHeader.laneId,
    completedChunks: session.completedChunks.size,
    totalChunks: session.totalChunks,
  });
}

async function completeIncomingChunkTransfer(fileId, transferId) {
  const session = state.incomingTransfers.get(fileId) || null;
  if (!session) {
    throw new Error("Transfer session not found on receiver.");
  }

  if (session.transferId !== transferId) {
    throw new Error("Transfer completion did not match the active transfer session.");
  }

  await flushIncomingTransferState(session);
  const pendingChunks = buildPendingChunkIndexes(session.totalChunks, session.completedChunks);
  if (pendingChunks.length > 0) {
    return {
      ok: false,
      pendingChunks,
    };
  }

  await closeIncomingTransferSession(session);
  await fsp.rename(session.partialPath, session.savedPath);
  await fsp.rm(session.statePath, { force: true });
  state.incomingTransfers.delete(fileId);

  state.receivedFiles.unshift({
    id: transferId,
    originalName: session.originalName,
    storedName: session.storedName,
    savedPath: session.savedPath,
    senderName: session.senderName || "Unknown device",
    size: session.size,
    receivedAt: new Date().toISOString(),
  });

  pushDiagnostic("transfer.chunk.receive.complete", {
    transferId,
    fileId,
    originalName: session.originalName,
    savedPath: session.savedPath,
    size: session.size,
    senderName: session.senderName,
  });

  return {
    ok: true,
    savedPath: session.savedPath,
    size: session.size,
  };
}

function resolveTarget(targetDeviceId) {
  if (targetDeviceId === "host" && state.joinedSession) {
    return {
      deviceName: state.joinedSession.hostName,
      ip: state.joinedSession.hostIp,
      port: state.joinedSession.port,
      transferPort: state.joinedSession.transferPort || getTransferPort(state.joinedSession.port),
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
  const storedName = createStoredFilename(originalName);
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

async function preparePeerTransfer(target, manifest) {
  const response = await fetch(`http://${target.ip}:${target.port}/api/transfers/prepare`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(manifest),
  });

  if (!response.ok) {
    throw new Error(await readErrorResponse(response));
  }

  return response.json();
}

async function completePeerTransfer(target, transferId, fileId) {
  const response = await fetch(`http://${target.ip}:${target.port}/api/transfers/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transferId,
      fileId,
    }),
  });

  if (!response.ok) {
    const message = await readErrorResponse(response);
    throw new Error(message);
  }

  return response.json();
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

  const transferId = crypto.randomUUID();
  const originalName = sanitiseFilename(request.headers["x-file-name"]);
  const size = Number(request.headers["x-file-size"] || request.headers["content-length"] || 0);
  const lastModified = Number(request.headers["x-file-last-modified"] || 0) || 0;

  if (!originalName || !Number.isFinite(size) || size <= 0) {
    json(response, 400, { error: "A valid file name and size are required." });
    return;
  }

  const chunkSize = DEFAULT_CHUNK_SIZE;
  const totalChunks = getChunkCount(size, chunkSize);
  const fileId = createChunkedFileId({
    senderDeviceId: state.deviceId,
    originalName,
    size,
    lastModified,
  });
  const outgoingPath = getOutgoingTransferPath(transferId, originalName);
  const manifest = {
    transferId,
    fileId,
    originalName,
    senderDeviceId: state.deviceId,
    senderName: state.deviceName,
    size,
    lastModified,
    chunkSize,
    totalChunks,
    sentAt: new Date().toISOString(),
  };

  pushDiagnostic("transfer.chunk.cache.start", {
    transferId,
    fileId,
    originalName,
    size,
    outgoingPath,
  });
  await pipeline(request, fs.createWriteStream(outgoingPath));
  const outgoingStats = await fsp.stat(outgoingPath);
  if (outgoingStats.size !== size) {
    await fsp.rm(outgoingPath, { force: true });
    throw new Error(`Upload caching mismatch. Expected ${size} bytes, received ${outgoingStats.size}.`);
  }

  pushDiagnostic("transfer.chunk.cache.complete", {
    transferId,
    fileId,
    originalName,
    size,
    outgoingPath,
  });

  try {
    const preparedTransfer = await preparePeerTransfer(target, manifest);
    pushDiagnostic("transfer.chunk.resume", {
      transferId,
      fileId,
      originalName,
      pendingChunks: preparedTransfer.pendingChunks.length,
      totalChunks: preparedTransfer.totalChunks,
      laneCount: Math.min(DEFAULT_TRANSFER_LANES, Math.max(preparedTransfer.pendingChunks.length, 1)),
    });

    await sendChunkedTransfer({
      host: target.ip,
      port: preparedTransfer.transferPort || target.transferPort || getTransferPort(target.port || PORT),
      manifest,
      sourcePath: outgoingPath,
      pendingChunks: preparedTransfer.pendingChunks,
      laneCount: Math.min(
        DEFAULT_TRANSFER_LANES,
        Math.max(preparedTransfer.pendingChunks.length, 1),
      ),
      onDiagnostic: (event, details) => pushDiagnostic(event, details),
    });

    const completedTransfer = await completePeerTransfer(target, transferId, fileId);
    json(response, 200, completedTransfer);
  } finally {
    await fsp.rm(outgoingPath, { force: true }).catch(() => {});
  }
}

async function ensureHostedSession() {
  if (state.hostedSession) {
    pushDiagnostic("host.reuse", {
      sessionId: state.hostedSession.sessionId,
      ssid: state.hostedSession.ssid,
    });
    return {
      created: false,
      hostedStatus: await readHostedStatus(state.hostedSession.statusFile),
    };
  }

  const session = createHostedSession();
  pushDiagnostic("host.prepare", {
    sessionId: session.sessionId,
    ssid: session.ssid,
  });
  const hostedStatus = await startPreparedHostedSession(session);

  return {
    created: true,
    hostedStatus,
  };
}

async function startPreparedHostedSession(session) {
  pushDiagnostic("host.starting", {
    sessionId: session.sessionId,
    ssid: session.ssid,
  });

  let hostedStatus;
  try {
    hostedStatus = await startHostedNetwork({
      ssid: session.ssid,
      passphrase: session.passphrase,
      statusFile: session.statusFile,
      stopFile: session.stopFile,
      scriptPath: HOST_SCRIPT,
    });
  } catch (error) {
    pushDiagnostic("host.start.error", {
      sessionId: session.sessionId,
      ssid: session.ssid,
      message: error.message,
    });
    throw error;
  }

  state.hostedSession = session;
  state.joinedSession = null;
  state.peers.clear();
  state.connectionRequests.clear();

  pushDiagnostic("host.started", {
    sessionId: session.sessionId,
    ssid: session.ssid,
    status: hostedStatus?.status || null,
    message: hostedStatus?.message || null,
  });

  return hostedStatus || readHostedStatus(session.statusFile);
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
  pushDiagnostic("join.start", {
    sessionId: invitePayload.sessionId,
    ssid: invitePayload.ssid,
    hostName: invitePayload.hostName,
    port: invitePayload.port,
  });

  try {
    const joinResult = await joinHostedNetwork({
      ssid: invitePayload.ssid,
      passphrase: invitePayload.passphrase,
      scriptPath: JOIN_SCRIPT,
    });

    pushDiagnostic("join.network.connected", {
      sessionId: invitePayload.sessionId,
      ssid: invitePayload.ssid,
      result: joinResult.stdout || null,
    });
  } catch (error) {
    pushDiagnostic("join.network.error", {
      sessionId: invitePayload.sessionId,
      ssid: invitePayload.ssid,
      message: error.message,
    });
    throw error;
  }

  const discoveryEvents = [];
  let discoveredHost = null;

  if (services.wifiDirectDiscovery) {
    discoveredHost = await services.wifiDirectDiscovery.discoverHost({
      sessionId: invitePayload.sessionId,
      port: invitePayload.port,
      onDiagnostic: (event, details) => {
        discoveryEvents.push({ event, details });
        pushDiagnostic(event, details);
      },
    });
  }

  if (!discoveredHost) {
    pushDiagnostic("join.discovery.fallback.start", {
      sessionId: invitePayload.sessionId,
      ssid: invitePayload.ssid,
    });

    discoveredHost = await scanForHost({
      sessionId: invitePayload.sessionId,
      port: invitePayload.port,
      totalTimeoutMs: 12000,
      onDiagnostic: (event, details) => {
        discoveryEvents.push({ event, details });
        pushDiagnostic(event, details);
      },
    });
  }

  if (!discoveredHost) {
    const latestDiscovery = discoveryEvents.at(-1);
    pushDiagnostic("join.discovery.error", {
      sessionId: invitePayload.sessionId,
      ssid: invitePayload.ssid,
      latestDiscovery: latestDiscovery || null,
    });
    throw new Error("Joined the Wi-Fi Direct session, but could not find the host service.");
  }

  pushDiagnostic("join.discovery.success", {
    sessionId: invitePayload.sessionId,
    ssid: invitePayload.ssid,
    hostIp: discoveredHost.ip,
  });
  const registrationPayload = await registerWithHost(
    discoveredHost.ip,
    invitePayload.sessionId,
    invitePayload.port,
  );

  state.connectionRequests.clear();
  state.joinedSession = {
    sessionId: invitePayload.sessionId,
    ssid: invitePayload.ssid,
    hostName: invitePayload.hostName,
    hostIp: discoveredHost.ip,
    port: invitePayload.port,
    transferPort:
      registrationPayload?.host?.transferPort || getTransferPort(invitePayload.port),
    connectedAt: new Date().toISOString(),
  };

  pushDiagnostic("join.complete", {
    sessionId: invitePayload.sessionId,
    ssid: invitePayload.ssid,
    hostIp: discoveredHost.ip,
  });
}

async function completeApprovedPairRequest(requestId) {
  const pendingRequest = state.connectionRequests.get(requestId);
  if (!pendingRequest || pendingRequest.status !== "joining") {
    return;
  }

  try {
    pushDiagnostic("pair.connect.start", {
      requestId,
      sessionId: pendingRequest.sessionId,
      ssid: pendingRequest.ssid,
      senderName: pendingRequest.senderName,
    });
    await joinSessionFromInviteCode(pendingRequest.inviteCode);
    state.connectionRequests.delete(requestId);
    pushDiagnostic("pair.connect.success", {
      requestId,
      sessionId: pendingRequest.sessionId,
      ssid: pendingRequest.ssid,
    });
  } catch (error) {
    const latestRequest = state.connectionRequests.get(requestId);
    if (!latestRequest) {
      return;
    }

    latestRequest.status = "pending";
    latestRequest.errorMessage = error.message;
    pushDiagnostic("pair.connect.error", {
      requestId,
      sessionId: latestRequest.sessionId,
      ssid: latestRequest.ssid,
      message: error.message,
    });
  }
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

  pushDiagnostic("pair.request.send", {
    targetDeviceId: body.targetDeviceId,
    targetIp: target.ip,
    targetPort: target.port,
    targetName: target.deviceName,
  });

  let hostedStatus = null;
  let inviteSession = state.hostedSession;

  if (!inviteSession) {
    inviteSession = createHostedSession();
  } else {
    hostedStatus = await readHostedStatus(inviteSession.statusFile);
  }

  const requestId = crypto.randomUUID();
  const upstream = await fetch(`http://${target.ip}:${target.port}/api/pair/incoming`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestId,
      inviteCode: inviteSession.inviteCode,
      sender: {
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        port: PORT,
      },
      session: {
        sessionId: inviteSession.sessionId,
        ssid: inviteSession.ssid,
        startedAt: inviteSession.startedAt,
      },
    }),
  });

  if (!upstream.ok) {
    const message = await readErrorResponse(upstream);
    pushDiagnostic("pair.request.error", {
      targetDeviceId: body.targetDeviceId,
      targetIp: target.ip,
      targetPort: target.port,
      message,
    });
    throw new Error(message);
  }

  if (!state.hostedSession) {
    hostedStatus = await startPreparedHostedSession(inviteSession);
  }

  pushDiagnostic("pair.request.sent", {
    requestId,
    sessionId: inviteSession.sessionId,
    ssid: inviteSession.ssid,
    targetDeviceId: body.targetDeviceId,
    targetName: target.deviceName,
  });

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

  pushDiagnostic("pair.request.received", {
    requestId: body.requestId,
    sessionId: body.session.sessionId,
    ssid: body.session.ssid,
    senderName: body.sender.deviceName || "Unknown device",
    senderIp: stripIpv6Prefix(request.socket.remoteAddress || ""),
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
  pushDiagnostic("pair.request.approved", {
    requestId: body.requestId,
    sessionId: pendingRequest.sessionId,
    ssid: pendingRequest.ssid,
    senderName: pendingRequest.senderName,
  });

  json(response, 202, serialiseState(null));

  completeApprovedPairRequest(body.requestId).catch((error) => {
    const latestRequest = state.connectionRequests.get(body.requestId);
    if (!latestRequest) {
      return;
    }

    latestRequest.status = "pending";
    latestRequest.errorMessage = error.message;
  });
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

  pushDiagnostic("pair.request.rejected", {
    requestId: body.requestId,
  });
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
    transferPort: body.peer.transferPort || getTransferPort(body.peer.port || PORT),
    ip: remoteIp,
    connectedAt: new Date().toISOString(),
  };

  state.peers.set(peer.deviceId, peer);
  pushDiagnostic("peer.registered", {
    deviceId: peer.deviceId,
    deviceName: peer.deviceName,
    ip: peer.ip,
    port: peer.port,
    transferPort: peer.transferPort,
    sessionId: body.sessionId,
  });

  json(response, 200, {
    ok: true,
    host: {
      deviceId: state.deviceId,
      deviceName: state.deviceName,
      transferPort: TRANSFER_PORT,
    },
  });
}

async function handleTransferPrepare(request, response) {
  const body = await readJsonBody(request);
  const originalName = sanitiseFilename(body.originalName);
  const size = Number(body.size || 0);
  const chunkSize = Number(body.chunkSize || DEFAULT_CHUNK_SIZE);
  const totalChunks = getChunkCount(size, chunkSize);

  if (!body.transferId || !body.fileId || !originalName || !body.senderDeviceId) {
    json(response, 400, { error: "transferId, fileId, originalName, and senderDeviceId are required." });
    return;
  }

  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(chunkSize) || chunkSize <= 0) {
    json(response, 400, { error: "Transfer size and chunk size must be valid positive numbers." });
    return;
  }

  const preparedTransfer = await prepareIncomingChunkTransfer({
    transferId: body.transferId,
    fileId: body.fileId,
    originalName,
    senderDeviceId: body.senderDeviceId,
    senderName: body.senderName || "Unknown device",
    size,
    lastModified: Number(body.lastModified || 0) || 0,
    chunkSize,
    totalChunks,
  });

  json(response, 200, preparedTransfer);
}

async function handleTransferComplete(request, response) {
  const body = await readJsonBody(request);
  if (!body.transferId || !body.fileId) {
    json(response, 400, { error: "transferId and fileId are required." });
    return;
  }

  const completion = await completeIncomingChunkTransfer(body.fileId, body.transferId);
  if (!completion.ok) {
    json(response, 409, {
      error: "The receiver is still missing chunks for this transfer.",
      pendingChunks: completion.pendingChunks,
    });
    return;
  }

  json(response, 200, completion);
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

    if (request.method === "POST" && url.pathname === "/api/transfers/prepare") {
      await handleTransferPrepare(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/transfers/complete") {
      await handleTransferComplete(request, response);
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
    pushDiagnostic("route.error", {
      path: url.pathname,
      method: request.method,
      message: error.message,
    });
    json(response, 500, {
      error: error.message,
    });
  }
}

async function main() {
  await ensureDirectories();
  state.deviceId = await getOrCreateDeviceId();
  pushDiagnostic("app.start", {
    deviceId: state.deviceId,
    deviceName: state.deviceName,
    port: PORT,
  });

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

  const wifiDirectDiscovery = createWiFiDirectDiscovery({
    getHostAdvertisement: () =>
      state.hostedSession
        ? {
            sessionId: state.hostedSession.sessionId,
            deviceId: state.deviceId,
            deviceName: state.deviceName,
            port: PORT,
          }
        : null,
    onDiagnostic: (event, details) => pushDiagnostic(event, details),
  });

  const transferServer = createChunkedTransferServer({
    port: TRANSFER_PORT,
    onChunk: (chunkHeader, body) => recordIncomingChunk(chunkHeader, body),
    onLaneComplete: (chunkHeader) => handleIncomingTransferLaneComplete(chunkHeader),
    onDiagnostic: (event, details) => pushDiagnostic(event, details),
  });

  services.transferServer = transferServer;
  services.wifiDirectDiscovery = wifiDirectDiscovery;

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
    await transferServer.start();
  } catch (error) {
    console.warn(`Chunked TCP transfer server unavailable: ${error.message}`);
  }

  try {
    await nearbyDiscovery.start();
  } catch (error) {
    console.warn(`Nearby discovery unavailable: ${error.message}`);
  }

  try {
    await wifiDirectDiscovery.start();
  } catch (error) {
    console.warn(`Wi-Fi Direct discovery unavailable: ${error.message}`);
  }

  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    try {
      await stopHostedNetwork();
      await transferServer.stop();
      await nearbyDiscovery.stop();
      await wifiDirectDiscovery.stop();
      await closeAllIncomingTransferSessions();
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
