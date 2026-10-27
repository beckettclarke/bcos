# BCOS

Read `REPO_MAP.md` first: it maps every file, API route, data collection and app
intent, so you shouldn't need to go searching. `README.md` covers features and install.

- No build step and no dependencies: plain Node built-ins on the server, Preact + htm
  ES modules in the browser. Don't add npm packages or a bundler.
- Run: `node bcos-os/server.js` (or the `bcos-dev` launch config, port 5317).
- Shipping a change to Umbrel means bumping `version` in `bcos-os/umbrel-app.yml`.
- When you add, move or rename a module, collection, route or intent, update `REPO_MAP.md` in the same change.
