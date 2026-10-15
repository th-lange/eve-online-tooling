# Combat recording

The app can start and stop a video recorder **automatically when a fight is
detected** — the same detection the Combat Overview uses (a fight starts with
the first combat line in your gamelog and ends after 5 seconds of silence).
The app never captures video itself; it drives an external recorder. Both
paths live in **Settings → Record fights** and can be used together.

## Prerequisites

1. **Settings → Display Combat Overview: on.** Recording rides the overlay's
   fight detection; without it nothing triggers.
2. A **Gamelogs folder** configured once in the DPS Meter module (the overlay
   tails the newest gamelog from there on its own).
3. **Settings → Record fights: on.** Off by default — nothing runs until you
   enable it.

How a recording runs, whichever path you pick:

- **Fight start** (first combat line) → recorder starts.
- **Fight end** (5 s of silence) → recorder stops after the configurable
  **post-roll** (default 10 s), so the aftermath stays in the clip. If combat
  re-erupts within the post-roll, the same recording keeps rolling.
- Turning *Record fights* off mid-fight stops the recorder immediately.

## Path A — OBS (recommended)

OBS brings hardware encoding and, crucially, the **replay buffer**: the
seconds *before* the fight was detected — the alpha strike that started it —
end up in a clip too.

1. Install [OBS Studio](https://obsproject.com/) 28 or newer (obs-websocket is
   bundled).
2. In OBS: **Tools → WebSocket Server Settings** → *Enable WebSocket server*.
   Note the port (default `4455`) and the password (or disable
   authentication).
3. Create a scene with a **window / game capture** of your EVE client — the
   window is titled `EVE - <CharacterName>`, so each character's client can be
   targeted precisely.
4. Optional but recommended: **Settings → Output → Replay Buffer: on**, then
   start the buffer (Controls → *Start Replay Buffer*, or enable auto-start in
   OBS's general settings).
5. In this app: **Settings → Record fights → Drive OBS: on**, URL
   `ws://127.0.0.1:4455`, the password from step 2, then **Test connection** —
   it replies with the OBS version when everything is wired.

Per fight, the app then:

- saves the replay buffer (skipped quietly when the buffer is off) and starts
  a recording on fight start;
- stops the recording on fight end (+ post-roll);
- writes a sidecar next to the finished clip — `<clip>.fight.json` with the
  fight's exact time span, damage totals, and the attackers (name + ship) —
  so external tooling can index clips by fight.

## Path B — command hooks (any recorder)

For recorders without an API, two shell commands run through `sh -c`
(`cmd /C` on Windows): one on fight start, one on fight end. `{start}` and
`{end}` are replaced with the fight's epoch seconds, handy for file names.
Exit codes are ignored by design — a recorder that is already running must not
surface as an overlay error.

Example with [gpu-screen-recorder](https://git.dec05eba.com/gpu-screen-recorder/about/)
on Linux (flags vary by version — check `gpu-screen-recorder --help`):

- **Fight start command**

  ```sh
  gpu-screen-recorder -w screen -f 60 -a default_output -o "$HOME/Videos/eve-fight-{start}.mp4"
  ```

- **Fight end command**

  ```sh
  pkill -SIGINT -f gpu-screen-recorder
  ```

  (`SIGINT` makes it finalize the file.)

If you run gpu-screen-recorder's own **replay service** instead, leave the
start command empty and make the end command save the buffer, e.g.
`killall -SIGUSR1 gpu-screen-recorder` — you get pre-fight seconds without
OBS.

Anything scriptable works the same way: `ffmpeg`, `wf-recorder`, a `curl` to
some other tool's API, or a notify-send if you just want a ping.
