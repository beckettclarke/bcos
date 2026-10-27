# BCOS repo map

Where things live, so you can jump straight to the right file. `README.md` covers
what BCOS is and how to install it; this file is for working on the code.

**Keep it current:** when you add, move or rename a module, collection, API route
or intent, update this map in the same change.

## At a glance

- Umbrel community app store (`umbrel-app-store.yml`, id `bcos`) holding one app, `bcos-os/`.
- **No build, no dependencies.** Node server is plain `node:` built-ins; the UI is
  Preact + htm ES modules served as-is (vendored in `www/vendor/`, wired by the
  import map in `www/index.html`).
- **Run locally:** `node bcos-os/server.js` → http://localhost:3000, or the
  `bcos-dev` config in `.claude/launch.json` (port 5317). Env: `PORT`, `DATA_DIR`, `WWW_DIR`.
- **Ship:** bump `version` (and `releaseNotes`) in `bcos-os/umbrel-app.yml`, push,
  update in Umbrel. In production the container runs `server.js` straight from
  Umbrel's read-only app-store checkout (see `bcos-os/docker-compose.yml`), so code
  changes don't need a manifest copy, but the version bump triggers the update.
- No tests, no linter. `bcos-os/data/` is gitignored (local dev data lives there).

## Backend (`bcos-os/`)

| File | What's in it |
| --- | --- |
| `server.js` | HTTP server: static files from `www/`, JSON API, collection store (in-memory, one JSON file per collection, atomic tmp+rename writes), image uploads, `.ics` feed proxy. `api()` ~L273, `mailApi()` ~L364. |
| `ai.js` | `createAI()`: AI provider registry (OpenAI-style, Anthropic and Gemini dialects), keys in `data/ai-providers.json` (0600), `models(id)`, `chat({ provider, model, system, messages, json })`. |
| `mail.js` | Dependency-free `Imap` class (~L140), `Smtp` class (~L384), MIME parser (`parseMime` ~L572), `buildMessage`, and `createMail()` (~L695) which owns accounts, 5-minute sync, folder mapping, actions and send. |
| `umbrel-app.yml` | Manifest: id `bcos-os`, port 8742, version, release notes. |
| `docker-compose.yml` | `node:22.11.0-alpine`, finds the app-store checkout under `/stores`, falls back to `/app/server.js`. Data mounted at `/data`. |

### API (all under `/api`)

| Route | Purpose |
| --- | --- |
| `GET /health` | liveness |
| `GET /data` | every collection + `meta { fresh, version, serverTime }` (boot snapshot) |
| `GET /info` | server/storage info for Settings |
| `PUT /c/:collection/:id`, `DELETE /c/:collection/:id` | per-item writes (collection `^[a-z][a-z0-9_]{0,31}$`, id `^[A-Za-z0-9_-]{1,80}$`) |
| `POST /import`, `POST /reset` | restore backup `{ collections }` / erase everything |
| `GET /feed?url=` | fetch a remote `.ics` for calendar subscriptions |
| `POST /files`, `GET\|DELETE /files/:id` | image upload/serve (stored as `data/files/<id>.bin` + `.meta.json`) |
| `GET /mail/presets` | IMAP/SMTP presets (iCloud, Gmail, Yahoo, Fastmail) |
| `POST /mail/accounts`, `PUT\|DELETE /mail/accounts/:id` | add/edit/remove a mail account |
| `POST /mail/sync/:accountId` | sync now; returns account + its `mail` items |
| `GET /mail/message/:id` | full body (cached in `data/mail/<id>.json`) |
| `POST /mail/action/:id` `{ op, … }` | read/star/move/delete on the server |
| `POST /mail/send` | send via SMTP |
| `GET /ai/providers` | provider status (`hasKey`, `keyHint`, `ready`) — keys are never returned |
| `PUT\|DELETE /ai/providers/:id` | set/clear `{ key, baseUrl }` |
| `GET /ai/models/:id` | list the provider's models |
| `POST /ai/chat` | run one chat `{ provider, model, system, messages, json, temperature, maxTokens }` → `{ text, usage, ms }` |

### Data (`DATA_DIR`, default `bcos-os/data/`)

`<collection>.json` = `{ id: item }`. Items carry `createdAt`/`updatedAt`.

