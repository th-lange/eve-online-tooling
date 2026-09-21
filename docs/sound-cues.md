# Combat sound cues

The fight overlay (and any module via `src/lib/sound.ts`'s `playCue`) plays short
spoken-word audio clips for combat events. The clips are **committed static
assets** in `src/assets/sounds/*.wav`, so nothing is generated at build or run
time and playback is fully cross-platform (HTML5 Audio in the Tauri webview — no
OS text-to-speech binary, unlike the browser Web Speech API which is silent on
WebKitGTK).

## Clips

| File            | `CueSound` key | Spoken phrase   | Fires when                                  |
| --------------- | -------------- | --------------- | ------------------------------------------- |
| `scram.wav`     | `scram`        | "Scrambled"     | an enemy warp-scrambles you                 |
| `scram-off.wav` | `scramOff`     | "Scramble off"  | the scramble drops                          |
| `point.wav`     | `point`        | "Pointed"       | an enemy warp-disrupts (points) you         |
| `point-off.wav` | `pointOff`     | "Point off"     | the point drops                             |
| `drones.wav`    | `drones`       | "Launch drones" | your fit has drones but none are firing     |

## Regenerating / adding clips

Generated with [piper](https://github.com/rhasspy/piper) (neural TTS), voice
`en_US-lessac-medium`. piper is a **dev-time tool only** — it is not a project
dependency.

```sh
# 1. Get the piper binary (Linux x86_64 shown; see releases for other OSes)
cd /tmp && curl -fsSL -o piper.tar.gz \
  https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
tar xzf piper.tar.gz

# 2. Get a voice model + config
base=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium
curl -fsSL -o voice.onnx      "$base/en_US-lessac-medium.onnx"
curl -fsSL -o voice.onnx.json "$base/en_US-lessac-medium.onnx.json"

# 3. Generate a clip (repeat per phrase), then copy into src/assets/sounds/
export LD_LIBRARY_PATH="$PWD/piper:$LD_LIBRARY_PATH"
echo "Launch drones" | ./piper/piper --model voice.onnx --config voice.onnx.json \
  --output_file drones.wav
```

Output is 22 050 Hz mono 16-bit PCM WAV. Keep phrases short (one or two words).
To add a new cue: generate the WAV, drop it in `src/assets/sounds/`, then add an
`import` + a key to `CUES` in `src/lib/sound.ts`.
