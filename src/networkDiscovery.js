const os = require("node:os");
const { execFile } = require("node:child_process");

const ARP_PATH = "C:\\Windows\\System32\\arp.exe";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalReachableIpv4(address) {
  if (address.startsWith("10.") || address.startsWith("192.168.") || address.startsWith("169.254.")) {
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

function getCandidateInterfaces() {
  const networkInterfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addresses] of Object.entries(networkInterfaces)) {
    for (const address of addresses || []) {
      if (
        address.internal ||
        address.family !== "IPv4" ||
        !isLocalReachableIpv4(address.address) ||
        !address.netmask
      ) {
        continue;
      }

      candidates.push({
        name,
        address: address.address,
        netmask: address.netmask,
      });
    }
  }

  return candidates;
}

function enumerateInterfaceCandidates(iface) {
  const candidates = [];
  const ip = ipToInt(iface.address);
  const mask = ipToInt(iface.netmask);
  const subnetStart = ip & mask;
  const hostBits = (~mask) >>> 0;

  if (hostBits <= 255) {
    for (let offset = 1; offset < hostBits; offset += 1) {
      const candidate = intToIp((subnetStart + offset) >>> 0);
      if (candidate !== iface.address) {
        candidates.push(candidate);
      }
    }

    return candidates;
  }

  const local24Start = ip & ipToInt("255.255.255.0");
  for (let offset = 1; offset <= 254; offset += 1) {
    const candidate = intToIp((local24Start + offset) >>> 0);
    if (candidate !== iface.address) {
      candidates.push(candidate);
    }
  }

  const gatewayCandidate = intToIp((subnetStart + 1) >>> 0);
  if (gatewayCandidate !== iface.address) {
    candidates.unshift(gatewayCandidate);
  }

  return candidates;
}

function enumerateCandidates() {
  const candidates = new Set();

  for (const iface of getCandidateInterfaces()) {
    for (const candidate of enumerateInterfaceCandidates(iface)) {
      candidates.add(candidate);
    }
  }

  return Array.from(candidates).sort((left, right) => {
    const score = (ip) => (ip.endsWith(".1") ? 0 : 1);
    return score(left) - score(right);
  });
}

function readArpCandidates() {
  return new Promise((resolve) => {
    execFile(ARP_PATH, ["-a"], { windowsHide: true }, (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }

      const localAddresses = new Set(getCandidateInterfaces().map((iface) => iface.address));
      const matches = stdout.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [];
      const candidates = Array.from(
        new Set(
          matches.filter(
            (address) => isLocalReachableIpv4(address) && !localAddresses.has(address),
          ),
        ),
      );

      resolve(candidates);
    });
  });
}

function buildCandidateList(preferredCandidates, interfaceCandidates) {
  const ordered = [];
  const seen = new Set();

  for (const candidate of [...preferredCandidates, ...interfaceCandidates]) {
    if (seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    ordered.push(candidate);
  }

  return ordered;
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

async function discoverHost({
  sessionId,
  port,
  timeoutMs = 800,
  totalTimeoutMs = 20000,
  retryDelayMs = 1000,
}) {
  const deadline = Date.now() + totalTimeoutMs;
  const concurrency = 20;

  while (Date.now() < deadline) {
    const preferredCandidates = await readArpCandidates();
    const interfaceCandidates = enumerateCandidates();
    const candidates = buildCandidateList(preferredCandidates, interfaceCandidates);
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

    if (Date.now() < deadline) {
      await sleep(retryDelayMs);
    }
  }

  return null;
}

module.exports = {
  discoverHost,
};