| Collection | Key fields |
| --- | --- |
| `settings` | single item `prefs`; defaults in `DEFAULT_SETTINGS` (`www/js/lib/store.js`); `ai { presets, defaultPreset, tasks }`, `journal { font }` |
| `calendars` | name, color, visible, kind, order |
| `events` | calendarId, title, start/end (epoch ms), location, recurrence |
| `lists` | name, color, icon, view, sort, order |
| `tasks` | listId, title, notes, due (`YYYY-MM-DD`), dueTime, priority, status, done, subtasks, tags, repeat, order |
| `habits` | name, emoji, color, freq, order, log |
| `folders` | name, color, order (Notes folders) |
| `notes` | folderId, title, html, text, tags, pinned, trashed |
| `journal` | id = date (`YYYY-MM-DD`), `v: 2`, icon, title, rating (0.5–5), mood (1–7; v1 entries were 1–5, read via `moodOf`), html, text, meals `{ breakfast\|lunch\|dinner\|snacks: [Food] }`, cards `[{ id, type, … }]`, people, tags, photos `[{ id, url }]` |
| `mail` | mailbox, read, starred, date, from, to, subject, body/snippet, `account` (absent = local mailbox) |
| `mail_accounts` | display info only (name, address, last sync, errors) |

Not collections: `mail-accounts.json` (passwords, 0600, never sent to the browser), `ai-providers.json` (AI keys, same rules),
`mail/` (body cache), `files/` (uploads). Calendar feed events are never stored
server-side; they live in memory + localStorage (`lib/feeds.js`).

## Frontend (`bcos-os/www/`)

Boot: `index.html` → `js/main.js` → `store.boot({ seed })` → render `shell/App.js`,
open the app from `#hash`, then idle-preload apps and refresh feeds.

Every module imports Preact through `js/lib/html.js` (`html`, `h`, `render`, all hooks).

### `js/lib/` — logic, no UI

| File | Exports / role |
| --- | --- |
| `store.js` | **The data layer.** Sync reads from memory; optimistic writes into a localStorage outbox that retries; snapshot cache for instant boot; "local" mode when there's no server. `get`, `all`, `useCollection`, `useItem`, `put`, `patch`, `remove`, `putMany`, `absorb`, `api`, `settings`/`useSettings`/`setSettings`, `boot`, `refresh`, `exportAll`/`importAll`/`resetAll`, `uploadImage`, `serverInfo`, `fetchFeed`, `useStatus`. |
| `date.js` | Local-time helpers: `dayKey`/`fromKey`/`todayKey`, `startOfWeek`, `monthGrid`, `fmt`, `fmtTime`, `relativeDay`, `timeAgo`, `greeting`, … |
| `events.js` | Calendar logic: `expand` (recurrence), `layoutDay`/`layoutWeekRow` (overlap), `REPEAT_PRESETS`/`presetToRule`/`describeRule`, `parseIcs`/`toIcs`, `CAL_COLORS`. |
| `tasks.js` | Task/habit rules: `SMART_LISTS`/`smartFilter`, `sortTasks`, `setDone`, `nextRepeatDue`, `dueInfo`, `PRIORITIES`, `QUADRANTS`, `habitStreak`/`habitRate`. |
| `feeds.js` | Subscribed `.ics` calendars: `useFeeds`, `feedEvents`, `refreshFeed`, `refreshStaleFeeds`. |
| `dnd.js` | Pointer drag & drop via `data-dnd-zone` / `data-dnd-id` / `data-dnd-target`: `startDrag`, `orderAt`. |
| `motion.js` | Springs (`response`/`damping`), `Spring`, `project`, `rubberband`, `VelocityTracker`, reduced-motion switch. |
| `util.js` | `uid`, `cx`, `debounce`, `plural`, `download`, `pickFile`, `downscaleImage`, `modKey`, `isTyping`, … |
| `seed.js` | First-run sample data, laid out around today. |
| `ai.js` | AI client: `PROVIDERS`/`PROVIDER_GROUPS` (display info, icons in `www/vendor/ai/`), `AI_TASKS` (every AI feature — add new ones here), `useAI`/`refreshProviders`/`saveProvider`/`fetchModels`, `presetFor(taskId)`, `chat(preset, …)`, `parseJSON`. |

### `js/ui/` — shared UI

- `components.js`: layer stack (`Portal`, `Popover`, `openMenu`/`openContextMenu`, `confirm`, `prompt`, `toast`, `useEscape`), hosts (`MenuHost`, `DialogHost`, `Toaster`), controls (`IconButton`, `Segmented`, `Toggle`, `Avatar`, `EmptyState`, `ColorDots`, `AutoTextarea`), hooks (`useDraft`, `useMedia`, `useNarrow`, `useTick`).
- `icons.js`: `Icon name=…` line icons, app glyphs, `BcosMark`. Add new icons here.
- `ai.js`: `ProviderIcon`, `choosePreset(taskId, anchor)` (asks via a menu when the task is set to "Ask"), `runTask(taskId, anchor, { system, prompt, json })`.
- `emoji.js`: `EmojiPicker` popover (curated sets + search + any typed emoji).

