# LUBDUB — Offline File Sharing for Windows

LUBDUB is a peer-to-peer file sharing application that transfers files between Windows PCs **without needing internet or a router**. It creates a private Wi-Fi Direct network between two computers and transfers files over optimized raw TCP connections.

Think of it as **AirDrop for Windows** — discover nearby devices, tap connect, and send files.

---

## Estimated Transfer Speeds

| File Size | Estimated Speed | Estimated Time | Chunk Size | Lanes |
|-----------|----------------|----------------|------------|-------|
| 10 MB     | 15–30 MB/s     | < 1 second     | 512 KB     | 2     |
| 100 MB    | 20–40 MB/s     | 3–5 seconds    | 2 MB       | 4     |
| 500 MB    | 25–50 MB/s     | 10–20 seconds  | 8 MB       | 6     |
| 1 GB      | 25–50 MB/s     | 20–40 seconds  | 16 MB      | 6     |
| 2 GB      | 30–50 MB/s     | 40–70 seconds  | 16 MB      | 8     |

> Speeds depend on Wi-Fi Direct hardware (802.11n vs 802.11ac), signal proximity, and disk speed.  
> **Best case**: ~50 MB/s on 802.11ac with devices side-by-side.  
> **Typical case**: ~20–35 MB/s on 802.11n at close range.

---

## How It Works — Complete Flow

The entire file sharing process goes through **6 phases**:

```
┌──────────────────────────────────────────────────────────────────┐
│                        LUBDUB FLOW                               │
│                                                                  │
│  ① Discovery  →  ② Pairing  →  ③ Wi-Fi Direct  →  ④ Host       │
│                    Request       Session Join       Discovery    │
│                                                                  │
│  ⑤ File Transfer (Chunked TCP)  →  ⑥ Verification & ACK        │
└──────────────────────────────────────────────────────────────────┘
```

### Phase 1: Nearby Device Discovery

Both devices run LUBDUB and broadcast their presence using **UDP beacons** on port `48622`.

```
 Device A                                    Device B
    │                                           │
    │──── UDP Broadcast (every 2s) ────────────►│
    │     {                                     │
    │       type: "lubdub-discovery",           │
    │       deviceId: "uuid-a",                 │
    │       deviceName: "LAPTOP-A",             │
    │       port: 48621,                        │
    │       role: "idle",                       │
    │       acceptingRequests: true              │
    │     }                                     │
    │                                           │
    │◄──── UDP Broadcast (every 2s) ───────────│
    │     {                                     │
    │       type: "lubdub-discovery",           │
    │       deviceId: "uuid-b",                 │
    │       deviceName: "LAPTOP-B",             │
    │       ...                                 │
    │     }                                     │
    │                                           │
    ▼                                           ▼
  Both devices see each other in "Nearby Devices" list
```

- **Transport**: UDP broadcast on all network interfaces
- **Beacon interval**: 2 seconds
- **Stale timeout**: 12 seconds (device removed from list)
- **Requirement**: Both devices must be on the same local network (any WiFi)

### Phase 2: Pairing Request

User A clicks "Connect" on Device B. Device A creates a Wi-Fi Direct hotspot and sends a pairing request.

```
 Device A (Sender)                           Device B (Receiver)
    │                                           │
    │  1. Create Wi-Fi Direct session:          │
    │     SSID: "LUBDUB-A1B2C3D4"              │
    │     Passphrase: auto-generated            │
    │     Invite Code: base64url(session info)  │
    │                                           │
    │──── POST /api/pair/incoming ─────────────►│
    │     {                                     │
    │       requestId: "uuid",                  │
    │       inviteCode: "eyJ...",               │
    │       sender: { deviceId, deviceName },   │
    │       session: { sessionId, ssid }        │
    │     }                                     │
    │                                           │
    │◄──── 200 OK ─────────────────────────────│
    │                                           │
    │                          User B sees:     │
    │                          "LAPTOP-A wants   │
    │                           to connect"      │
    │                          [Approve] [Decline]
```

### Phase 3: Wi-Fi Direct Session Join

User B clicks "Approve". Device B disconnects from its current WiFi and joins Device A's Wi-Fi Direct hotspot.

