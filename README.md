# LUBDUB Share

LUBDUB Share is a Windows-to-Windows local file sharing prototype inspired by the SHAREit-style flow:

1. discover another nearby PC
2. send a connection request
3. approve the request on the receiver
4. create or join a temporary Wi-Fi Direct session
5. transfer files directly between the two PCs

This README is written as a study guide for the current implementation so you can understand the exact flow we are using now.

## What LUBDUB Is Doing Right Now

The current product has three major stages:

1. `Discovery and approval`
2. `Wi-Fi Direct connection and registration`
3. `Chunked TCP file transfer`

It is currently implemented as a local web app on each PC:

- `Node.js` app server on each machine
- browser UI at `http://localhost:48621`
- PowerShell scripts for Wi-Fi Direct host/join actions
- UDP discovery for fast host detection after join
- TCP chunk transfer for the peer-to-peer file hop

## Current Flow At A Glance

### Normal user flow

On the sender:

1. open LUBDUB
2. wait for the other PC in `Nearby Devices`
3. click `Send Connect Request`
4. after connection, choose a file and click `Send`

On the receiver:

1. open LUBDUB
2. wait for the request in `Connection Requests`
3. click `Approve & Connect`
4. wait for Wi-Fi Direct join and registration
5. receive the file in `Received`

### Current internal flow

1. both PCs advertise themselves on the current LAN
2. sender starts or reuses a Wi-Fi Direct host
3. sender sends a pair request to the receiver over the current LAN
4. receiver approves
5. receiver joins the sender's Wi-Fi Direct SSID
6. receiver uses UDP to discover the host service quickly on the Wi-Fi Direct subnet
7. receiver registers with the host over HTTP
8. sender caches the browser upload to a local temp file
9. sender asks the receiver which chunks are missing
10. sender opens 2 TCP lanes and sends the pending chunks
11. receiver writes chunks by offset into a partial file
12. receiver finalizes the file after all chunks are received

## Modules And Responsibilities

### Core files

- `src/server.js`
  Main application server. Handles HTTP APIs, session state, pair requests, host registration, transfer prepare/complete calls, diagnostics, and startup.

- `src/wifiDirectManager.js`
  Starts and stops the Wi-Fi Direct host and reads host status produced by the PowerShell scripts.

- `src/wifiDirectDiscovery.js`
  Handles UDP `DISCOVER_HOST` and `HOST_READY` style behavior after the receiver joins Wi-Fi Direct.

- `src/networkDiscovery.js`
  Fallback scan-based discovery if UDP discovery does not succeed.

- `src/nearbyDiscovery.js`
  LAN discovery before Wi-Fi Direct connection starts.

- `src/chunkedTcpTransfer.js`
  Current chunked multi-lane TCP data plane.

- `public/app.js`
  Browser-side UI logic. Sends pair actions and file uploads to the local Node app.

- `scripts/start-wifi-direct-host.ps1`
  Starts the Wi-Fi Direct host on Windows.

- `scripts/join-wifi-direct.ps1`
  Joins the Wi-Fi Direct session on Windows.

## Detailed Flow

### 1. App startup

When `npm start` runs:

- `src/server.js` creates the local HTTP server on port `48621`
- starts the chunked transfer TCP server on port `48631`
- starts UDP Wi-Fi discovery on port `48623`
- starts LAN discovery advertisements

Typical logs:

- `app.start`
- `transfer.chunk.listen`
- `wifi-discovery.listen`

### 2. Nearby discovery before pairing

Before Wi-Fi Direct starts, both PCs must usually be reachable on the same existing Wi-Fi or LAN.

LUBDUB uses:

- `src/nearbyDiscovery.js`
- local advertisement and discovery on the current network

This populates the `Nearby Devices` list in the UI.

Important detail:

- this stage is only for finding the other device and sending the pair request
- it is not the final transfer path

### 3. Sender sends a connection request

When the sender clicks `Send Connect Request`:

1. `public/app.js` calls `POST /api/pair/request`
2. `src/server.js` checks the selected nearby device
3. if needed, the sender starts a Wi-Fi Direct host
4. the sender creates an invite payload:
   - `sessionId`
   - `ssid`
   - `passphrase`
   - `port`
   - `hostName`
5. the sender posts this request to the receiver over the current LAN

Important logs:

- `pair.request.send`
- `host.starting`
- `host.started`
- `pair.request.sent`

### 4. Receiver approves and auto-connects

When the receiver clicks `Approve & Connect`:

1. `public/app.js` calls `POST /api/pair/approve`
2. `src/server.js` marks the request as approved
3. the background connect flow starts
4. receiver decodes the invite
5. receiver runs the Wi-Fi Direct join script

