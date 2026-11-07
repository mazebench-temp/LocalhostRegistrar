# Localhost

A local home screen for your projects: just app icons and their names. Type `localhost`, click an app icon, and its development server restarts and opens in your browser.

Hover over a running app to temporarily replace its icon with a power control; click it to shut down that app. Move away to see the icon again. Right-click for controls and logs, or tap a running app on a touch screen. The smaller red power button at the bottom shuts down everything, including Localhost. It stays available even when Localhost is the only running app. Run `localhost` again to bring it back.

Drag an icon with a mouse or touch to rearrange apps. The order is saved in this browser and survives page reloads; newly registered apps appear after your arranged apps. Press Escape to cancel a drag. Keyboard users can focus an icon and hold Alt while pressing an arrow key to move it. Registration files remain unchanged.

Localhost has its own `.localhost/app.json` and icon in this repo. It is recognized as the current launcher process, automatically uses the active launcher port, and never launches a second copy of itself. Its icon also appears when you customize the projects directory.

**Registration lives with the project.** This repository does not need to change when you add an app. No packages, account, database, or build step required. Requires Node.js 22+ and macOS or Linux.

## Install and open

```sh
npm run install-command
localhost
```

The command is installed at `~/.local/bin/localhost` (that directory must be on your `PATH`). It starts a background launcher at **http://localhost:7777** and opens your default browser. Closing your terminal or the dashboard leaves your apps running. You can also use `npm start` without installing the command.

## Register a project

Create these files in any direct child of `~/code/GitHub`:

```text
~/code/GitHub/MyProject/
├── .localhost/
│   ├── app.json
│   └── icon.png       # optional
└── …your project…
```

`.localhost/app.json` only needs two fields:

```json
{
  "command": "npm run dev",
  "port": 3000
}
```

That's the entire registration API. The launcher scans every two seconds. No requests, central registry edits, or dependencies to import. A square `icon.png` beside the JSON becomes the app icon; otherwise the app gets a colored monogram.

Or create the file from the project root:

```sh
localhost init --port 3000 --command "npm run dev"
```

`init` never overwrites an existing config. Commit `.localhost/` to the project's own repository so the registration travels with it.

### Optional settings

```json
{
  "name": "My lovely app",
  "command": "npm run dev -- --port 3001 --strictPort",
  "port": 3001,
  "cwd": "site",
  "icon": "icon.png",
  "color": "#507b68",
  "path": "/dashboard",
  "env": { "NODE_ENV": "development" }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `command` | Required | Shell command that stays in the foreground. Don't append `&` or use daemon mode. |
| `port` | Required | Unique port the app's HTTP server listens on. |
| `name` | Project folder name | Label below the icon. |
| `cwd` | Project root | Working folder, relative to the project root (absolute paths also work). |
| `icon` | `icon.png`, if present | Filename inside `.localhost/`, or an emoji such as `🌱`. PNG, JPG, WEBP, SVG, and ICO supported, up to 2 MB. |
| `color` | Chosen from a palette | Six-digit hex color for the fallback icon. |
| `path` | `/` | Path to open on the local app. |
| `env` | `{}` | Extra environment variables, as strings. Don't commit secrets. |

Commands inherit the launcher's environment, plus `PORT` set to the registered port. **If your server does not honor `PORT`, set its port in `command` or its own config.** For Vite, use `npm run dev -- --port 3000 --strictPort`; for Python, `python3 -m http.server 8000`; for Next.js, `npm run dev -- --port 3000`. Set a distinct port for each app. The command runs through your shell in non-interactive mode, so use executable commands rather than interactive aliases.

## Behavior

- Clicking a stopped project icon starts its registered command, waits for an HTTP response below status 500, and opens the app in a new tab. Allow browser pop-ups for automatic opening. Hovering over a running icon shows its shutdown control. Use the icon's context menu to **Restart & open**, **Open** without restarting, or read **Logs**. On touch screens, tap a running icon to open this menu.
- Processes run in the background independently of your terminal. If an app exits, the launcher retries with increasing delay (up to 30 seconds) until stopped. If an app cannot become ready within 90 seconds, it stops with a visible error and logs.
- Stop controls terminate the app's process group, including typical dev-server child processes. A small runner watches the launcher's connection and cleans up even if the launcher crashes. Commands that deliberately detach into their own session are unsupported.
- An already occupied port produces a helpful error. Localhost never kills an unknown process to reclaim a port.
- Config edits appear automatically; a running app adopts command changes on its next restart. Removing the config or making it invalid stops its managed app. Duplicate ports and malformed configs appear as registration issues.
- Apps start on demand. A machine restart or launcher shutdown does not automatically relaunch them. This first version supports local HTTP apps, not HTTPS-only servers.
- The launcher listens only on `127.0.0.1`. It checks Host and Origin headers and requires JSON for writes. Registration files are trusted local code: review a project's command before launching it.
- Recent output (64 KB per app) is available under **Logs** in the icon's menu. Launcher diagnostics live in `~/.localhost-registrar/launcher.log`; no runtime files are written into this repo.

## Commands

```sh
localhost                    # Start launcher and open dashboard
localhost --no-open          # Start without a browser
localhost list               # Show apps and status
localhost stop "My app"      # Stop a single app (ID also accepted)
localhost stop               # Stop all apps; leave dashboard available
localhost shutdown           # Stop all apps and the launcher
localhost --help
```

Settings are environment variables:

```sh
LOCALHOST_PROJECTS_DIR=~/projects LOCALHOST_PORT=7777 localhost
```

`LOCALHOST_PROJECTS_DIR` defaults to `~/code/GitHub`; `LOCALHOST_PORT` defaults to `7777`; `LOCALHOST_DATA_DIR` defaults to `~/.localhost-registrar`. Set them consistently in your shell profile if customized. Shut down an existing launcher before changing its root or environment. Discovery is intentionally one level deep: `<projects directory>/<project>/.localhost/app.json`.

## Optional HTTP control API

Registration only needs files. For other tools that want lifecycle controls:

| Method | Endpoint | Result |
| --- | --- | --- |
| GET | `/api/apps` | `{ apps, issues, projectsDir }`; app IDs, URLs, statuses, and errors. |
| POST | `/api/refresh` | Discover config changes immediately. |
| POST | `/api/apps/:id/launch` | Restart/start; returns `{ app }` in `starting` state. Poll `/api/apps` until `running` or `error`. |
| POST | `/api/apps/:id/stop` | Stop one app. For the entry with `isSelf: true`, stop all apps and the launcher. |
| POST | `/api/stop-all` | Stop all apps. |
| GET | `/api/apps/:id/logs` | `{ logs }` with recent output. |
| POST | `/api/shutdown` | Stop apps and launcher. |
| GET | `/api/health` | Launcher identity and version. |

```sh
curl http://localhost:7777/api/apps
curl -X POST http://localhost:7777/api/refresh \
  -H 'Content-Type: application/json' -d '{}'
```

Use this API from local scripts. Cross-origin browser requests are rejected. Starting an app with a busy port returns 409. Unknown apps return 404. Stop-all does not shut down the launcher itself.

## Development

```sh
npm run dev     # Foreground server, Ctrl-C stops it and all managed apps
npm run check   # Syntax checks
npm test        # Integration tests with temporary projects and real processes
```

The app uses Node's standard library and vanilla browser JavaScript; there is nothing to install or build.

Uninstall the terminal shortcut with `rm ~/.local/bin/localhost` after `localhost shutdown`.
