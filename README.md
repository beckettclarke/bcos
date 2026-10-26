# BCOS — Umbrel Community App Store

This repo is an [Umbrel](https://umbrel.com) community app store containing **BCOS**, a
personal OS that runs as an Umbrel app: a home screen with live widgets, a Windows-style
taskbar and search, and built-in apps for Calendar, Tasks, Notes, Journal and Mail. Everything you
write is stored on your Umbrel, so it's the same on every device you open it from.

## Add to Umbrel

1. Push this repo to GitHub (or any public git host).
2. On your Umbrel, open **App Store → ⋯ (top right) → Community App Stores**.
3. Paste the repo URL and click **Add**.
4. Open the **BCOS** store and install **BCOS**.

To update: change files, bump `version` in `bcos-os/umbrel-app.yml`, push, then update
the app in Umbrel.

## What's in it

| App | Highlights |
| --- | --- |
| **Home** | Time-aware greeting, three widgets of your choice (Up next, Tasks, Journal, Habits, Notes, Inbox, Clock), app grid, ⌘K search across everything (with a calculator and quick capture). |
| **Taskbar** | Apps open fullscreen and keep running in the background. The taskbar has Start (all apps), search, pinned and running apps (click to switch, click again to minimise, right-click or middle-click to close), sync status, the clock and a show-desktop corner. Esc minimises; Ctrl+Esc opens Start. |
| **Calendar** | Day / week / month. Drag to create, move and resize events; repeating events (daily, weekdays, weekly, monthly, yearly, with an end date) with "this event or all events"; multiple calendars with colours; subscribe to `.ics`/webcal links; import and export `.ics`; tasks with due dates shown alongside events. |
| **Tasks** | Smart lists (Today, Upcoming, Important, All, Completed), your own lists with colours and icons, list / board / priority-matrix views, subtasks, notes, due dates and times, repeating tasks, drag to reorder or drop onto a list, and Habits with streaks. |
| **Notes** | Folders and subfolders, tags, pinning, search, templates, a rich editor (markdown shortcuts, `/` block menu, checklists, code, quotes, images, links), `[[note links]]` with backlinks, a contents outline, focus mode, Recently Deleted, Markdown import/export. |
| **Journal** | One entry a day with mood, activities, a daily prompt, a mood calendar and 30-day mood line, streaks, and "on this day". |
| **Mail** | Connect iCloud, Gmail, Yahoo, Fastmail or any IMAP/SMTP account (with an app-specific password). Unified inbox or one account at a time, Inbox / Sent / Archive / Junk / Trash synced both ways (read, star, move, delete), HTML mail in a sandbox, send and reply from any account, drafts, search and keyboard shortcuts. Outlook.com isn't supported: Microsoft only allows OAuth sign-in for IMAP now. |
| **Settings** | Name, wallpaper (or upload your own photo), accent colour, widgets, 24-hour time, week start, reduce motion, export / restore / erase. |

Motion is spring-based and interruptible (apps grow out of their icon and shrink
back into the taskbar); `prefers-reduced-motion`, reduced transparency and higher
contrast are respected.

## Layout

```
umbrel-app-store.yml        # store id + name
bcos-os/
  umbrel-app.yml            # app manifest (id, port 8742, metadata)
  docker-compose.yml        # stock node:alpine running server.js behind Umbrel's app_proxy
  server.js                 # static files + JSON API, no dependencies
  mail.js                   # IMAP + SMTP clients and a MIME parser for real mail accounts
  data/                     # your data (JSON per collection, uploaded images)
  www/
    index.html              # import map + boot
    vendor/                 # Preact, hooks, htm (vendored, no CDN at runtime)
    css/                    # base, ui, shell, one file per app
    js/
      main.js               # boot
      lib/                  # store (sync + offline outbox), dates, springs, drag & drop, events, tasks, feeds, seed data
      ui/                   # icons, shared components (popovers, menus, dialogs, toasts, controls)
      shell/                # home screen, widgets, taskbar, app windows, search, theme
      apps/                 # calendar, tasks, notes (+ editor), journal, mail, settings
```

There's no build step: the container is the stock `node:22.11.0-alpine` image with this
folder mounted read-only, and `www/` is served as-is (ES modules + an import map).

### Data

`server.js` keeps one JSON file per collection in `data/` and writes them atomically.
The browser writes optimistically: changes appear immediately, go into an outbox that
survives reloads, and sync when the Umbrel is reachable. Umbrel's app proxy handles
login. Export a full backup any time from **Settings → Export**.

Mail accounts: the server signs in to IMAP/SMTP itself, checks every account every
5 minutes (and whenever Mail is open), and keeps the recent messages of each folder
in the `mail` collection. Passwords live only in `data/mail-accounts.json` (readable
by the app alone) and are never sent to the browser. Full message bodies are cached
in `data/mail/`.

## Developing locally

```bash
node bcos-os/server.js
```

Then open <http://localhost:3000>. Set `PORT` or `DATA_DIR` to change where it listens
or stores data (by default `bcos-os/data/`, which git ignores).
