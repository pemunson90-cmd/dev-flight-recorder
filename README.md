# Development Flight Recorder

A passive, read-only recorder for a Windows development PC. It watches your Git repositories, worktrees, plain folders and AI coding agent histories (Claude Code, Codex), keeps encrypted copies of text-file edits (so an edit you later undo is still on record), and shows it all on a phone-friendly dashboard you can reach privately from anywhere through Tailscale.

It never writes to your projects, never runs `git fetch/pull/reset/checkout/clean`, installs no agent hooks, and uses no AI model or cloud service.

## What it records

- **Git:** status, branch and HEAD changes, commits, linked worktrees (read-only Git commands with optional locks off).
- **Files:** created / edited / deleted / renamed files in the folders you list, with native change notices plus a periodic full re-check.
- **Edit history:** for allowed text files, compressed and AES-256-GCM encrypted copies (key protected by Windows DPAPI). Limits: 1 MiB per file, 2 GiB total, 60 days. Old copies are moved to a `_scrap-YYYYMMDD` folder, never deleted.
- **Secrets:** `.env`, keys, credential files and similar are recorded as "changed" only; their contents are never read. Secret-looking text is redacted from diffs.
- **Agents:** what Claude Code and Codex sessions *reported* (tool calls, edited files, token counts), read from their existing history files. Timing overlap with real file changes is shown as "possibly associated", never as proof of who changed what.
- **Honest gaps:** any time the recorder was not running, or the watcher lost events, is shown as a gap, not as "no activity".

## Requirements

- Windows 10/11
- Node.js 24 or newer (uses the built-in `node:sqlite`; no npm packages)
- Git for Windows
- Optional: Tailscale, for private phone access

## Install

1. Copy `config.example.json` to `config.json` and edit it:
   - `user_profile`, `data_dir`: your Windows user folder and where the recorder keeps its data (must be outside the watched folders).
   - `watch_roots`: the folders to watch. `"repository"` = one repo; `"discovery"` = a folder searched for repos up to `scan_depth` levels.
   - `remote_report.allowed_hosts`: your PC's Tailscale name (see below).
2. From an elevated PowerShell: `powershell -ExecutionPolicy Bypass -File install.ps1`
   This registers one scheduled task that starts at boot, runs whether or not you are signed in (no stored password), and restarts on failure.
3. Open `http://127.0.0.1:8775/` on the PC (admin view; adjust if you changed `local_admin.port`).

## Phone access (private, via Tailscale)

1. Install Tailscale on the PC and phone, signed in to the same account. In the admin console, turn on MagicDNS and HTTPS certificates.
2. On the PC: `tailscale serve --bg http://127.0.0.1:8766`
3. Open the `https://<pc-name>.<tailnet>.ts.net/` address it prints on the phone and add it to the home screen.

Only the read-only report port (8766) is shared, and only inside your tailnet. Never use Tailscale Funnel for this.

If the phone loses internet when Tailscale is on, set Android **Private DNS** to *Automatic*. To keep an ad-blocking DNS, add it as a nameserver in the Tailscale admin console instead.

## Control

```
powershell -File dfr.ps1 status      # running? healthy? phone link
powershell -File dfr.ps1 stop
powershell -File dfr.ps1 start
powershell -File dfr.ps1 uninstall   # removes the task and phone link; MOVES program and data to Documents\_to_delete
```

## Layout

- `app/recorder.js`: the recorder; `app/supervisor.js` keeps it running
- `app/lib/`: Git, file, agent-history, process, storage, report and web-server modules
- `app/public/`: the dashboard (no external scripts)
- `install.ps1`, `dfr.ps1`: install and control

## Known limits

- A powered-off, asleep or offline PC cannot serve the dashboard.
- Grok and Copilot histories are detected but not read.
- Short-lived processes between 30-second samples can be missed.
