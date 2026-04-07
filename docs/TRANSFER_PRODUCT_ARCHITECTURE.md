# LUBDUB Product Architecture

This document describes how to evolve LUBDUB from a working prototype into a reliable, high-throughput product.

The goal is to keep the current pairing and approval experience, while replacing the slow and fragile transfer path with a better transport architecture.

## Product Goals

The product should optimize for this order:

1. Connection success rate
2. Resume and recovery
3. Throughput
4. Security
5. UX polish

Throughput matters, but a fast transfer that fails often is not a product.

## Current Problems

The current prototype works, but it has structural limits:

- Pair approval and transfer control are mixed into one Node HTTP server
- File transfer uses HTTP request streaming instead of a dedicated data protocol
- Host discovery after Wi-Fi Direct join depends on subnet scanning
- The sender pushes one stream instead of allowing chunk scheduling
- There is no transfer resume
- There is no end-to-end file integrity verification
- There is no session-level encryption

## Target Architecture

Split the system into four layers:

### 1. Pairing Layer

Purpose:

- nearby device discovery before Wi-Fi Direct join
- send pair request
- receiver approval or rejection

Transport:

- existing local HTTP plus UDP broadcast presence

This is the current `Nearby Devices` and `Connection Requests` experience.

### 2. Wi-Fi Direct Session Layer

Purpose:

- create temporary Wi-Fi Direct host
- join temporary Wi-Fi Direct network
- detect session readiness

Transport:

- current PowerShell and WinRT integration

This should remain separate from file transfer.

### 3. Discovery Layer

Purpose:

- find the sender quickly after the receiver joins Wi-Fi Direct

Transport:

- UDP discovery on the Wi-Fi Direct subnet

This should replace subnet-wide probe scanning as the primary path.

### 4. Transfer Layer

Purpose:

- send manifests
- request chunks
- transfer chunks over a few parallel lanes
- resume incomplete transfers
- verify file integrity

Transport:

- raw TCP sockets

This is the main performance improvement.

## Recommended Product Design

Use a split control plane and data plane.

### Control Plane

Use this for:

- session approval
- transfer creation
- manifest negotiation
- progress updates
- retries
- pause and cancel
- diagnostic events

The control plane can stay in Node and can remain HTTP or move to a persistent socket later.

### Data Plane

Use this for:

- actual file chunk transfer

The data plane should use raw TCP sockets, not HTTP uploads.

## Why Raw TCP Instead of HTTP

HTTP is good for control APIs, but it is not ideal for a product-grade local transfer engine.

Raw TCP gives you:

- lower framing overhead
- easier chunk scheduling
- direct control over backpressure
- more predictable resume behavior
- simpler multi-lane transfers

## Recommended Transfer Model

Use receiver-driven chunk scheduling.

That means:

- sender advertises the file and opens data ports
- receiver decides which chunks to request
- receiver tracks which chunks are complete
- receiver can retry only missing chunks

This is better than a sender-only push because it makes resume much simpler and more reliable.

## Protocol Overview

Use a length-prefixed binary protocol for the data plane and simple JSON messages for the control plane.

### Session Objects

#### Pair Session

- `pairSessionId`
- `senderDeviceId`
- `receiverDeviceId`
- `wifiDirectSessionId`
- `createdAt`
- `status`

#### Transfer Session

- `transferId`
- `pairSessionId`
- `fileId`
- `senderDeviceId`
- `receiverDeviceId`
- `chunkSize`
- `chunkCount`
- `status`
- `createdAt`

#### File Manifest

- `fileId`
- `name`
- `size`
- `mimeType`
- `lastModified`
- `chunkSize`
- `chunkCount`
- `fileHash`

## Control Plane Messages

These can stay JSON.

### Pair Messages

#### `PAIR_REQUEST`

```json
{
  "type": "PAIR_REQUEST",
  "pairSessionId": "uuid",
  "sender": {
    "deviceId": "uuid",
    "deviceName": "LAPTOP-A"
  },
  "wifiDirectInvite": {
    "sessionId": "hex",
    "ssid": "LUBDUB-ABC12345",
    "passphrase": "secret",
    "port": 48621
  }
}
```

#### `PAIR_APPROVED`

```json
{
  "type": "PAIR_APPROVED",
  "pairSessionId": "uuid",
  "receiverDeviceId": "uuid",
  "approvedAt": "ISO timestamp"
}
```

