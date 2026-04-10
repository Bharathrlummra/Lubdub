// chunkedTcpTransfer.js — Optimized chunked file transfer over raw TCP
//
// Optimizations applied:
//   1. BufferList replaces O(n²) Buffer.concat on every TCP data event
//   2. High/low watermark backpressure replaces stop-the-world socket.pause per chunk
//   3. Default chunk size increased from 1 MB to 2 MB
//   4. Default lane count increased from 4 to 6
//   5. TCP socket tuned for throughput

const fs = require("node:fs/promises");
const net = require("node:net");

const TRANSFER_PORT_OFFSET = Number(process.env.TRANSFER_PORT_OFFSET || 10);
const DEFAULT_CHUNK_SIZE = Number(process.env.TRANSFER_CHUNK_SIZE || 2 * 1024 * 1024);
const DEFAULT_TRANSFER_LANES = Number(process.env.TRANSFER_LANES || 6);

// Backpressure thresholds — the socket is only paused when buffered data
// exceeds BACKPRESSURE_HIGH and resumed once it drains below BACKPRESSURE_LOW.
// This replaces the old pattern of pausing on every processBuffer call.
const BACKPRESSURE_HIGH = 64 * 1024 * 1024;
const BACKPRESSURE_LOW = 16 * 1024 * 1024;

// ── BufferList ──────────────────────────────────────────────────────────────
// O(1) append, amortised O(1) consume.
// The old receiver code did `buffer = Buffer.concat([buffer, chunk])` on every
// TCP data event.  That copies the entire accumulated buffer each time → O(n²)
// total allocations for a single file transfer.  BufferList keeps an array of
// incoming buffers and only copies when a consume spans multiple entries.

class BufferList {
  constructor() {
    this._bufs = [];
    this.length = 0;
  }

  push(buf) {
    if (buf.length === 0) return;
    this._bufs.push(buf);
    this.length += buf.length;
  }

  // Read the first 4 bytes without consuming — used to peek at the frame
  // length prefix.  Returns -1 when fewer than 4 bytes are buffered.
  peekUInt32BE() {
    if (this.length < 4) return -1;
    const first = this._bufs[0];
    if (first.length >= 4) return first.readUInt32BE(0);

    // Rare: first buffer is shorter than 4 bytes (TCP fragmentation edge case).
    const temp = Buffer.allocUnsafe(4);
    let written = 0;
    for (const buf of this._bufs) {
      const take = Math.min(buf.length, 4 - written);
      buf.copy(temp, written, 0, take);
      written += take;
      if (written >= 4) break;
    }
    return temp.readUInt32BE(0);
  }

