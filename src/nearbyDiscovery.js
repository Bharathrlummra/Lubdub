//nearbyDiscovery.js
const dgram = require("node:dgram");
const os = require("node:os");

const DISCOVERY_PORT = Number(process.env.DISCOVERY_PORT || 48622);
const BEACON_INTERVAL_MS = 2000;

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

function getBroadcastAddresses() {
  const addresses = new Set(["255.255.255.255"]);

  for (const iface of Object.values(os.networkInterfaces())) {
    for (const address of iface || []) {
      if (address.internal || address.family !== "IPv4") {
        continue;
      }

      const ip = ipToInt(address.address);
      const mask = ipToInt(address.netmask);
      const broadcast = (ip | (~mask >>> 0)) >>> 0;
      addresses.add(intToIp(broadcast));
    }
  }

  return Array.from(addresses);
}

function createNearbyDiscovery({ getAdvertisement, onPeerDiscovered, logger = console }) {
  const socket = dgram.createSocket("udp4");
  let beaconTimer = null;
  let isClosed = false;

  socket.on("message", (message, remoteInfo) => {
    try {
      const payload = JSON.parse(message.toString("utf8"));
      if (payload.type !== "lubdub-discovery" || !payload.deviceId) {
        return;
      }

      onPeerDiscovered({
        ...payload,
        ip: remoteInfo.address,
      });
    } catch {
      // Ignore malformed beacons from unrelated traffic.
    }
  });

  socket.on("error", (error) => {
    logger.warn(`Nearby discovery warning: ${error.message}`);
  });

  async function sendBeacon() {
    if (isClosed) {
      return;
    }

    const advertisement = getAdvertisement();
    if (!advertisement || !advertisement.deviceId) {
      return;
    }

    const payload = Buffer.from(
      JSON.stringify({
        type: "lubdub-discovery",
        version: 1,
        ...advertisement,
        sentAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const addresses = getBroadcastAddresses();

    await Promise.all(
      addresses.map(
        (address) =>
          new Promise((resolve) => {
            socket.send(payload, 0, payload.length, DISCOVERY_PORT, address, () => resolve());
          }),
      ),
    );
  }

  async function start() {
    await new Promise((resolve, reject) => {
      const handleListening = () => {
        socket.off("error", handleError);
        try {
          socket.setBroadcast(true);
        } catch {
          // Best effort only.
        }
        resolve();
      };

      const handleError = (error) => {
        socket.off("listening", handleListening);
        reject(error);
      };

      socket.once("listening", handleListening);
      socket.once("error", handleError);
      socket.bind(DISCOVERY_PORT);
    });

    await sendBeacon();
    beaconTimer = setInterval(() => {
      sendBeacon().catch((error) => {
        logger.warn(`Nearby discovery beacon failed: ${error.message}`);
      });
    }, BEACON_INTERVAL_MS);

    if (typeof beaconTimer.unref === "function") {
      beaconTimer.unref();
    }
  }

  async function stop() {
    isClosed = true;

    if (beaconTimer) {
      clearInterval(beaconTimer);
      beaconTimer = null;
    }

    await new Promise((resolve) => {
      socket.close(() => resolve());
    }).catch(() => {});
  }

  return {
    start,
    stop,
  };
}

module.exports = {
  createNearbyDiscovery,
  DISCOVERY_PORT,
};
