RADIO RELAY
===========
Streams everything your PC plays (except Garry's Mod) to your own internet
radio station, so one link in the GMod car radio plays whatever you play.

FIRST TIME
1. Make a free station at https://zeno.fm (or any Icecast host).
   In its broadcast / encoder settings you'll find: server, port, mount, password,
   and the public stream URL.
2. Unzip this folder anywhere (keep RadioRelay.exe and ffmpeg.exe together).
3. Double-click RadioRelay.exe. If Windows SmartScreen warns you, click
   "More info" -> "Run anyway" (the app isn't code-signed).
4. Your browser opens the control panel (http://localhost:7070).
   Fill in "Station", click Save station, then "Go live".
5. Click "Make / copy radio link" and paste that link into the GMod radio once.

USING IT
- Play Spotify (or anything) on your PC. The radio follows, ~5-30 s behind.
- GMod's own sound is left out automatically (Windows 10 2004+ / Windows 11).
  On older Windows it captures the whole PC: mute GMod or the radio will echo.
- Volume, bass and soft clip change live.
- Announce: type text and a Windows voice reads it out while the music dips.
- Keep the black RadioRelay window open while broadcasting. Close it to stop.

Settings are saved in %APPDATA%\RadioRelay\config.json (on this PC only).

Heads-up: rebroadcasting Spotify breaks Spotify's terms of use, and only
broadcast Discord or other people's voices if they're OK with it.

ffmpeg.exe is the FFmpeg project's encoder (https://ffmpeg.org), included
unmodified under its own licence (see FFMPEG-LICENSE.txt).