Important logs:

- `pair.request.approved`
- `pair.connect.start`
- `join.start`
- `join.network.connected`

At this point, the receiver should be on the `LUBDUB-...` SSID.

### 5. Receiver discovers the host after Wi-Fi Direct join

After joining the Wi-Fi Direct network, the receiver must find the sender's app service.

Current primary path:

- receiver broadcasts UDP discovery using `src/wifiDirectDiscovery.js`
- sender replies with host IP and port
- receiver uses that reply as the host address

Fallback path:

- `src/networkDiscovery.js` scan-based host search

Important logs:

- receiver: `wifi-discovery.discover.send`
- sender: `wifi-discovery.request`
- sender: `wifi-discovery.reply`
- receiver: `wifi-discovery.match`
- receiver: `join.discovery.success`

### 6. Receiver registers with the sender

After the receiver learns the sender IP:

1. receiver calls `POST /api/session/register`
2. sender stores the peer in memory
3. sender returns `transferPort`

This step makes the two devices visible in the app as connected peers.

Important logs:

- `register.start`
- `register.success`
- `peer.registered`
- `join.complete`
- `pair.connect.success`

### 7. Current file transfer flow

This is the most important section for performance study.

When the sender chooses a file in the browser and clicks `Send`:

### Step A: browser uploads the file to the local Node app

`public/app.js` sends:

- `POST /api/files/send`
- headers:
  - `x-file-name`
  - `x-file-size`
  - `x-file-last-modified`

This request goes from:

- browser -> local Node app

This is not yet the peer-to-peer send.

### Step B: sender caches the upload to disk first

In `src/server.js`, the sender currently writes the full upload to:

- `runtime/transfers/outgoing/...`

Important logs:

- `transfer.chunk.cache.start`
- `transfer.chunk.cache.complete`

This is a key current bottleneck.

Right now the sender does:

1. receive full upload from browser
2. save full temp file locally
3. only then start peer-to-peer chunk sending

This adds extra end-to-end delay, especially for `119 MB` and `323 MB` files.

### Step C: sender asks receiver which chunks are missing

After caching is complete:

1. sender calls `POST /api/transfers/prepare`
2. receiver creates or reuses an incoming transfer session
3. receiver calculates which chunks are still missing
4. receiver returns:
   - `fileId`
   - `chunkSize`
   - `totalChunks`
   - `pendingChunks`
   - `transferPort`

Important logs:

- sender: `transfer.chunk.resume`
- receiver: `transfer.chunk.prepare`

### Step D: sender opens TCP data lanes and sends chunks

The actual peer-to-peer file hop is handled by `src/chunkedTcpTransfer.js`.

Current behavior:

- chunk size is `1 MiB`
- lane count is `2` by default
- sender splits pending chunks across 2 lanes
- each lane opens its own TCP socket to port `48631`
- sender sends:
  - a JSON chunk header
  - the chunk bytes
- after all chunks for that lane are sent, that lane sends `LANE_COMPLETE`

Important logs:

- `transfer.chunk.lane.start`
- `transfer.chunk.lane.complete`
- `transfer.chunk.send.complete`

### Step E: receiver writes chunks by offset

On the receiver:

- `src/server.js` keeps an incoming transfer session in memory
- receiver writes each chunk into a `.part` file at the correct offset
- receiver tracks completed chunk indexes
- receiver periodically persists resume state under:
  - `runtime/transfers/incoming/...`

Important logs:

- `transfer.chunk.lane.received`

### Step F: receiver finalizes the file

After sender finishes the data lanes:

1. sender calls `POST /api/transfers/complete`
2. receiver checks whether all chunks are present
3. if complete, receiver renames the partial file into `Received/...`
4. receiver records the transfer in `receivedFiles`

Important logs:

- receiver: `transfer.chunk.receive.complete`

## Why The Current Chunked Flow Is Not Yet Faster For Every File

The current design improved reliability and created the base for resume, but it does not always improve user-visible speed.

Why:

1. `Full cache before send`
   The sender waits for the whole browser upload to finish before peer send starts.

2. `Extra disk I/O`
   We now write:
   - browser -> sender temp file
   - sender temp file -> receiver temp file
   - receiver temp file -> final file

3. `Chunk orchestration overhead`
   We added:
   - prepare call
   - chunk tracking
   - lane coordination
   - finalize call

4. `Resume safety costs`
   The receiver persists incoming state so retries can resume later.

So the current chunked system is best understood as:

- `better reliability foundation`
- `better resume foundation`
- `not yet the fastest end-to-end path`

## Current Performance Reality

Based on recent tests, the current behavior is:

- small and medium files are often not faster than the older single-stream raw TCP path
- large files are more stable
- the biggest visible loss comes from the sender-side cache phase

