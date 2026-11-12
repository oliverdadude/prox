RADIO RELAY
===========
Streams everything your PC plays (except Garry's Mod) to a radio link you paste
into the GMod car radio once. Free: no account or paid station needed.

FIRST TIME
1. Unzip this folder anywhere. Keep RadioRelay.exe, ffmpeg.exe and
   cloudflared.exe together in the same folder.
2. Double-click RadioRelay.exe. If Windows SmartScreen warns you, click
   "More info" -> "Run anyway" (the app isn't code-signed). If Windows Firewall
   asks about cloudflared, allow it.
3. Your browser opens the control panel (http://localhost:7070).
4. Click "Go live". After a few seconds your radio link appears at the bottom,
   e.g. https://gmod-radio-linker.vercel.app/r/AbCd1234.pls
5. Copy it and paste it into the GMod radio. It stays the same every time you
   go live, so you only ever paste it once.

USING IT
- Play Spotify (or anything) on your PC. The radio follows, a few seconds behind.
- GMod's own sound is left out automatically (Windows 10 2004+ / Windows 11).
  On older Windows it captures the whole PC: mute GMod or the radio will echo.
- Volume, bass and soft clip change live.
- Announce: type text and a Windows voice reads it out while the music dips.
- Keep the black RadioRelay window open while broadcasting. Close it to stop.
  Your PC must stay on and online while people listen.

HOW "FREE" WORKS
The app serves the stream from your PC and cloudflared.exe (Cloudflare's free
"quick tunnel", no account) gives it a temporary public address. Each time you
go live, the app points your permanent radio link at the new address.
Quick tunnels are meant for light use and have no uptime guarantee. If you'd
rather use your own Icecast/Zeno station, pick "My own station" in the panel.

Settings are saved in %APPDATA%\RadioRelay\config.json (on this PC only).
That file also holds the key that lets this PC update your radio link.

Heads-up: rebroadcasting Spotify breaks Spotify's terms of use, and only
broadcast Discord or other people's voices if they're OK with it.

Included tools (unmodified, under their own licences):
- ffmpeg.exe: FFmpeg, https://ffmpeg.org (see FFMPEG-LICENSE.txt)
- cloudflared.exe: Cloudflare, https://github.com/cloudflare/cloudflared (Apache-2.0)
