const net = require("node:net");

const TRANSFER_PORT_OFFSET = Number(process.env.TRANSFER_PORT_OFFSET || 10);

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function parseFrameBuffer(buffer) {
  if (buffer.length < 4) {
    return null;
  }

  const length = buffer.readUInt32BE(0);
  if (buffer.length < 4 + length) {
    return null;
  }

  const payload = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
  const remainder = buffer.subarray(4 + length);
  return {
    payload,
    remainder,
  };
}

function getTransferPort(basePort) {
  return basePort + TRANSFER_PORT_OFFSET;
}

function createRawTcpTransferServer({
  port,
  prepareIncomingTransfer,
  saveIncomingTransfer,
  onDiagnostic = () => {},
}) {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let frameBuffer = Buffer.alloc(0);
    let metadata = null;
    let writeStream = null;
    let targetPath = null;
    let bytesReceived = 0;
    let fileClosed = false;
    let socketFinished = false;
    let finalized = false;
    let preparingTransfer = false;

    function emit(event, details = {}) {
      onDiagnostic(event, details);
    }

    function cleanup(error) {
      if (writeStream && !fileClosed) {
        writeStream.destroy(error);
      }

      if (!socket.destroyed) {
        socket.destroy(error);
      }
    }

    async function finalizeTransfer() {
      if (finalized || !metadata || !socketFinished || !fileClosed) {
        return;
      }

      finalized = true;

      try {
        const result = await saveIncomingTransfer({
          metadata,
          bytesReceived,
          savedPath: targetPath,
        });

        emit("transfer.tcp.receive.complete", {
          transferId: metadata.transferId,
          originalName: metadata.originalName,
          bytesReceived,
          savedPath: targetPath,
          senderName: metadata.senderName,
        });

        socket.end(
          encodeFrame({
            ok: true,
            transferId: metadata.transferId,
            savedPath: targetPath,
            bytesReceived,
            result,
          }),
        );
      } catch (error) {
        emit("transfer.tcp.receive.error", {
          transferId: metadata?.transferId || null,
          originalName: metadata?.originalName || null,
          message: error.message,
        });

        socket.end(
          encodeFrame({
            ok: false,
            transferId: metadata?.transferId || null,
            error: error.message,
          }),
        );
      }
    }

    function writeBody(chunk) {
      if (!writeStream || chunk.length === 0) {
        return;
      }

      bytesReceived += chunk.length;
      if (!writeStream.write(chunk)) {
        socket.pause();
      }
    }

    async function handleData(chunk) {
      if (!metadata) {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
        const parsedFrame = parseFrameBuffer(frameBuffer);
        if (!parsedFrame) {
          return;
        }

        preparingTransfer = true;
        socket.pause();
        metadata = parsedFrame.payload;
        frameBuffer = Buffer.alloc(0);
        const preparedTransfer = await prepareIncomingTransfer(metadata);
        targetPath = preparedTransfer.savedPath;
        writeStream = preparedTransfer.writeStream;

        emit("transfer.tcp.receive.start", {
          transferId: metadata.transferId,
          originalName: metadata.originalName,
          senderName: metadata.senderName,
          senderDeviceId: metadata.senderDeviceId,
          size: metadata.size,
          targetPath,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
        });

        writeStream.on("drain", () => {
          if (!socket.destroyed) {
            socket.resume();
          }
        });

        writeStream.on("error", (error) => {
          emit("transfer.tcp.receive.write.error", {
            transferId: metadata.transferId,
            message: error.message,
          });
          cleanup(error);
        });

        writeStream.on("finish", () => {
          fileClosed = true;
          finalizeTransfer().catch((error) => cleanup(error));
        });

        if (parsedFrame.remainder.length > 0) {
          writeBody(parsedFrame.remainder);
        }

        preparingTransfer = false;
        if (!socketFinished && !socket.destroyed) {
          socket.resume();
        }

        return;
      }

      if (preparingTransfer) {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
        return;
      }

      writeBody(chunk);
    }

    socket.on("data", (chunk) => {
      handleData(chunk).catch((error) => {
        emit("transfer.tcp.receive.protocol.error", {
          message: error.message,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
        });
        cleanup(error);
      });
    });

    socket.on("end", () => {
      socketFinished = true;

      if (!metadata || !writeStream) {
        cleanup(new Error("Transfer ended before metadata header was received."));
        return;
      }

      writeStream.end();
    });

    socket.on("error", (error) => {
      emit("transfer.tcp.socket.error", {
        transferId: metadata?.transferId || null,
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
        onDiagnostic("transfer.tcp.listen", { port });
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

function sendRawTcpTransfer({
  host,
  port,
  metadata,
  sourceStream,
  onDiagnostic = () => {},
}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    let ackBuffer = Buffer.alloc(0);
    let sourcePiped = false;

    function finalize(error, payload) {
      if (settled) {
        return;
      }

      settled = true;

      if (error) {
        if (!socket.destroyed) {
          socket.destroy(error);
        }

        reject(error);
        return;
      }

      if (!socket.destroyed) {
        socket.end();
      }

      resolve(payload);
    }

    socket.on("connect", () => {
      onDiagnostic("transfer.tcp.send.start", {
        transferId: metadata.transferId,
        originalName: metadata.originalName,
        size: metadata.size,
        targetHost: host,
        targetPort: port,
      });

      socket.write(encodeFrame(metadata));
      sourceStream.pipe(socket, { end: true });
      sourcePiped = true;
    });

    socket.on("data", (chunk) => {
      ackBuffer = Buffer.concat([ackBuffer, chunk]);
      const parsedFrame = parseFrameBuffer(ackBuffer);
      if (!parsedFrame) {
        return;
      }

      ackBuffer = parsedFrame.remainder;

      if (!parsedFrame.payload.ok) {
        finalize(new Error(parsedFrame.payload.error || "Peer rejected transfer."));
        return;
      }

      onDiagnostic("transfer.tcp.send.ack", {
        transferId: metadata.transferId,
        originalName: metadata.originalName,
        bytesReceived: parsedFrame.payload.bytesReceived,
        savedPath: parsedFrame.payload.savedPath,
      });

      finalize(null, parsedFrame.payload);
    });

    socket.on("error", (error) => {
      onDiagnostic("transfer.tcp.send.error", {
        transferId: metadata.transferId,
        originalName: metadata.originalName,
        targetHost: host,
        targetPort: port,
        message: error.message,
      });
      finalize(error);
    });

    socket.on("end", () => {
      if (!settled) {
        finalize(new Error("Transfer socket closed before acknowledgement was received."));
      }
    });

    sourceStream.on("error", (error) => {
      onDiagnostic("transfer.tcp.source.error", {
        transferId: metadata.transferId,
        originalName: metadata.originalName,
        message: error.message,
      });

      if (sourcePiped) {
        socket.destroy(error);
      }

      finalize(error);
    });
  });
}

module.exports = {
  createRawTcpTransferServer,
  getTransferPort,
  sendRawTcpTransfer,
};