```
 Device A (Host)                             Device B (Client)
    │                                           │
    │  Wi-Fi Direct AP active:                  │
    │  SSID: "LUBDUB-A1B2C3D4"                │
    │  IP: 192.168.137.1                       │
    │                                           │
    │                    ┌──────────────────────┤
    │                    │ 1. Decode inviteCode │
    │                    │ 2. Create WLAN       │
    │                    │    profile XML       │
    │                    │ 3. netsh wlan add    │
    │                    │    profile           │
    │                    │ 4. netsh wlan connect│
    │                    │    name="LUBDUB-..." │
    │                    │ 5. Poll SSID until   │
    │                    │    connected (20s    │
    │                    │    timeout)          │
    │                    └──────────────────────┤
    │                                           │
    │◄════ Wi-Fi Direct Connected ═════════════│
    │      (Private network, no internet)       │
```

- **Technology**: Wi-Fi Direct Legacy Mode via Windows WinRT API
- **Security**: WPA2-PSK with auto-generated 12-char passphrase
- **Network**: Creates an isolated network (typically 192.168.137.x)

### Phase 4: Host Discovery

After joining the Wi-Fi Direct network, Device B needs to find Device A's IP address. Two discovery methods run in sequence:

```
 Device A (Host)                             Device B (Client)
    │                                           │
    │  Method 1: UDP Discovery (fast)           │
    │◄──── UDP Broadcast port 48623 ───────────│
    │     {                                     │
    │       type: "DISCOVER_HOST",              │
    │       requestId: "uuid",                  │
    │       sessionId: "a1b2c3d4"              │
    │     }                                     │
    │                                           │
    │──── UDP Reply ───────────────────────────►│
    │     {                                     │
    │       type: "HOST_READY",                 │
    │       hostIp: "192.168.137.1",           │
    │       port: 48621                         │
    │     }                                     │
    │                                           │
    │  Method 2: Subnet Probe (fallback)        │
    │  If UDP fails, scan ARP table + probe     │
    │  every IP on subnet via HTTP:             │
    │◄──── GET /api/host/probe?sessionId=... ──│
    │──── 200 { ok: true } ───────────────────►│
    │                                           │
    │  Registration:                            │
    │◄──── POST /api/session/register ─────────│
    │     { sessionId, peer: { deviceId, ... } }│
    │──── 200 OK ─────────────────────────────►│
    │                                           │
    ▼                                           ▼
  Devices are now paired and ready to share files
```

- **Primary**: UDP broadcast discovery (port 48623) — resolves in < 1 second
- **Fallback**: ARP table scan + HTTP probes on /24 subnet — resolves in 2-12 seconds

### Phase 5: File Transfer (Chunked TCP)

User selects a file and clicks "Send". The transfer uses a **split architecture**:

- **Control Plane** (HTTP): manifest negotiation, progress tracking, completion verification
- **Data Plane** (Raw TCP): actual file chunk delivery over parallel lanes

