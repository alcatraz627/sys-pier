# Design: Daemon, Cron & LaunchD Extension for pm2-manage

> Status: Design document — not yet implemented  
> Created: 2026-04-08 (session: pm2-conf-a3)  
> Scope: Extend pm2-manage dashboard to show and manage non-pm2 background processes

---

## Overview

pm2-manage currently shows only pm2-managed processes. This document designs
an extension to unify four classes of background work into one dashboard:

```
┌───────────────────────────────────────────────────────────────────────┐
│                       pm2-manage dashboard                            │
├─────────────────┬─────────────────┬──────────────┬────────────────────┤
│   pm2 processes │  custom daemons │  cron jobs   │  launchd agents    │
│  (existing)     │  (new registry) │  (crontab)   │  (plist-based)     │
├─────────────────┴─────────────────┴──────────────┴────────────────────┤
│         shared: groups · color · title · icon · drag-order            │
│         shared: sparklines · log tail · send command · detail modal   │
└───────────────────────────────────────────────────────────────────────┘
```

All four types participate in the existing group/color/title/order system.
New types get a type badge and type-appropriate actions.

---

## Entry Types

### 1. pm2 — existing
No changes to data model. Gets the type badge added.

### 2. Custom Daemon (new)
A registry of arbitrary long-running processes managed entirely by pm2-manage
(not pm2). pm2-manage spawns them, tracks PIDs, writes logs, and can restart
on crash.

**Use cases:** Python background scripts, custom watchers, Claude Code agents
(headless), data pipelines that don't fit the pm2 model.

### 3. Cron Job (new)
Reads the user crontab (`crontab -l`). Parsed, displayed with next/last run
times and schedule in human-readable form. Can enable/disable and run-now.
Custom metadata (title, color, group, icon) stored in pm2-manage config.

**Use cases:** Nightly backups, weekly todo archiving, log rotation, data sync.

### 4. LaunchD Agent (new, read-mostly)
Reads `~/Library/LaunchAgents/*.plist` plus a user-specified pinned list.
Shows load/run status, schedule, stdout/stderr paths. Can load/unload and
kickstart. Plist files are not modified.

**Use cases:** Monitoring system-level services (dnsmasq, nginx, custom agents),
quick start/stop without `launchctl` in terminal.

---

## Data Models

### Shared fields (all types)

```js
{
  // Identity
  id:           string,    // type-prefixed: "pm2:0", "cron:abc123", "daemon:my-script", "launchd:com.user.foo"
  type:         'pm2' | 'daemon' | 'cron' | 'launchd',
  name:         string,    // canonical name (pm2 process name, daemon key, cron hash, launchd label)

  // Status
  status:       'online' | 'stopped' | 'errored' | 'unknown' | 'scheduled',
  pid:          number | null,

  // UI config (stored in pm2-manage-config.json, applies to all types)
  _color:       string,    // hex color
  _title:       string,    // display name override
  _group:       string,    // group UUID
  _order:       number,
  _icon:        string,    // emoji shown in card header (e.g. "🕐" for cron, "🐍" for Python)
}
```

### pm2 — no changes to existing fields

### Custom Daemon

```js
{
  // Registry (stored in pm2-manage-config.json under "daemons")
  command:      string,    // "python3 /path/to/script.py --flag"
  workdir:      string,    // working directory (absolute)
  logFile:      string,    // stdout log path (absolute)
  errFile:      string,    // stderr log path (absolute)
  pidFile:      string,    // where pm2-manage writes the PID
  env:          Record<string, string>,
  autoRestart:  boolean,   // restart on crash (managed by pm2-manage)
  maxRestarts:  number,    // default 5; set to 0 for no-restart
  restartDelay: number,    // ms between restart attempts

  // Runtime (computed each refresh)
  uptime_ms:    number,
  cpu_percent:  number,    // read from `ps -p PID -o %cpu`
  memory_bytes: number,    // read from `ps -p PID -o rss` × 1024
  restarts:     number,    // tracked in runtime state
  last_exit:    number | null,  // exit code of last crash
}
```

### Cron Job

