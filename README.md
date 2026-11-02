# 📻 GMod Radio Linker

A small website that connects to your Spotify and gives you links you can paste into a Garry's Mod radio / media player.

**Why not just paste the Spotify link?** Spotify audio is DRM-locked, so in-game radios can't play it. This site takes the song you pick in Spotify, finds the same song on YouTube (it prefers the official audio upload with the right length) and copies that link for you.

## What it does

- **Now playing:** shows what's playing on your Spotify. One click copies the radio link. You get play/pause/skip too, but Spotify only allows those from websites if you have Premium.
- **Search, playlists, liked songs, recently played:** every song gets a **📋 Copy link** button.
- **🎯 Pick video:** if the automatic match is wrong, choose another YouTube result or paste your own link. Your choice is saved for that song.
- **Radio queue:** line songs up, then press **Copy next ▶** each time. A timer shows how long the song on the radio has left and beeps about 15 seconds before it ends, so you know when to paste the next one.
- Runs entirely in your browser. There's no server, and your login and keys are stored only on your device.

## Setup

### 1. Host the site (free, GitHub Pages)

1. On GitHub open this repo → **Settings → Pages**.
2. Under "Build and deployment" choose **Deploy from a branch**, pick the branch and `/ (root)`, then click Save.
3. After a minute your site is live at `https://<your-username>.github.io/<repo-name>/`.

Spotify requires `https://`, which GitHub Pages provides. To test on your own PC, run `python3 -m http.server 8000` in this folder and open **http://127.0.0.1:8000/**. Use `127.0.0.1`, not `localhost`, because Spotify rejects `localhost` redirect URIs.

### 2. Create a Spotify app (one time)

1. Go to <https://developer.spotify.com/dashboard> → **Create app**.
2. Give it any name and description. Under **Redirect URIs**, add the exact address of your site, which the site shows you on first visit (for example `https://you.github.io/prox/`). Tick **Web API** and save.
3. Copy the **Client ID** and paste it into the site. Then click **Connect Spotify**.

> Spotify "development mode" apps only work for the app owner plus up to 5 users you add under the app's **User Management**. That's fine for personal use.

### 3. (Recommended) YouTube API key

Without a key, the site opens a YouTube search and you paste the right video link once (it remembers it). With a key, finding the link is automatic.

1. Go to <https://console.cloud.google.com/>, create a project, and enable **YouTube Data API v3**.
2. Go to **Credentials → Create credentials → API key**. Optionally, restrict it to the YouTube Data API and your site's address.
3. Paste it into ⚙️ **Settings** on the site.

The free quota is about 100 new song lookups per day. Songs you've already looked up are cached, so repeats cost nothing.

## Settings

- **Link type:** `youtube.com/watch?v=…`, `youtu.be/…`, or the raw Spotify link (only useful if your server's radio supports Spotify).
- **Search YouTube for:** "audio" (default, avoids music videos with intros/skits), "lyrics", or plain.
- **Beep** when the radio song is nearly over.

## Files

- `index.html`: the page
- `styles.css`: styling
- `app.js`: Spotify login (PKCE), Spotify API calls, YouTube matching, queue/timer
