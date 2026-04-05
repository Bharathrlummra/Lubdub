# LUBDUB Share

Windows-to-Windows offline file sharing prototype built around `Wi-Fi Direct legacy mode` instead of an existing LAN or router.

## Why this path

The adapter on this machine reports:

- `Hosted network supported: No`

That blocks the old `netsh hostednetwork` approach. The current Windows-native path that still behaves like ShareIt is `Wi-Fi Direct`, where one PC becomes a temporary group owner and exposes an SSID plus passphrase that a nearby PC joins.

## What this prototype does

- Starts a ShareIt-style local session using `WiFiDirectAdvertisementPublisher`
- Discovers nearby devices on the same local network and sends ShareIt-style connect requests
- Exposes an invite code with the generated SSID and passphrase
- Lets another Windows PC join the temporary network
- Registers the peer with the host service
- Streams files directly from one PC to the other
- Saves incoming files into `Received`

## Current flow

1. On both PCs, run `npm start`.
2. Open `http://localhost:48621` on both devices.
3. Preferred flow: on the sender PC, pick the other machine in `Nearby Devices` and send a connection request.
4. On the receiver PC, click `Approve & Connect`. The app will join the Wi-Fi Direct session automatically.
5. Fallback flow: if nearby discovery does not find the other PC, use `Start Session`, copy the invite code, and paste it into `Join Session` on the second PC.
6. After the second PC registers, send a file from the host or back to the host.

## Run

```powershell
npm start
```

## Project structure

- `src/server.js`: local UI server, session state, registration, and file transfer routes
- `src/wifiDirectManager.js`: starts and stops the Wi-Fi Direct host PowerShell process
- `src/networkDiscovery.js`: locates the host service after a client joins the temporary peer network
- `scripts/start-wifi-direct-host.ps1`: creates the Wi-Fi Direct group-owner session
- `scripts/join-wifi-direct.ps1`: connects a receiver to the generated SSID using the invite data

## Known limitations

- This is an MVP. The UI is local web UI, not a packaged desktop app yet.
- Peer discovery after join uses subnet probing on the temporary Wi-Fi Direct network.
- Windows firewall may need to allow inbound access for `node.exe` on the chosen port.
- Wi-Fi Direct behavior varies by adapter and Windows build, so final hardening should be done on two physical PCs.
- The join flow still relies on Windows WLAN profile commands under the hood; moving to a packaged desktop app with richer WinRT integration is the right next step.

## Next build steps

1. Replace the invite-code paste flow with QR code pairing.
2. Upgrade the web UI into an Electron or WinUI shell.
3. Add transfer resume, progress, cancellation, and chunk hashing.
4. Add receiver-side approval before saving files.