```js
{
  expression:   string,    // "0 3 * * *"
  command:      string,    // "bash ~/.claude/scripts/weekly-todo.sh archive"
  enabled:      boolean,   // false if line is commented out
  next_run_ms:  number,    // timestamp of next scheduled run
  last_run_ms:  number | null,  // from execution log (if tracked)
  human_schedule: string,  // "Every day at 3:00 AM"
  source:       'user' | string,  // 'user' = crontab -l, else file path
  line_number:  number,    // in source file
  hash:         string,    // stable ID: sha1 of (source + command), for config overlay
}
```

### LaunchD Agent

```js
{
  label:        string,    // com.user.myservice
  plist_path:   string,    // ~/Library/LaunchAgents/com.user.myservice.plist
  is_loaded:    boolean,   // in launchctl list
  is_running:   boolean,   // pid > 0 in launchctl list
  last_exit:    number,    // last exit code from launchctl list
  program_args: string[],  // ProgramArguments from plist
  start_interval: number | null,  // StartInterval seconds
  schedule:     object | null,    // StartCalendarInterval parsed
  human_schedule: string,         // "Every 5 minutes" or "Daily at 2:00 AM"
  stdout_path:  string | null,    // StandardOutPath
  stderr_path:  string | null,    // StandardErrorPath
  run_at_load:  boolean,
  keep_alive:   boolean,
}
```

---

## Config Schema: v3

```jsonc
{
  "version": 3,

  // Existing — unchanged
  "entries":    { "<pm2-name>": { color, title, group, order, icon } },
  "groups":     { "<uuid>": { name, emoji, notes, order, collapsed } },
  "merges":     { "<key>": ["name-frontend", "name-backend"] },
  "staticUrls": { "<slug>": { url, title, group, color, icon } },
  "globalOrder": ["pm2:name", "daemon:key", "cron:hash", "launchd:label", "static:slug"],

  // NEW: custom daemon registry
  "daemons": {
    "my-script": {
      "command":      "python3 /Users/alcatraz627/Code/scripts/sync.py",
      "workdir":      "/Users/alcatraz627/Code/scripts",
      "logFile":      "/Users/alcatraz627/.claude/assets/logs/my-script-out.log",
      "errFile":      "/Users/alcatraz627/.claude/assets/logs/my-script-err.log",
      "pidFile":      "/tmp/pm2-manage-my-script.pid",
      "env":          { "PYTHONUNBUFFERED": "1" },
      "autoRestart":  true,
      "maxRestarts":  5,
      "restartDelay": 3000
    }
  },

  // NEW: UI overrides for cron and launchd (keyed by hash or label)
  "cronOverrides": {
    "<hash>": { "color": "#58a6ff", "title": "Nightly backup", "group": "<uuid>", "icon": "🕐" }
  },
  "launchdPinned": [
    "com.user.dnsmasq",
    "homebrew.mxcl.nginx"
  ],
  "launchdOverrides": {
    "com.user.dnsmasq": { "title": "dnsmasq", "icon": "🌐", "group": "<uuid>", "color": "#79c0ff" }
  }
}
```

**Migration**: v2 → v3 is additive only. Existing entries/groups/merges/staticUrls
are preserved unchanged. `version` bumps to 3, new keys default to `{}` / `[]`.

---

## API Extensions

All new endpoints follow the existing pattern: localhost-only, JSON bodies,
`{ ok: boolean, error?: string }` responses.

### Custom Daemon Endpoints

```
GET  /api/daemons
     → { daemons: DaemonEntry[] }
     Lists all registered daemons with runtime stats.

POST /api/daemons
     Body: { key, command, workdir, logFile?, errFile?, env?, autoRestart?, maxRestarts? }
     → { ok, key }
     Registers a new daemon (does NOT start it).

PATCH /api/daemons/:key
     Body: { command?, workdir?, env?, autoRestart?, maxRestarts?, restartDelay? }
     → { ok }
     Update daemon config. Requires stop + restart to take effect.

DELETE /api/daemons/:key
     → { ok }
     Removes daemon from registry. Stops process if running.

POST /api/daemons/:key/action
     Body: { cmd: 'start' | 'stop' | 'restart' | 'flush-logs' }
     → { ok, pid? }
     Lifecycle control. 'flush-logs' truncates log files.

POST /api/daemons/:key/signal
     Body: { signal: 'SIGUSR1' | 'SIGUSR2' | 'SIGHUP' | 'SIGTERM' }
     → { ok }
     Send UNIX signal to daemon PID.

GET  /api/daemons/:key/logs?lines=80
     → text/plain
     Last N lines of stdout log.

GET  /api/daemons/:key/stream
     → text/event-stream { line: string }
     Live tail of stdout log via SSE (same pattern as /api/logs/:name/stream).

GET  /api/daemons/:key/errlog?lines=80
     → text/plain
     Last N lines of stderr log.
```