#### `PAIR_REJECTED`

```json
{
  "type": "PAIR_REJECTED",
  "pairSessionId": "uuid",
  "receiverDeviceId": "uuid",
  "reason": "busy"
}
```

### Discovery Messages

Use UDP after the receiver joins the Wi-Fi Direct SSID.

#### `DISCOVER_HOST`

```json
{
  "type": "DISCOVER_HOST",
  "pairSessionId": "uuid",
  "wifiDirectSessionId": "hex",
  "receiverDeviceId": "uuid"
}
```

#### `HOST_READY`

```json
{
  "type": "HOST_READY",
  "pairSessionId": "uuid",
  "wifiDirectSessionId": "hex",
  "hostIp": "192.168.137.1",
  "controlPort": 48621,
  "transferControlPort": 48631,
  "dataPorts": [48641, 48642]
}
```

The receiver should broadcast `DISCOVER_HOST` a few times after join.
The sender should respond immediately to any matching session.

This removes the need for broad HTTP subnet probing.

### Transfer Messages

#### `TRANSFER_OFFER`

```json
{
  "type": "TRANSFER_OFFER",
  "transferId": "uuid",
  "pairSessionId": "uuid",
  "manifest": {
    "fileId": "uuid",
    "name": "movie.mp4",
    "size": 338690048,
    "mimeType": "video/mp4",
    "chunkSize": 1048576,
    "chunkCount": 324,
    "fileHash": "hex"
  }
}
```

#### `TRANSFER_ACCEPT`

```json
{
  "type": "TRANSFER_ACCEPT",
  "transferId": "uuid",
  "resumeFrom": {
    "completedChunks": [0, 1, 2, 8, 9]
  }
}
```

#### `TRANSFER_REJECT`

```json
{
  "type": "TRANSFER_REJECT",
  "transferId": "uuid",
  "reason": "user_declined"
}
```

#### `REQUEST_CHUNKS`

```json
{
  "type": "REQUEST_CHUNKS",
  "transferId": "uuid",
  "laneId": 1,
  "chunkIndexes": [3, 4, 5, 6]
}
```

#### `CHUNK_ACK`

```json
{
  "type": "CHUNK_ACK",
  "transferId": "uuid",
  "chunkIndex": 3
}
```

#### `TRANSFER_COMPLETE`

```json
{
  "type": "TRANSFER_COMPLETE",
  "transferId": "uuid",
  "fileHash": "hex",
  "verified": true
}
```

## Data Plane Format

Use a length-prefixed binary frame format.

Each frame:

- `4 bytes`: total frame length
- `1 byte`: message type
- `16 bytes`: transfer ID or a compact transfer key
- `4 bytes`: chunk index
- `8 bytes`: offset
- `4 bytes`: payload length
- `N bytes`: payload

For data chunk frames:

- payload is raw file bytes

Do not use JSON for chunk payload frames.

## Chunk Strategy

Start with these defaults:

- chunk size: `1 MiB`
- lanes: `2`
- maximum lanes: `4`
- socket send and receive buffers: tune experimentally

Why:

- `1 MiB` is large enough to reduce protocol chatter
- `2` lanes improve utilization without overloading Wi-Fi
- `4` is a reasonable upper cap for local wireless links

Do not start with many lanes. Wi-Fi often performs worse when too many sockets compete.

## Resume Design

Resume should be a first-class feature.

### Receiver state

Persist:

- `transferId`
- destination file path
- manifest
- completed chunk bitmap
- current file hash state if supported

Write this metadata in `runtime/transfers/<transferId>.json`.

### Resume flow

1. Sender re-offers the manifest
2. Receiver compares manifest and existing partial file
3. Receiver sends `TRANSFER_ACCEPT` with completed chunks
4. Sender transmits only missing chunks

## Integrity Model

At minimum:

- full-file SHA-256 hash

Better:

- optional per-chunk hash list
- final file hash verification before marking success

If you want higher performance later, `BLAKE3` is attractive, but SHA-256 is a fine product baseline.

## Security Model

Add encryption after the raw TCP path works.

Recommended:

- ephemeral X25519 key exchange
- HKDF session key derivation
- AES-256-GCM for control and data messages

This gives:

- forward secrecy per transfer session
- authenticated encryption
- protection on open local links

Do not rely only on Wi-Fi Direct WPA2 if you want product-grade security.