```
 Device A (Sender)                           Device B (Receiver)
    │                                           │
    │  ┌─ CACHING PHASE ─────────────────┐     │
    │  │ Browser uploads file to server   │     │
    │  │ Server writes to disk + computes │     │
    │  │ SHA-256 hash inline              │     │
    │  └──────────────────────────────────┘     │
    │                                           │
    │  ┌─ PREPARE PHASE ─────────────────┐     │
    │──┤ POST /api/transfers/prepare     ├────►│
    │  │ {                                │     │ Receiver creates partial file,
    │  │   transferId, fileId,            │     │ pre-allocates disk space,
    │  │   originalName: "movie.mp4",     │     │ returns pending chunk list
    │  │   size: 524288000,               │     │
    │  │   chunkSize: 8388608,            │     │
    │  │   totalChunks: 63,               │     │
    │  │   fileHash: "a1b2c3..."          │     │
    │  │ }                                │     │
    │◄─┤ { pendingChunks: [0,1,...,62],  ├─────│
    │  │   transferPort: 48631 }          │     │
    │  └──────────────────────────────────┘     │
    │                                           │
    │  ┌─ TRANSFER PHASE ────────────────┐     │
    │  │ Open 6 parallel TCP connections │     │
    │  │ to port 48631                    │     │
    │  │                                  │     │
    │  │ Lane 1: chunks [0, 6, 12, ...]  │     │
    │  │ Lane 2: chunks [1, 7, 13, ...]  │     │
    │  │ Lane 3: chunks [2, 8, 14, ...]  │     │
    │  │ Lane 4: chunks [3, 9, 15, ...]  │     │
    │  │ Lane 5: chunks [4, 10, 16, ...] │     │
    │  │ Lane 6: chunks [5, 11, 17, ...] │     │
    │  └──────────────────────────────────┘     │
    │                                           │
    │  Per chunk on the wire:                   │
    │  ┌──────────────────────────────┐         │
    │  │ [4 bytes: header length]     │         │
    │  │ [JSON header: ~180 bytes]    │         │
    │  │ {                            │         │
    │  │   type: "CHUNK",             │         │
    │  │   transferId, fileId,        │         │
    │  │   laneId: 1,                 │         │
    │  │   chunkIndex: 0,             │         │
    │  │   offset: 0,                 │         │
    │  │   length: 8388608            │         │
    │  │ }                            │         │
    │  │ [8 MB raw file bytes]        │────────►│  Write to file at offset
    │  └──────────────────────────────┘         │
    │                                           │
    │  Lane complete signal:                    │
    │  { type: "LANE_COMPLETE", laneId: 1 }    │
    │──────────────────────────────────────────►│  Flush state to disk
    │                                           │
```

**Key features**:
- **Adaptive chunk sizing**: 512 KB (small files) → 32 MB (files > 2 GB)
- **Parallel lanes**: 2–8 TCP connections depending on file size
- **Resume support**: Completed chunk bitmap persisted every 25 chunks
- **Backpressure**: High/low watermark (64MB/16MB) prevents memory overflow
- **Zero-copy receive**: BufferList avoids O(n²) buffer allocation

### Phase 6: Verification & ACK

After all chunks are sent, the sender asks the receiver to verify integrity:

```
 Device A (Sender)                           Device B (Receiver)
    │                                           │
    │──── POST /api/transfers/complete ────────►│
    │     { transferId, fileId }                │
    │                                           │
    │                    ┌──────────────────────┤
    │                    │ 1. Check all chunks  │
    │                    │    received          │
    │                    │ 2. Compute SHA-256   │
    │                    │    of received file  │
    │                    │ 3. Compare with      │
    │                    │    sender's hash     │
    │                    │ 4. If match: rename  │
    │                    │    .part → final     │
    │                    │ 5. Cleanup state     │
    │                    └──────────────────────┤
    │                                           │
    │◄──── 200 OK ─────────────────────────────│
    │     {                                     │
    │       ok: true,                           │
    │       savedPath: "Received/movie.mp4",    │
    │       size: 524288000,                    │
    │       hashVerified: true                  │
    │     }                                     │
    │                                           │
    │  If chunks missing:                       │
    │◄──── 409 ────────────────────────────────│
    │     { pendingChunks: [42, 43] }          │
    │  → Sender retries only missing chunks     │
    │                                           │
    │  If hash mismatch:                        │
    │◄──── 422 ────────────────────────────────│
    │     { code: "HASH_MISMATCH" }            │
    │  → Transfer marked as failed              │
```

**Retry logic**: Up to 3 attempts. Only missing chunks are re-sent on retry, not the entire file.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       LUBDUB Node.js Server                  │
│                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌───────────────┐ │
│  │  HTTP Server    │  │  TCP Transfer   │  │  UDP Discovery │ │
│  │  Port 48621     │  │  Port 48631     │  │  Port 48622    │ │
│  │                 │  │                 │  │  Port 48623    │ │
│  │  • UI serving   │  │  • Chunk send   │  │                │ │
│  │  • Control API  │  │  • Chunk recv   │  │  • Nearby      │ │
│  │  • Pair/approve │  │  • Multi-lane   │  │    beacons     │ │
│  │  • Manifest     │  │  • Backpressure │  │  • WiFi Direct │ │
│  │  • Progress     │  │  • Resume       │  │    host find   │ │
│  └────────────────┘  └────────────────┘  └───────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Wi-Fi Direct Manager (PowerShell + WinRT)             │ │
│  │  • Start/stop WiFiDirectAdvertisementPublisher         │ │
│  │  • Join via netsh wlan profile + connect               │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Source Files