### Cron Endpoints

```
GET  /api/cron
     → { entries: CronEntry[] }
     Parses user crontab. Returns all entries with next_run, human_schedule.

POST /api/cron/:hash/enable
     Body: { enabled: boolean }
     → { ok }
     Comment or uncomment the cron line in the user crontab.

POST /api/cron/:hash/run
     Body: {}
     → { ok, output: string, exit_code: number }
     Execute the cron command immediately (shell -c), capture output.

PATCH /api/cron/:hash/config
     Body: { title?, color?, group?, icon? }
     → { ok }
     Stores overlay metadata in config (does NOT modify crontab).
```

### LaunchD Endpoints

```
GET  /api/launchd
     → { agents: LaunchdEntry[] }
     Returns pinned + all ~/Library/LaunchAgents/ entries, merged with
     launchctl list status.

POST /api/launchd/:label/action
     Body: { cmd: 'load' | 'unload' | 'start' | 'stop' | 'kickstart' }
     → { ok }
     Maps to launchctl equivalents:
       load      → launchctl load ~/Library/LaunchAgents/<plist>
       unload    → launchctl unload ~/Library/LaunchAgents/<plist>
       start     → launchctl start <label>
       stop      → launchctl stop <label>
       kickstart → launchctl kickstart -k gui/$(id -u)/<label>

GET  /api/launchd/:label/logs?lines=80&stream=stdout|stderr
     → text/plain
     Reads StandardOutPath or StandardErrorPath from plist, returns last N lines.
     Returns 404 with explanation if plist has no log paths configured.

PATCH /api/launchd/:label/config
     Body: { title?, color?, group?, icon? }
     → { ok }
     Stores overlay. Does NOT modify plist.

POST /api/launchd/pin
     Body: { label: string }
     → { ok }
     Adds label to launchdPinned (show even if not in ~/Library/LaunchAgents/).

DELETE /api/launchd/pin/:label
     → { ok }
     Removes from pinned list.
```

### Extended Unified Endpoints

```
GET  /api/all
     → { pm2: Process[], daemons: DaemonEntry[], cron: CronEntry[], launchd: LaunchdEntry[] }
     Full state of all entry types. Used for initial page load and type-filter views.

GET  /api/stats/all
     → { pm2: AggStats, daemons: AggStats, total: AggStats }
     Aggregate CPU/memory across pm2 + daemons (cron/launchd not included as they
     only run transiently or are tracked by PID).

GET  /api/metrics/history
     (existing endpoint extended)
     Now includes daemon entries in the history map alongside pm2 processes.
```

---

## Feature Matrix

| Feature               | pm2 | daemon | cron | launchd |
|-----------------------|-----|--------|------|---------|
| Status badge          | ✓   | ✓      | next-run | ✓    |
| Type badge            | ✓   | ✓      | ✓    | ✓       |
| Custom icon (emoji)   | ✓   | ✓      | ✓    | ✓       |
| Custom title          | ✓   | ✓      | ✓    | ✓       |
| Custom color          | ✓   | ✓      | ✓    | ✓       |
| Group assignment      | ✓   | ✓      | ✓    | ✓       |
| Drag-drop reorder     | ✓   | ✓      | ✓    | ✓       |
| CPU/memory stats      | ✓   | ✓ (ps) | ✗    | ✓ (ps)  |
| Sparklines            | ✓   | ✓      | ✗    | partial |
| Start / Stop          | ✓   | ✓      | enable | load/unload |
| Restart               | ✓   | ✓      | run-now | kickstart |
| Delete / Remove       | ✓   | ✓      | ✗ (edit crontab) | unpin |
| Log tail (static)     | ✓   | ✓      | output of run-now | ✓ (if path set) |
| Log tail (SSE live)   | ✓   | ✓      | ✗    | ✗       |
| Send signal           | ✓   | ✓      | ✗    | ✓ (stop) |
| Send command (stdin)  | ✗   | future | ✗    | ✗       |
| Detail modal          | ✓   | ✓      | ✓    | ✓       |
| Env vars view         | ✓   | ✓      | ✗    | ✗       |
| Open CWD in Finder    | ✓   | ✓      | ✗    | ✗       |
| Schedule display      | if cron_restart | ✗ | ✓ | ✓ |
| Next run countdown    | ✗   | ✗      | ✓    | ✓       |
| Last run time         | ✗   | via log | ✓ (tracked) | via exit code |
| Auto-restart on crash | ✓   | ✓      | ✗    | ✓ (KeepAlive) |
| Create from UI        | ✗   | ✓      | future | ✗     |
| Edit config from UI   | ✗   | ✓      | expression editor | ✗ |
| Merge pairs           | ✓   | ✓      | ✗    | ✗       |