That means the next speed improvement must come from:

1. `pipelined send while caching`
2. `adaptive transfer modes`
3. `better lane scheduling`
4. `lighter resume persistence`

## Current Diagnostic Events

### Pairing and connection events

- `pair.request.send`
- `pair.request.received`
- `pair.request.approved`
- `pair.connect.start`
- `host.starting`
- `host.started`
- `join.start`
- `join.network.connected`
- `join.network.error`
- `wifi-discovery.discover.send`
- `wifi-discovery.request`
- `wifi-discovery.reply`
- `wifi-discovery.match`
- `wifi-discovery.timeout`
- `discover.scan`
- `discover.match`
- `discover.timeout`
- `register.start`
- `register.success`
- `register.error`
- `peer.registered`
- `join.complete`
- `pair.connect.success`
- `pair.connect.error`

### Transfer events

- `transfer.chunk.listen`
- `transfer.chunk.cache.start`
- `transfer.chunk.cache.complete`
- `transfer.chunk.prepare`
- `transfer.chunk.resume`
- `transfer.chunk.lane.start`
- `transfer.chunk.lane.complete`
- `transfer.chunk.lane.error`
- `transfer.chunk.lane.received`
- `transfer.chunk.send.complete`
- `transfer.chunk.receive.complete`
- `transfer.chunk.protocol.error`
- `transfer.chunk.socket.error`

## Where Files And State Are Stored

### Final received files

- `Received/`

### Sender-side temporary upload cache

- `runtime/transfers/outgoing/`

### Receiver-side partial files and resume state

- `runtime/transfers/incoming/`

### Debug log

- `runtime/lubdub-debug.log`

## Current API Flow

These are the main APIs in the current implementation:

### Pairing and session APIs

- `POST /api/pair/request`
- `POST /api/pair/incoming`
- `POST /api/pair/approve`
- `POST /api/pair/reject`
- `POST /api/session/join`
- `POST /api/session/register`
- `GET /api/host/probe`

### Transfer APIs

- `POST /api/files/send`
  browser upload enters the sender app here

- `POST /api/transfers/prepare`
  sender asks receiver which chunks are missing

- `POST /api/transfers/complete`
  sender asks receiver to finalize the file

## Example End-To-End Sequence

Here is the current real sequence for a successful transfer:

1. both PCs start `npm start`
2. both PCs appear in `Nearby Devices`
3. sender clicks `Send Connect Request`
4. sender starts Wi-Fi Direct host
5. sender sends pair request to receiver
6. receiver clicks `Approve & Connect`
7. receiver joins `LUBDUB-...` SSID
8. receiver broadcasts UDP discovery
9. sender replies with host readiness
10. receiver registers with sender
11. sender chooses a file
12. browser uploads full file to sender app
13. sender writes full temp file locally
14. sender asks receiver for missing chunks
15. receiver returns all chunk indexes as pending
16. sender opens 2 TCP lanes and sends chunk data
17. receiver writes chunks into a partial file
18. sender calls transfer complete
19. receiver renames the file into `Received`
20. UI shows the transfer as finished

## Current Limitations

- still a local web UI, not a packaged desktop app
- Wi-Fi Direct behavior depends on Windows and adapter support
- the `Nearby Devices` flow still depends on the PCs first seeing each other on an existing LAN
- sender currently waits for full browser upload caching before peer send starts
- chunked transfer is better for reliability, but not yet consistently faster for all file sizes
- there is no final file hash verification yet
- there is no transfer encryption layer yet

## What Should Improve Next

If the goal is higher throughput and lower end-to-end latency, the next changes should be:

1. stream `cache + send` in parallel instead of waiting for full cache completion
2. use adaptive transfer modes:
   - smaller files: direct fast path
   - larger files: chunked/resumable path
3. reduce resume-state write overhead
4. improve lane scheduling
5. add integrity verification

## How To Study The Flow In Practice

The easiest way to study the real runtime flow is:

1. start `npm start` on both PCs
2. open `http://localhost:48621` on both PCs
3. send a connection request
4. approve on the receiver
5. transfer one file
6. read the terminal logs in order

The logs will show the exact movement through:

- discovery
- approval
- join
- UDP host discovery
- registration
- cache
- chunk prepare
- TCP lane transfer
- final receive complete

## Status

LUBDUB is currently a working prototype with:

- SHAREit-style request and approval flow
- automatic Wi-Fi Direct join
- UDP host discovery after join
- peer registration
- chunked TCP transfer
- receiver-side resumable transfer state
- diagnostics in terminal, UI, and log file

It is already usable for two-PC testing, and the next work is focused on making the current transfer path faster end-to-end.
