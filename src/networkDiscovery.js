const os = require("node:os");

function isPrivateIpv4(address) {
  if (address.startsWith("10.") || address.startsWith("192.168.")) {
    return true;
  }

  const [first, second] = address.split(".").map(Number);
  return first === 172 && second >= 16 && second <= 31;
}

function ipToInt(ip) {
  return ip
    .split(".")
    .map(Number)
    .reduce((acc, octet) => ((acc << 8) | octet) >>> 0, 0);
}

function intToIp(intValue) {
  return [
    (intValue >>> 24) & 255,
    (intValue >>> 16) & 255,
    (intValue >>> 8) & 255,
    intValue & 255,
  ].join(".");
}

function getPrivateInterfaces() {
  const networkInterfaces = os.networkInterfaces();
  const privateInterfaces = [];

  for (const [name, addresses] of Object.entries(networkInterfaces)) {
    for (const address of addresses || []) {
      if (address.internal || address.family !== "IPv4" || !isPrivateIpv4(address.address)) {
        continue;
      }

      privateInterfaces.push({
        name,
        address: address.address,
        netmask: address.netmask,
      });
    }
  }

  return privateInterfaces;
}

function enumerateCandidates() {
  const candidates = new Set();

  for (const iface of getPrivateInterfaces()) {
    const subnetStart = ipToInt(iface.address) & ipToInt(iface.netmask);
    const subnetMask = ipToInt(iface.netmask);
    const hostBits = (~subnetMask) >>> 0;
    const hostCount = Math.min(hostBits - 1, 254);

    for (let offset = 1; offset <= hostCount; offset += 1) {
      const candidate = intToIp((subnetStart + offset) >>> 0);
      if (candidate !== iface.address) {
        candidates.add(candidate);
      }
    }
  }

  return Array.from(candidates).sort((left, right) => {
    const score = (ip) => (ip.endsWith(".1") ? 0 : 1);
    return score(left) - score(right);
  });
}

async function probeHost(ip, sessionId, port, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `http://${ip}:${port}/api/host/probe?sessionId=${encodeURIComponent(sessionId)}`,
      { signal: controller.signal },
    );

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    return { ip, payload };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverHost({ sessionId, port, timeoutMs = 500 }) {
  const candidates = enumerateCandidates();
  const concurrency = 20;
  let cursor = 0;

  while (cursor < candidates.length) {
    const batch = candidates.slice(cursor, cursor + concurrency);
    cursor += concurrency;

    const results = await Promise.all(
      batch.map((ip) => probeHost(ip, sessionId, port, timeoutMs)),
    );

    const match = results.find(Boolean);
    if (match) {
      return match;
    }
  }

  return null;
}

module.exports = {
  discoverHost,
};