---

## Frontend Changes

### Type Badge
Every card and table row gets a small pill in the top-right corner:
```
[pm2]     — gray
[daemon]  — blue
[cron]    — orange
[launchd] — purple
```
Clicking the badge opens a filter to show only that type.

### Icon Field
All entry types get an `_icon` emoji field, shown:
- Large in the card header (alongside color dot)
- Small in the table row name column

Default icons by type/name inference:
- `*python*` or `*.py` → 🐍
- `*node*` or `*npm*` → 🟢
- `*nginx*` or `*proxy*` → 🌐
- `*backup*` or `*sync*` → 💾
- `*cron*` wildcard → 🕐
- launchd → ⚙️
- daemon default → 🔧

### Schedule Display
For cron and scheduled launchd entries, the card body shows:
```
🕐 Daily at 3:00 AM
   Next: in 14h 32m
```

For cron entries with `status: scheduled`, the status badge shows
"scheduled" in amber instead of "stopped".

### Type Filters
Header filter bar extended:
```
[ All ] [ pm2 ] [ Daemon ] [ Cron ] [ LaunchD ] [ URLs ]
```

### New Modals

**Daemon Create/Edit modal:**
```
Name:       [________________]
Command:    [python3 /path/to/script.py --flag]
Workdir:    [/path/to/workdir              ] [Pick]
Log file:   [~/.claude/assets/logs/...    ] [auto]
Auto-restart: [x]   Max restarts: [5]
Env vars:   [KEY=VALUE  +add]
```

**Cron detail modal** (read-mostly):
```
Expression:    0 3 * * *
Human:         Every day at 3:00 AM
Command:       bash ~/.claude/scripts/weekly-todo.sh archive
Next run:      Tomorrow at 3:00 AM (in 14h 32m)
Source:        user crontab, line 12

[Enable]  [Disable]  [Run Now]
Output of last run-now: [.......................]
```

**LaunchD detail modal:**
```
Label:        com.user.dnsmasq
Plist:        ~/Library/LaunchAgents/com.user.dnsmasq.plist
Status:       loaded, running (PID 1234)
Schedule:     KeepAlive
Stdout:       /usr/local/var/log/dnsmasq.log

Program:      /opt/homebrew/sbin/dnsmasq --keep-in-foreground

[Load]  [Unload]  [Kickstart]  [View Logs]
```

### Log Tail Modal Extensions
Existing log modal gets a type-aware header:
- pm2: shows `pm2 logs <name>` source
- daemon: shows log file path + "stderr" tab
- cron: shows run-now output (no live tail)
- launchd: shows StandardOutPath content (no live tail unless future SSE)

---

## Backend Implementation Notes

### Daemon Process Manager (new module within server.cjs)

```
DaemonManager:
  state:  Map<key, { pid, restarts, startedAt, status }>
  logs:   Map<key, { outStream, errStream }>  // writable streams

  start(key)   → spawn process, write PID, pipe stdout/err to log files
  stop(key)    → send SIGTERM, await exit (timeout → SIGKILL)
  restart(key) → stop then start
  watch(key)   → on 'exit', if autoRestart and restarts < maxRestarts: schedule restart
  stats(key)   → exec `ps -p PID -o %cpu,rss` → { cpu, mem }
```

Metrics sampling (every 5s, existing loop extended):
```js
for (const [key, state] of daemonManager.state) {
  if (state.pid) {
    const { cpu, mem } = await daemonManager.stats(key);
    recordMetrics(`daemon:${key}`, cpu, mem);
  }
}
```

### Cron Parser (pure JS, no deps)

Parse crontab:
```
# comment line               → skip
* * * * * command args       → CronEntry
@reboot command              → special entry
```

