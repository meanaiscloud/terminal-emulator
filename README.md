# Terminal Emulator

An aesthetic black-and-orange SSH workstation featuring an xterm.js powered terminal, multi-distro telemetry dashboard, and SFTP-style file manager.

## Features
- Web terminal powered by a minimal WebSocket bridge into a real `ssh` session.
- Works with common Linux distros (Ubuntu, Debian, CentOS, Arch, etc.) using the system `ssh` client for secure transport.
- Dashboard cards for CPU load, RAM, and storage usage gathered directly from the remote host.
- File manager helpers to list directories plus upload/download files over the SSH channel.
- Password or identity file authentication, with Windows 10+ download CTA baked into the UI.
- Persistent connection profiles stored locally with one-click load/save.
- Auto-reconnect and periodic keep-alive pings to stabilize shaky sessions.
- Host facts card (distro, kernel, uptime, active user count, IP) and latency meter.
- Automatic and manual metric refresh with interval toggles.
- Terminal recording with downloadable session logs.
- Quick command palette plus arbitrary command runner with output capture.
- Process and port inspectors for rapid health snapshots.
- Remote directory depth scans and pretty audit log of all actions.
- File previewer, log tailer, and depth-limited tree explorer.
- SFTP upload/download maintained with progress messaging.
- Clipboard-friendly terminal theme with curated black/orange palette.
- Session timer for runtime awareness.
- Dashboard and automation widgets tuned for Ubuntu, Debian, CentOS, Arch, and more.
- Windows 10+ download CTA placeholder for future builds.
- Lightweight API endpoints for ping, info, processes, ports, run, tail, and tree operations.

## Running locally
1. Ensure you have Node.js 18+ with access to the `ssh` binary on your PATH.
2. Start the server:
   ```bash
   node server.js
   ```
3. Open `http://localhost:3000` in your browser.

## Workflow
1. Create a session with host, port, username, and optional password/key path.
2. The terminal panel will connect automatically via WebSocket; type as normal to interact with the remote shell.
3. Use **Refresh metrics** for live CPU/RAM/disk stats.
4. Use the file manager to list directories, upload local files, or download remote paths.

> Note: The server uses your local `ssh` command. Host verification is disabled for smoother demos; review and harden before production use.