  consume(bytes) {
    if (bytes === 0) return Buffer.alloc(0);

    const first = this._bufs[0];

    // Fast path — exact match with first buffer (very common for chunk bodies).
    if (first.length === bytes) {
      this._bufs.shift();
      this.length -= bytes;
      return first;
    }

    // Fast path — first buffer is larger, subarray without copy.
    if (first.length > bytes) {
      const result = first.subarray(0, bytes);
      this._bufs[0] = first.subarray(bytes);
      this.length -= bytes;
      return result;
    }

    // Slow path — spans multiple buffers; copy into a new allocation.
    const result = Buffer.allocUnsafe(bytes);
    let offset = 0;
    let remaining = bytes;

    while (remaining > 0) {
      const buf = this._bufs[0];
      const take = Math.min(buf.length, remaining);
      buf.copy(result, offset, 0, take);
      offset += take;
      remaining -= take;

      if (take === buf.length) {
        this._bufs.shift();
      } else {
        this._bufs[0] = buf.subarray(take);
      }
    }

    this.length -= bytes;
    return result;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getTransferPort(basePort) {
  return basePort + TRANSFER_PORT_OFFSET;
}

function encodeJsonFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function splitChunksAcrossLanes(chunkIndexes, laneCount) {
  const lanes = Array.from({ length: laneCount }, () => []);

  chunkIndexes.forEach((chunkIndex, index) => {
    lanes[index % laneCount].push(chunkIndex);
  });

  return lanes.filter((lane) => lane.length > 0);
}

function tuneSocket(socket) {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10000);
}

// ── Socket write helpers ────────────────────────────────────────────────────

function writeSocket(socket, buffer) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("drain", handleDrain);
      socket.off("error", handleError);
    };

    const handleDrain = () => {
      cleanup();
      resolve();
    };

    const handleError = (error) => {
      cleanup();
      reject(error);
    };

    socket.once("error", handleError);

    try {
      const canContinue = socket.write(buffer);
      if (canContinue) {
        cleanup();
        resolve();
        return;
      }

      socket.once("drain", handleDrain);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function writeChunk(socket, headerFrame, body) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("drain", handleDrain);
      socket.off("error", handleError);
    };

    const handleDrain = () => {
      cleanup();
      resolve();
    };

    const handleError = (error) => {
      cleanup();
      reject(error);
    };

    socket.once("error", handleError);

    try {
      socket.cork();
      socket.write(headerFrame);
      const bodyOk = socket.write(body);
      socket.uncork();

      if (bodyOk) {
        cleanup();
        resolve();
        return;
      }

      socket.once("drain", handleDrain);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

// ── Transfer Server (receiver side) ─────────────────────────────────────────

function createChunkedTransferServer({
  port,
  onChunk,
  onLaneComplete = async () => {},
  onDiagnostic = () => {},
}) {
  const server = net.createServer((socket) => {
    tuneSocket(socket);

    const bufList = new BufferList();
    let currentHeader = null;
    let processing = false;
    let paused = false;

    // Backpressure: only pause the socket when buffered data is excessive.
    // The old code paused on every processBuffer call, introducing latency
    // gaps where the sender stalled waiting for TCP window space.
    function applyBackpressure() {
      if (!paused && bufList.length > BACKPRESSURE_HIGH) {
        socket.pause();
        paused = true;
      }
    }

    function releaseBackpressure() {
      if (paused && bufList.length < BACKPRESSURE_LOW && !socket.destroyed) {
        socket.resume();
        paused = false;
      }
    }

    function handleProcessError(error) {
      onDiagnostic("transfer.chunk.protocol.error", {
        message: error.message,
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
      });
      socket.destroy(error);
    }

    async function processBuffer() {
      if (processing) return;
      processing = true;

      try {
        while (true) {
          if (!currentHeader) {
            if (bufList.length < 4) break;
            const frameLength = bufList.peekUInt32BE();
            if (frameLength < 0 || bufList.length < 4 + frameLength) break;

            bufList.consume(4);
            const headerBuf = bufList.consume(frameLength);
            currentHeader = JSON.parse(headerBuf.toString("utf8"));

            if (currentHeader.type === "LANE_COMPLETE") {
              await onLaneComplete(currentHeader, socket);
              currentHeader = null;
              releaseBackpressure();
              continue;
            }
          }

          if (!currentHeader || currentHeader.type !== "CHUNK") break;
          if (bufList.length < currentHeader.length) break;

          const body = bufList.consume(currentHeader.length);
          const chunkHeader = currentHeader;
          currentHeader = null;

          releaseBackpressure();
          await onChunk(chunkHeader, body, socket);
        }

        releaseBackpressure();
      } finally {
        processing = false;
      }

      // Data may have arrived during async onChunk work; re-check.
      if (bufList.length >= 4) {
        processBuffer().catch(handleProcessError);
      }
    }

    socket.on("data", (chunk) => {
      bufList.push(chunk);
      applyBackpressure();

      if (!processing) {
        processBuffer().catch(handleProcessError);
      }
    });

    socket.on("error", (error) => {
      onDiagnostic("transfer.chunk.socket.error", {
        message: error.message,
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
      });
    });
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => {
        server.off("error", reject);
        onDiagnostic("transfer.chunk.listen", { port });
        resolve();
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return {
    start,
    stop,
  };
}

// ── Transfer Client (sender side) ───────────────────────────────────────────

async function sendChunkedTransfer({
  host,
  port,
  manifest,
  sourcePath,
  pendingChunks,
  laneCount = DEFAULT_TRANSFER_LANES,
  onChunkSent = () => {},
  onDiagnostic = () => {},
}) {
  const fileHandle = await fs.open(sourcePath, "r");
  const lanes = splitChunksAcrossLanes(pendingChunks, laneCount);

  async function sendLane(chunkIndexes, laneId) {
    const laneStartedAtMs = Date.now();
    const socket = net.createConnection({ host, port });
    tuneSocket(socket);

    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    onDiagnostic("transfer.chunk.lane.start", {
      transferId: manifest.transferId,
      fileId: manifest.fileId,
      laneId,
      chunkCount: chunkIndexes.length,
      targetHost: host,
      targetPort: port,
    });

    let bytesSent = 0;

    try {
      for (const chunkIndex of chunkIndexes) {
        const offset = chunkIndex * manifest.chunkSize;
        const length = Math.min(manifest.chunkSize, manifest.size - offset);
        const body = Buffer.allocUnsafe(length);
        const { bytesRead } = await fileHandle.read({
          buffer: body,
          offset: 0,
          length,
          position: offset,
        });

        if (bytesRead !== length) {
          throw new Error(
            `Expected to read ${length} bytes for chunk ${chunkIndex}, but got ${bytesRead}.`,
          );
        }

        await writeChunk(
          socket,
          encodeJsonFrame({
            type: "CHUNK",
            transferId: manifest.transferId,
            fileId: manifest.fileId,
            laneId,
            chunkIndex,
            offset,
            length,
          }),
          body,
        );
        bytesSent += length;
        onChunkSent({ chunkIndex, length, laneId });
      }

      socket.end(
        encodeJsonFrame({
          type: "LANE_COMPLETE",
          transferId: manifest.transferId,
          fileId: manifest.fileId,
          laneId,
        }),
      );

      await new Promise((resolve, reject) => {
        socket.once("close", () => resolve());
        socket.once("error", reject);
      });

      onDiagnostic("transfer.chunk.lane.complete", {
        transferId: manifest.transferId,
        fileId: manifest.fileId,
        laneId,
        chunkCount: chunkIndexes.length,
        bytesSent,
        durationMs: Math.max(0, Date.now() - laneStartedAtMs),
      });
    } catch (error) {
      socket.destroy(error);
      onDiagnostic("transfer.chunk.lane.error", {
        transferId: manifest.transferId,
        fileId: manifest.fileId,
        laneId,
        chunkCount: chunkIndexes.length,
        message: error.message,
        durationMs: Math.max(0, Date.now() - laneStartedAtMs),
      });
      throw error;
    }
  }

  const sendStartedAtMs = Date.now();
  try {
    await Promise.all(lanes.map((chunkIndexes, index) => sendLane(chunkIndexes, index + 1)));
  } finally {
    await fileHandle.close();
  }

  onDiagnostic("transfer.chunk.send.complete", {
    transferId: manifest.transferId,
    fileId: manifest.fileId,
    laneCount: lanes.length,
    chunkCount: pendingChunks.length,
    durationMs: Math.max(0, Date.now() - sendStartedAtMs),
  });
}

module.exports = {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_TRANSFER_LANES,
  createChunkedTransferServer,
  getTransferPort,
  sendChunkedTransfer,
};