Next-run calculation: implement a minimal cron-next-tick in ~80 lines pure JS
(advance minute by minute from now until expression matches, cap at 1 year).

Last-run tracking: maintained in a separate `~/.pm2-manage-cron-runs.json`
file updated each time "Run Now" is triggered.

### LaunchD Reader

```js
// launchctl list → TSV: PID, LastExitStatus, Label
// Parse ~/Library/LaunchAgents/*.plist (XML property list via Node's built-in xml parser)
// or: exec `plutil -convert json -o - <plist>` → parse JSON output

function parsePlist(path) {
  const json = execSync(`plutil -convert json -o - "${path}"`);
  return JSON.parse(json);
}

function humanSchedule(plist) {
  if (plist.StartInterval)
    return `Every ${fmtSeconds(plist.StartInterval)}`;
  if (plist.StartCalendarInterval)
    return calendarIntervalToHuman(plist.StartCalendarInterval);
  if (plist.KeepAlive === true || plist.KeepAlive?.SuccessfulExit === false)
    return 'Always running (KeepAlive)';
  if (plist.RunAtLoad)
    return 'On login';
  return 'Manual';
}
```

---

## Implementation Phases

### Phase 1 — Custom Daemon Registry (2–3 days)
Highest value, no OS integration complexity.
1. Config v3 schema + migration from v2
2. `DaemonManager` class (spawn, PID tracking, log files, auto-restart)
3. Daemon API endpoints (CRUD + action + logs + stream)
4. Metrics sampling extension (ps-based CPU/mem for daemon PIDs)
5. Frontend: daemon cards, type badge, icon field, create/edit modal
6. Log tail extended to support daemon log files

### Phase 2 — Cron Job Integration (1–2 days)
7. Cron parser (crontab -l parsing, next-run calc)
8. Cron API endpoints (list, enable/disable, run-now)
9. Config overlay for cron (title, color, group, icon via hash key)
10. Frontend: cron cards with schedule display, next-run countdown, run-now modal
11. Cron-runs log file for last-run tracking

### Phase 3 — LaunchD Integration (1–2 days)
12. LaunchD reader (plutil plist parse, launchctl list merge)
13. LaunchD API endpoints (list, action, logs, pin/unpin)
14. Config overlay for launchd (same pattern as cron)
15. Frontend: launchd cards, schedule display, detail modal
16. Type filter bar

### Phase 4 — Polish (1 day)
17. Default icons by name inference
18. `/api/all` unified endpoint
19. Extended `/api/stats/all`
20. Config export/import handles v3
21. Keyboard shortcuts for type filter tabs

---

## Open Questions / Decisions

1. **Stdin/commands**: Should daemons accept stdin? Could implement a
   "send input" modal that writes to the process's stdin pipe. Deferred to Phase 4+.

2. **System-level daemons** (not user LaunchAgents): Requires sudo for
   `/Library/LaunchDaemons/`. Probably out of scope — localhost dashboard
   shouldn't prompt for sudo.

3. **Crontab write safety**: Enable/disable edits the user crontab via
   `crontab - <<< "modified"`. Risk: concurrent edits. Mitigation: read-then-
   write with file lock, warn user in UI.

4. **Daemon log rotation**: Long-running daemons will accumulate large log files.
   Options: size-based rotation (>10MB, keep 3 files), or integrate pm2-logrotate
   pattern. Could expose "flush logs" action.

5. **Claude Code scheduled triggers**: The `schedule` skill creates RemoteTrigger
   cron jobs. These are separate from user crontab. Could add a "Claude Triggers"
   section if the trigger API is accessible from the dashboard.

6. **Notification on crash**: pm2 already has this for its processes. Should
   extend to custom daemons via macOS `osascript -e 'display notification...'`
   on crash detection in DaemonManager's watch().

---

## Files to Create/Modify

```
pm2-manage/
├── server.cjs           MODIFY  (major: add DaemonManager, cron parser,
│                                  launchd reader, new API routes, UI templates)
├── pm2-manage-config.json  MODIFY (v3 schema on next startup)
└── DESIGN-DAEMON-EXTENSION.md  THIS FILE
```

No new dependencies — all implemented in pure Node.js built-ins:
- `child_process` — spawn daemons, exec launchctl/plutil/ps
- `fs` — log file tailing, PID file management, crontab write
- `os` — system info
- `crypto` — cron entry hash generation (already used in server.cjs)
