const crypto = require("node:crypto");
const dgram = require("node:dgram");
const os = require("node:os");

const WIFI_DIRECT_DISCOVERY_PORT = Number(process.env.WIFI_DIRECT_DISCOVERY_PORT || 48623);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReachableIpv4(address) {
  if (
    address.startsWith("10.") ||
    address.startsWith("192.168.") ||
    address.startsWith("169.254.")
  ) {
    return true;
  }

  const [first, second] = address.split(".").map(Number);
  return first === 172 && second >= 16 && second <= 31;
}

function ipToInt(ip) {
  return ip
    .split(".")
    .map(Number)
    .reduce((accumulator, octet) => ((accumulator << 8) | octet) >>> 0, 0);
}

function intToIp(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

function getReachableInterfaces() {
  const networkInterfaces = os.networkInterfaces();
  const interfaces = [];

  for (const [name, addresses] of Object.entries(networkInterfaces)) {
    for (const address of addresses || []) {
      if (
        address.internal ||
        address.family !== "IPv4" ||
        !isReachableIpv4(address.address) ||
        !address.netmask
      ) {
        continue;
      }

      interfaces.push({
        name,
        address: address.address,
        netmask: address.netmask,
      });
    }
  }

  return interfaces;
}

function getBroadcastAddresses() {
  const addresses = new Set(["255.255.255.255"]);

  for (const iface of getReachableInterfaces()) {
    const ip = ipToInt(iface.address);
    const mask = ipToInt(iface.netmask);
    const broadcast = (ip | (~mask >>> 0)) >>> 0;
    addresses.add(intToIp(broadcast));
  }

  return Array.from(addresses);
}

function findLocalAddressForRemote(remoteAddress) {
  const remoteInt = ipToInt(remoteAddress);

  for (const iface of getReachableInterfaces()) {
    const mask = ipToInt(iface.netmask);
    const localSubnet = ipToInt(iface.address) & mask;
    const remoteSubnet = remoteInt & mask;

    if (localSubnet === remoteSubnet) {
      return iface.address;
    }
  }

  return getReachableInterfaces()[0]?.address || null;
}

function createWiFiDirectDiscovery({
  getHostAdvertisement,
  logger = console,
  onDiagnostic = () => {},
}) {
  const socket = dgram.createSocket("udp4");
  const pendingRequests = new Map();
  let started = false;
  let closed = false;

  function emitDiagnostic(event, details = {}) {
    onDiagnostic(event, details);
  }

  async function sendPacket(payload, address, port) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");

    await new Promise((resolve, reject) => {
      socket.send(body, 0, body.length, port, address, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  socket.on("message", (message, remoteInfo) => {
    let payload;

    try {
      payload = JSON.parse(message.toString("utf8"));
    } catch {
      return;
    }

    if (payload.type === "DISCOVER_HOST") {
      const hostAdvertisement = getHostAdvertisement();
      if (!hostAdvertisement || hostAdvertisement.sessionId !== payload.sessionId) {
        return;
      }

      const hostIp = findLocalAddressForRemote(remoteInfo.address);
      const reply = {
        type: "HOST_READY",
        requestId: payload.requestId,
        sessionId: hostAdvertisement.sessionId,
        hostIp,
        port: hostAdvertisement.port,
        deviceId: hostAdvertisement.deviceId,
        deviceName: hostAdvertisement.deviceName,
      };

      emitDiagnostic("wifi-discovery.request", {
        sessionId: payload.sessionId,
        requestId: payload.requestId,
        remoteAddress: remoteInfo.address,
        remotePort: remoteInfo.port,
      });

      sendPacket(reply, remoteInfo.address, remoteInfo.port)
        .then(() => {
          emitDiagnostic("wifi-discovery.reply", {
            sessionId: payload.sessionId,
            requestId: payload.requestId,
            remoteAddress: remoteInfo.address,
            remotePort: remoteInfo.port,
            hostIp,
            port: hostAdvertisement.port,
          });
        })
        .catch((error) => {
          emitDiagnostic("wifi-discovery.reply.error", {
            sessionId: payload.sessionId,
            requestId: payload.requestId,
            remoteAddress: remoteInfo.address,
            remotePort: remoteInfo.port,
            message: error.message,
          });
        });

      return;
    }

    if (payload.type !== "HOST_READY") {
      return;
    }

    const pendingRequest = pendingRequests.get(payload.requestId);
    if (!pendingRequest || pendingRequest.sessionId !== payload.sessionId) {
      return;
    }

    pendingRequest.match = {
      ip: remoteInfo.address,
      payload,
    };

    pendingRequest.onDiagnostic("wifi-discovery.match", {
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      hostIp: pendingRequest.match.ip,
      advertisedHostIp: payload.hostIp || null,
      hostPort: payload.port,
      remoteAddress: remoteInfo.address,
      remotePort: remoteInfo.port,
    });
  });

  socket.on("error", (error) => {
    logger.warn(`Wi-Fi Direct discovery warning: ${error.message}`);
    emitDiagnostic("wifi-discovery.socket.error", {
      message: error.message,
    });
  });

  async function start() {
    if (started || closed) {
      return;
    }

    await new Promise((resolve, reject) => {
      const handleListening = () => {
        socket.off("error", handleError);

        try {
          socket.setBroadcast(true);
        } catch {
          // Best effort only.
        }

        started = true;
        emitDiagnostic("wifi-discovery.listen", {
          port: WIFI_DIRECT_DISCOVERY_PORT,
        });
        resolve();
      };

      const handleError = (error) => {
        socket.off("listening", handleListening);
        reject(error);
      };

      socket.once("listening", handleListening);
      socket.once("error", handleError);
      socket.bind(WIFI_DIRECT_DISCOVERY_PORT);
    });
  }

  async function stop() {
    if (closed) {
      return;
    }

    closed = true;
    started = false;

    for (const pendingRequest of pendingRequests.values()) {
      pendingRequest.cancelled = true;
    }

    pendingRequests.clear();

    await new Promise((resolve) => {
      socket.close(() => resolve());
    }).catch(() => {});
  }

  async function discoverHost({
    sessionId,
    port,
    totalTimeoutMs = 8000,
    retryDelayMs = 1000,
    onDiagnostic: perCallDiagnostic = () => {},
  }) {
    const requestId = crypto.randomUUID();
    const pendingRequest = {
      sessionId,
      match: null,
      cancelled: false,
      onDiagnostic: perCallDiagnostic,
    };

    pendingRequests.set(requestId, pendingRequest);
    const deadline = Date.now() + totalTimeoutMs;
    let attempt = 0;

    try {
      while (Date.now() < deadline && !pendingRequest.match && !pendingRequest.cancelled) {
        attempt += 1;

        const interfaces = getReachableInterfaces();
        const addresses = getBroadcastAddresses();

        pendingRequest.onDiagnostic("wifi-discovery.discover.send", {
          attempt,
          sessionId,
          requestId,
          port,
          discoveryPort: WIFI_DIRECT_DISCOVERY_PORT,
          interfaces,
          addresses,
        });

        const packet = {
          type: "DISCOVER_HOST",
          requestId,
          sessionId,
          port,
        };

        await Promise.all(
          addresses.map((address) =>
            sendPacket(packet, address, WIFI_DIRECT_DISCOVERY_PORT).catch((error) => {
              pendingRequest.onDiagnostic("wifi-discovery.discover.send.error", {
                attempt,
                sessionId,
                requestId,
                address,
                message: error.message,
              });
            }),
          ),
        );

        if (pendingRequest.match) {
          break;
        }

        const waitMs = Math.max(0, Math.min(retryDelayMs, deadline - Date.now()));
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }

      if (pendingRequest.match) {
        return pendingRequest.match;
      }

      pendingRequest.onDiagnostic("wifi-discovery.timeout", {
        sessionId,
        requestId,
        port,
        totalTimeoutMs,
      });
      return null;
    } finally {
      pendingRequests.delete(requestId);
    }
  }

  return {
    start,
    stop,
    discoverHost,
  };
}

module.exports = {
  WIFI_DIRECT_DISCOVERY_PORT,
  createWiFiDirectDiscovery,
};
