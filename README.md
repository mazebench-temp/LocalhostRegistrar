# Localhost

**This repository is frozen.** Add and configure sites in their own repositories. Do not modify LocalhostRegistrar to register a project.

Type `localhost` to open the launcher at [localhost:7777](http://localhost:7777).

## Register a site

Inside your project's root folder, create:

```text
~/code/GitHub/MyProject/
└── .localhost/
    ├── app.json
    └── icon.png    # optional
```

Put your start command and port in `.localhost/app.json`:

```json
{
  "command": "npm run dev",
  "port": 3000
}
```

Use a unique, available port other than `7777`. The command must start an HTTP server on that port and stay running in the foreground. Localhost sets the `PORT` environment variable; if your server ignores it, specify the port in your command or project config too.

Add a square `icon.png` alongside the JSON for a custom app icon. Without it, Localhost uses the project's initials.

Run `localhost`. The site appears automatically within a few seconds. Click its icon to start and open it.

## Optional settings

The project folder name is the default app name, and commands run from the project root. Add these fields to `app.json` if needed:

- `"name": "My Site"` — a custom label.
- `"cwd": "site"` — run the command from a project subfolder.
- `"icon": "icon.svg"` — use another image inside `.localhost/`, or an emoji such as `"🌱"`.

## Shortcut

From the other project's root, this creates `.localhost/app.json` without overwriting an existing file:

```sh
localhost init --port 3000 --command "npm run dev"
```

Commit `.localhost/` in that project's repository. Registration needs no changes to this frozen repo.
