# LUBDUB Share

LUBDUB Share is a Windows-to-Windows offline file sharing prototype. It is designed to work like a lightweight SHAREit-style flow:

- discover another nearby PC
- send a connection request
- approve the request on the receiver
- connect over a temporary Wi-Fi Direct session
- send files directly

This project is currently a local web app that runs on each PC.

## User Guide

### What LUBDUB does

- Sends a connection request from one PC to another
- Lets the receiver approve the request with `Approve & Connect`
- Creates a temporary Wi-Fi Direct session between the two PCs
- Transfers files directly without internet using a dedicated raw TCP data socket
- Saves incoming files in the `Received` folder
- Shows debug and diagnostic details when a connection fails

### Requirements

- Windows on both PCs
- Node.js installed on both PCs
- Both PCs should be near each other
- For the `Nearby Devices` flow, both PCs should first be on the same existing Wi-Fi or LAN
- Windows Firewall should allow `node.exe` if connection or discovery fails

### Start the app

Run this on both PCs:

```powershell
npm start
```

Then open:

```text
http://localhost:48621
```

If the browser does not open automatically, paste the address manually.

## Main Sharing Flow

This is the preferred flow.

### On the sender PC

1. Open LUBDUB.
2. Wait for the other PC to appear in `Nearby Devices`.
3. Click `Send Connect Request` on the target device.

### On the receiver PC

1. Open LUBDUB.
2. Wait for the request to appear in `Connection Requests`.
3. Click `Approve & Connect`.
4. Wait while LUBDUB joins the Wi-Fi Direct session automatically.

### After connection

1. Go to `Send File`.
2. Choose the target device.
3. Pick a file.
4. Click `Send`.

Incoming files are saved in:

```text
Received
```

## Fallback Manual Join Flow

Use this if `Nearby Devices` does not show the other PC.

### On the sender PC

1. Click `Start Session`.
2. Copy the `Invite Code`.

### On the receiver PC

1. Paste the code into `Join Session`.
2. Click `Join Session`.

After the receiver joins, both sides can send files.

## What You See in the UI

### This Device

Shows:

- device name
- device ID
- current role: `idle`, `host`, or `client`

### Host Session

Shows:

- Wi-Fi Direct SSID
- passphrase
- invite code
- host start status

### Join Session

Lets a receiver join using the invite code manually.

### Nearby Devices

Shows devices discovered on the same local network before Wi-Fi Direct connection starts.

### Connection Requests

Shows incoming requests that can be:

- approved
- declined

### Send File

Lets you choose a connected target and send a file.

### Connected Peers

Shows connected devices after pairing succeeds.

### Received Files

Shows recently received files and where they were saved.

### Diagnostics

Shows the latest debug events for this device.

This is useful when:

- the request appears but connection fails
- the request does not appear
- Wi-Fi Direct joins but host registration fails

## Debugging and Logs

LUBDUB now writes debug output in three places:

### 1. Terminal

When you run `npm start`, you will see lines like:

```text
[LUBDUB DEBUG] 2026-04-07T00:00:00.000Z pair.request.approved {...}
```

### 2. In-app Diagnostics panel

The app shows the latest connection events directly in the UI.

### 3. Log file

Logs are also saved here:

```text
runtime/lubdub-debug.log
```

## Important Debug Events

These log names help identify the failure point:

- `pair.request.send`: sender started sending a request
- `pair.request.received`: receiver got the request
- `pair.request.approved`: receiver approved the request
- `pair.connect.start`: receiver started the connection flow
- `host.starting`: sender started creating the Wi-Fi Direct host
- `host.started`: sender host session became active
- `join.start`: receiver began joining the Wi-Fi Direct session
- `join.network.connected`: receiver joined the Wi-Fi Direct network
- `join.network.error`: Windows failed while joining the Wi-Fi Direct network
- `discover.scan`: receiver scanned for the sender host service
- `discover.match`: receiver found the sender host IP
- `discover.timeout`: receiver could not find the sender host service in time
- `wifi-discovery.discover.send`: receiver broadcast a UDP host discovery request
- `wifi-discovery.request`: sender received the UDP discovery request
- `wifi-discovery.reply`: sender replied with host readiness
- `wifi-discovery.match`: receiver matched a UDP host-ready reply
- `wifi-discovery.timeout`: receiver did not receive a UDP host reply in time
- `register.start`: receiver tried to register with the sender
- `register.success`: receiver successfully registered with the sender
- `register.error`: registration reached the sender but failed
- `pair.connect.error`: connect flow failed after approval
- `transfer.tcp.listen`: raw TCP transfer server is listening
- `transfer.tcp.send.start`: sender started the raw TCP transfer
- `transfer.tcp.send.ack`: receiver acknowledged the raw TCP transfer
- `transfer.tcp.receive.start`: receiver started writing an incoming raw TCP transfer
- `transfer.tcp.receive.complete`: receiver finished saving the transfer

## Troubleshooting

### The other PC does not appear in Nearby Devices

Check the following:

- both PCs are running LUBDUB
- both PCs are on the same Wi-Fi or LAN before pairing
- both PCs opened `http://localhost:48621`
- firewall is not blocking `node.exe`

If it still does not appear, use the fallback invite-code method.

### I can send a request, but approval does not connect

Check `Diagnostics` or `runtime/lubdub-debug.log`.

Most common causes:

- `join.network.error`
  Windows did not connect to the Wi-Fi Direct SSID.

- `discover.timeout`
  The receiver joined Wi-Fi Direct, but could not reach the sender host service.

- `register.error`
  The receiver found the sender, but registration was rejected or blocked.

### Files do not transfer

Check:

- the devices are listed in `Connected Peers`
- the receiver actually completed registration
- Windows Firewall allows `node.exe`

### Where are received files saved

They are saved in:

```text
Received
```

## Project Structure

- `src/server.js`: app server, session handling, request approval, transfer routes, diagnostics
- `src/rawTcpTransfer.js`: raw TCP single-lane transfer engine used for peer-to-peer file transfer
- `src/wifiDirectManager.js`: Wi-Fi Direct start and stop logic
- `src/wifiDirectDiscovery.js`: UDP host discovery after the receiver joins Wi-Fi Direct
- `src/networkDiscovery.js`: fallback HTTP scan-based host discovery
- `src/nearbyDiscovery.js`: local-network discovery before Wi-Fi Direct connection starts
- `scripts/start-wifi-direct-host.ps1`: starts the Wi-Fi Direct host session
- `scripts/join-wifi-direct.ps1`: joins a Wi-Fi Direct session from invite data
- `public/index.html`: UI layout
- `public/app.js`: UI behavior
- `public/styles.css`: UI styling

## Current Limitations

- This is still an MVP
- It is a local web UI, not a packaged desktop app yet
- Wi-Fi Direct behavior can vary by adapter and Windows version
- The nearby-device flow depends on the PCs first seeing each other on the same local network
- Final hardening should be tested on two physical Windows PCs

## Suggested Test Flow

1. Start `npm start` on both PCs.
2. Open `http://localhost:48621` on both PCs.
3. Use `Nearby Devices` and send a request.
4. Approve on the receiver.
5. If connection fails, open `Diagnostics`.
6. Check terminal logs for the last debug events.
7. If needed, open `runtime/lubdub-debug.log`.

## Status

This project is working as a prototype and now includes detailed debug logging to help trace connection failures step by step.