```
src/
├── server.js                 # Main HTTP server, control plane, transfer orchestration
├── chunkedTcpTransfer.js     # Raw TCP data plane with BufferList + backpressure
├── fileHash.js               # SHA-256 file integrity verification
├── nearbyDiscovery.js        # UDP broadcast for pre-pairing device discovery
├── wifiDirectDiscovery.js    # UDP discovery for finding host after WiFi Direct join
├── networkDiscovery.js       # ARP + HTTP probe fallback discovery
└── wifiDirectManager.js      # PowerShell/WinRT WiFi Direct session management

scripts/
├── start-wifi-direct-host.ps1  # Creates WiFi Direct hotspot via WinRT API
└── join-wifi-direct.ps1        # Joins WiFi Direct network via netsh wlan

public/
├── index.html                # Single-page UI
├── app.js                    # Frontend logic, polling, file selection
└── styles.css                # Dark/light theme UI styles

runtime/
├── device-id.txt             # Persistent device UUID
├── lubdub-debug.log          # Diagnostic log
└── transfers/                # In-progress transfer state for resume
    ├── incoming/             # Receiver-side partial files + state
    └── outgoing/             # Sender-side cached uploads
```

---

## Getting Started

### Requirements

- **Windows 10/11** with Wi-Fi Direct capable adapter
- **Node.js** 18 or later
- **Admin privileges** (required for Wi-Fi Direct and netsh)

### Install & Run

```bash
# Clone or download the project
cd LUBDUB

# Install dependencies
npm install

# Start LUBDUB
npm start
```

Open `http://localhost:48621` in your browser on **both PCs**.

### Quick Transfer

1. **Both PCs**: Open LUBDUB — they'll appear in each other's "Nearby Devices"
2. **Sender**: Click "Connect" on the target device
3. **Receiver**: Click "Approve" on the incoming request
4. **Sender**: Drop a file and click "Send"
5. **Receiver**: File appears in the `Received/` folder with integrity verification

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_PORT` | `48621` | HTTP server port |
| `DEVICE_NAME` | OS hostname | Display name for this device |
| `TRANSFER_CHUNK_SIZE` | `2097152` (2 MB) | Default chunk size in bytes |
| `TRANSFER_LANES` | `6` | Default number of parallel TCP lanes |
| `TRANSFER_PORT_OFFSET` | `10` | TCP transfer port = APP_PORT + offset |
| `DISCOVERY_PORT` | `48622` | Nearby discovery UDP port |
| `WIFI_DIRECT_DISCOVERY_PORT` | `48623` | WiFi Direct discovery UDP port |

---

## Platform Support

| Component | Windows | macOS | Linux |
|-----------|---------|-------|-------|
| Core transfer engine (TCP) | ✅ | ✅ | ✅ |
| Web UI | ✅ | ✅ | ✅ |
| UDP device discovery | ✅ | ✅ | ✅ |
| SHA-256 integrity | ✅ | ✅ | ✅ |
| Wi-Fi Direct hosting | ✅ | ❌ | ❌ |
| Wi-Fi Direct joining | ✅ | ❌ | ❌ |

> macOS and Linux would need platform-specific replacements for the Wi-Fi Direct layer (PowerShell scripts + WinRT APIs).

---

## Performance Optimizations

LUBDUB uses several techniques to maximize transfer speed on Wi-Fi Direct:

- **BufferList receiver** — O(1) buffer append replaces O(n²) `Buffer.concat` on every TCP packet
- **Watermark backpressure** — Socket only pauses when 64 MB buffered, resumes at 16 MB (no pause-per-chunk stalls)
- **Adaptive chunk sizing** — 512 KB for small files up to 32 MB for files > 2 GB (fewer syscalls)
- **Parallel TCP lanes** — 2–8 simultaneous connections saturate Wi-Fi bandwidth
- **cork/uncork writes** — Header + body sent as single TCP segment
- **Positional file writes** — Chunks written to exact byte offset (no sequential dependency)
- **Periodic state saves** — Every 25 chunks for crash-resilient resume

---

## License

Private — not yet published.
