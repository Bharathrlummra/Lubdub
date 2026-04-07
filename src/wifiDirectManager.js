//wifiDirectManager.js
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawn, execFile } = require("node:child_process");

const POWERSHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

let hostProcess = null;
let hostSession = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonFile(raw) {
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

function runPowerShellFile(scriptPath, args) {
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL_PATH,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message));
          return;
        }

        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      },
    );
  });
}

async function waitForStatus(statusFile, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(statusFile)) {
      const raw = await fsp.readFile(statusFile, "utf8");
      const parsed = parseJsonFile(raw);

      if (parsed.status === "Error") {
        throw new Error(parsed.message || "Wi-Fi Direct host failed to start.");
      }

      if (parsed.status === "Started") {
        return parsed;
      }
    }

    await sleep(300);
  }

  throw new Error("Timed out while waiting for the Wi-Fi Direct session to start.");
}

async function startHostedNetwork({ ssid, passphrase, statusFile, stopFile, scriptPath }) {
  await fsp.mkdir(require("node:path").dirname(statusFile), { recursive: true });
  await fsp.rm(statusFile, { force: true });
  await fsp.rm(stopFile, { force: true });

  if (hostProcess && !hostProcess.killed) {
    await stopHostedNetwork();
  }

  hostProcess = spawn(
    POWERSHELL_PATH,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-Ssid",
      ssid,
      "-Passphrase",
      passphrase,
      "-StatusFile",
      statusFile,
      "-StopFile",
      stopFile,
    ],
    {
      windowsHide: true,
      stdio: "ignore",
    },
  );

  hostSession = {
    pid: hostProcess.pid,
    statusFile,
    stopFile,
  };

  hostProcess.on("exit", () => {
    hostProcess = null;
    hostSession = null;
  });

  return waitForStatus(statusFile);
}

async function stopHostedNetwork() {
  if (!hostSession) {
    return;
  }

  await fsp.writeFile(hostSession.stopFile, "stop", "utf8");

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!hostProcess || hostProcess.killed || hostProcess.exitCode !== null) {
      return;
    }

    await sleep(250);
  }

  if (hostProcess && hostProcess.exitCode === null) {
    hostProcess.kill();
  }
}

async function joinHostedNetwork({ ssid, passphrase, scriptPath }) {
  return runPowerShellFile(scriptPath, ["-Ssid", ssid, "-Passphrase", passphrase]);
}

async function readHostedStatus(statusFile) {
  if (!statusFile || !fs.existsSync(statusFile)) {
    return null;
  }

  const raw = await fsp.readFile(statusFile, "utf8");
  return parseJsonFile(raw);
}

module.exports = {
  joinHostedNetwork,
  readHostedStatus,
  startHostedNetwork,
  stopHostedNetwork,
};