### `js/shell/` — the "OS"

| File | Role |
| --- | --- |
| `os.js` | Window-manager state: `os { app, running, intent, origin, spotlight, start, nonce }`, `useOS`, `openApp(id, intent, fromEl)`, `minimizeApp`, `closeApp`, `toggleApp`, `setSpotlight`, `setStart`, hash sync. **Everything opens apps through `openApp`.** |
| `apps.js` | `APPS` registry (id, name, glyph, lazy `load`). Register new apps here. |
| `App.js` | Root: wallpaper, Desktop, Windows, Taskbar, Spotlight, layer hosts, global shortcuts. |
| `Windows.js` | Keeps each running app mounted fullscreen; grow/shrink animation; `preloadApps`. |
| `Desktop.js` | Home screen: greeting, widgets, app grid. |
| `widgets.js` | `WIDGETS` (upnext, tasks, journal, habits, notes, inbox, clock) and `Widget`. |
| `Taskbar.js` | Start menu, search, pinned/running apps, tray, show-desktop; `useBadges`. |
| `Spotlight.js` | ⌘K search across apps/events/tasks/notes/journal/mail, quick capture, calculator. |
| `theme.js` | `WALLPAPERS`, `ACCENTS`, `applyAccent`, `Wallpaper`. |

### `js/apps/` — one default-exported component per app, props `{ intent, nonce }`

| App | File | Intents (`openApp(id, { type, … })`) |
| --- | --- | --- |
| Calendar | `calendar.js` | `date {date}`, `event {id, date?}`, `new` |
| Tasks (+ Habits) | `tasks.js` | `list {id}` (list id or smart list `today`/`upcoming`/`important`/`all`/`completed`), `task {id}`, `new` |
| Notes | `notes.js` (also exports `createNote`) | `note {id}`, `new {title?}` |
| Journal | `journal.js` (sidebar month rail, entry view, food log); `journal-shared.js` (`MOODS` 7-point, `MEALS`, `moodOf`, `tagsOf`, `hasContent`, `journalStats`); `journal-cards.js` (`CARD_TYPES` with fields — add card types here, `Card`, `CardEditor`, `normalizeCard`, enrich prompt); `journal-food.js` (offline `parseFoodText`/`iconFor`, smart-food prompt, `normalizeMeals`); `journal-import.js` (`IMPORT_GUIDE` = the LLM instructions, `readImport`, `entriesForFile` (file-name dates), `combine`/`saveImport`); `journal-import-ui.js` (`ImportSheet`). Import format documented in `bcos-os/JOURNAL_IMPORT.md`. | `day {date?}`, `import` |
| Mail | `mail.js` (exports `syncAccount`) | `mailbox`, `message`, `compose`, `add-account` |
| Settings | `settings.js`, AI tab in `settings-ai.js` | `{ section }` (opens that tab, e.g. `'ai'`; no `type`) |
| Rich editor | `editor.js`: `RichEditor`, `sanitize`, `fromMarkdown`/`toMarkdown`, `BLOCKS` (`/` menu), `refreshNoteLinks` (`[[links]]`). Used by Notes and Journal. | |

### `css/`

`base.css` (tokens, reset), `ui.css` (shared components), `shell.css` (home,
taskbar, windows, search), then one file per app (`calendar`, `tasks`, `notes`,
`journal`, `mail`, `settings`). All linked from `index.html`; a new app's CSS file
must be added there too.

## Recipes

- **New app:** component in `js/apps/<id>.js` (default export, `{ intent, nonce }`),
  glyph in `ui/icons.js`, entry in `shell/apps.js`, `css/<id>.css` linked in `index.html`,
  optionally a widget in `shell/widgets.js` and results in `shell/Spotlight.js`.
- **New collection:** just `put('<name>', item)`; the server creates it on first
  write. Add sample data in `lib/seed.js` and a row to the Data table above.
- **New setting:** add the default to `DEFAULT_SETTINGS` in `lib/store.js` (nested
  objects are merged there too), the control in `apps/settings.js`.
- **Server-side behaviour:** routes in `api()` in `server.js`; mail work in `createMail()` in `mail.js`.
