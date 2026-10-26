# BCOS — Umbrel Community App Store

This repo is an [Umbrel](https://umbrel.com) community app store containing the **BCOS** app.

## Add to Umbrel

1. Push this repo to GitHub (or any public git host).
2. On your Umbrel, open **App Store → ⋯ (top right) → Community App Stores**.
3. Paste the repo URL and click **Add**.
4. Open the **BCOS** store and install **BCOS**.

## Layout

```
umbrel-app-store.yml        # store id + name
bcos-os/
  umbrel-app.yml            # app manifest (id, port 8742, metadata)
  docker-compose.yml        # nginx serving ./www behind Umbrel's app_proxy
  www/
    index.html              # "OS ready" screen
    background.jpg          # background photo from Unsplash
```

The app uses the stock `nginx:alpine` image and mounts `www/` from the app
directory, so no custom Docker image needs to be built or pushed. Edit files in
`www/`, bump `version` in `umbrel-app.yml`, push, and update the app in Umbrel.