## Compression

Compression should not be default.

Use it only for files likely to compress well:

- plain text
- CSV
- JSON
- source code

Do not default-compress:

- JPEG
- PNG
- MP4
- ZIP
- APK
- PDF

A useful product rule is:

- if file type is already compressed, skip compression
- if CPU is under pressure, skip compression

## Recommended Refactor for This Repo

Keep the current code, but separate responsibilities.

### Existing modules

- `src/server.js`
- `src/wifiDirectManager.js`
- `src/networkDiscovery.js`
- `src/nearbyDiscovery.js`

### Proposed new modules

- `src/control/pairingController.js`
- `src/control/transferController.js`
- `src/discovery/wifiDirectDiscovery.js`
- `src/transfer/transferServer.js`
- `src/transfer/transferClient.js`
- `src/transfer/transferProtocol.js`
- `src/transfer/chunkScheduler.js`
- `src/transfer/transferStore.js`
- `src/transfer/hash.js`
- `src/transfer/resumeStore.js`
- `src/transfer/encryption.js`

### Recommended responsibilities

#### `src/server.js`

Keep only:

- UI routes
- state routes
- pair request and approval routes
- diagnostics routes

Do not keep heavy file transfer logic here.

#### `src/discovery/wifiDirectDiscovery.js`

Add:

- UDP socket bind
- `DISCOVER_HOST` broadcast receive
- `HOST_READY` response send
- host readiness announcements

#### `src/transfer/transferProtocol.js`

Add:

- frame encoding
- frame decoding
- message constants

#### `src/transfer/transferServer.js`

Add:

- listener for transfer control socket
- listener for data sockets
- manifest serve
- chunk read and send

#### `src/transfer/transferClient.js`

Add:

- connect to sender
- request manifest
- request chunk batches
- write chunks by offset

#### `src/transfer/chunkScheduler.js`

Add:

- lane allocation
- retry queue
- backpressure handling
- completion tracking

#### `src/transfer/resumeStore.js`

Add:

- save progress
- load progress
- clear progress on success

## Migration Plan

Build in phases. Do not rewrite everything at once.

### Phase 1: Stabilize Current Product

Goal:

- fix pairing and host discovery reliability

Tasks:

- keep current UI
- keep current pair approval
- replace HTTP subnet scanning with UDP host discovery after join
- keep current HTTP file transfer temporarily

Success condition:

- connection succeeds consistently after approval

### Phase 2: Introduce Raw TCP Single-Lane Transfer

Goal:

- replace HTTP transfer without adding complexity yet

Tasks:

- keep HTTP control routes
- add raw TCP transfer socket
- send one file over one TCP lane
- verify file hash at end

Success condition:

- raw TCP performs at least as well as current HTTP path
- transfer is stable

### Phase 3: Add Chunked Resume

Goal:

- make transfers resumable and recoverable

Tasks:

- add manifest
- chunk files
- receiver writes by offset
- save completed chunk state

Success condition:

- interrupted transfers resume from progress

### Phase 4: Add Parallel Lanes

Goal:

- improve throughput

Tasks:

- add `2` lanes first
- benchmark
- increase to `4` only if helpful
- make lane count configurable

Success condition:

- throughput improves without hurting reliability

### Phase 5: Add Encryption

Goal:

- secure sessions and transfers

Tasks:

- key exchange
- session keys
- AES-GCM frame protection

Success condition:

- secure local transfer with no large throughput collapse

### Phase 6: Native Engine Optional

Goal:

- push closer to line-rate if Node becomes limiting

Tasks:

- move transfer engine to Rust or another native service
- keep current UI and control APIs

Success condition:

- native transfer engine improves throughput and CPU efficiency

## Performance Measurement Plan

Do not guess. Measure each phase.

Track:

- time to connect after approval
- transfer throughput in MB/s
- retransmission count
- resume success rate
- sender CPU
- receiver CPU
- memory usage
- failure rate over repeated tests

Use this test matrix:

- `100 MB`, `500 MB`, `2 GB`
- one small-file batch
- one large-file transfer
- with firewall enabled
- with moderate signal
- with weak signal

## Product Recommendation

The strongest next move is:

1. replace subnet scan discovery with UDP host discovery
2. move file transfer from HTTP to raw TCP
3. implement receiver-driven chunking and resume
4. add encryption

That path gives the biggest product gains with the least unnecessary rework.
