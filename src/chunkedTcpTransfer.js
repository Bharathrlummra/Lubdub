const fs = require("node:fs/promises");
const net = require("node:net");

const TRANSFER_PORT_OFFSET = Number(process.env.TRANSFER_PORT_OFFSET || 10);
const DEFAULT_CHUNK_SIZE = Number(process.env.TRANSFER_CHUNK_SIZE || 1024 * 1024);
const DEFAULT_TRANSFER_LANES = Number(process.env.TRANSFER_LANES || 4);

function getTransferPort(basePort) {
  return basePort + TRANSFER_PORT_OFFSET;
}

function encodeJsonFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function parseJsonFrame(buffer) {
  if (buffer.length < 4) {
    return null;
  }

  const frameLength = buffer.readUInt32BE(0);
  if (buffer.length < 4 + frameLength) {
    return null;
  }

  return {
    payload: JSON.parse(buffer.subarray(4, 4 + frameLength).toString("utf8")),
    remainder: buffer.subarray(4 + frameLength),
  };
}

function splitChunksAcrossLanes(chunkIndexes, laneCount) {
  const lanes = Array.from({ length: laneCount }, () => []);

  chunkIndexes.forEach((chunkIndex, index) => {
    lanes[index % laneCount].push(chunkIndex);
  });

  return lanes.filter((lane) => lane.length > 0);
}

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
      const headerOk = socket.write(headerFrame);
      const bodyOk = socket.write(body);
      socket.uncork();

      if (headerOk && bodyOk) {
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

function createChunkedTransferServer({
  port,
  onChunk,
  onLaneComplete = async () => {},
  onDiagnostic = () => {},
}) {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);

    let buffer = Buffer.alloc(0);
    let currentHeader = null;
    let processing = false;

    async function processBuffer() {
      if (processing) {
        return;
      }

      processing = true;
      socket.pause();

      try {
        while (true) {
          if (!currentHeader) {
            const frame = parseJsonFrame(buffer);
            if (!frame) {
              break;
            }

            buffer = frame.remainder;
            currentHeader = frame.payload;

            if (currentHeader.type === "LANE_COMPLETE") {
              await onLaneComplete(currentHeader, socket);
              currentHeader = null;
              continue;
            }
          }

          if (!currentHeader || currentHeader.type !== "CHUNK") {
            break;
          }

          if (buffer.length < currentHeader.length) {
            break;
          }

          const body = buffer.subarray(0, currentHeader.length);
          buffer = buffer.subarray(currentHeader.length);
          const chunkHeader = currentHeader;
          currentHeader = null;
          await onChunk(chunkHeader, body, socket);
        }
      } finally {
        processing = false;
        if (!socket.destroyed) {
          socket.resume();
        }
      }
    }

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer().catch((error) => {
        onDiagnostic("transfer.chunk.protocol.error", {
          message: error.message,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
        });
        socket.destroy(error);
      });
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
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);

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
