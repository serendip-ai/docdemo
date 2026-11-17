#!/usr/bin/env bash
# Usage: docs/make-gif.sh <demo-folder> <out.gif> [hold-frame]
# Records the README's animated preview: opens the demo's player, clicks Next through every frame, and
# turns the screenshots into a looping GIF. On a fill step it types the value into the field a few letters
# at a time and presses Enter, the way a viewer would; on a dropdown step it opens the list, highlights the
# recorded choice and picks it. (A browser's own dropdown popup never shows in a screenshot, so the open list
# is the player's dropdown drawn as a list box.) Frames hold 1.6 s; the optional hold-frame (1-based,
# e.g. the frame with a doc mismatch) and the last frame hold about 3 s. Needs playwright-cli and ffmpeg.
set -euo pipefail
DEMO="$(cd "${1:?usage: make-gif.sh <demo-folder> <out.gif> [hold-frame]}" && pwd)"
OUT="${2:?usage: make-gif.sh <demo-folder> <out.gif> [hold-frame]}"
HOLD="${3:-0}"
PORT="${PORT:-4190}"
WORK="$(mktemp -d)"
FRAMES=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DEMO/demo.json','utf8')).steps.length)")
# The value to type on each frame (one line per frame, empty when the frame is not a fill step).
FILLS="$(node -e "for (const s of JSON.parse(require('fs').readFileSync('$DEMO/demo.json','utf8')).steps)
  console.log(s.status === 'ok' && s.action?.kind === 'fill' && s.hotspot ? String(s.action.value ?? '').replace(/\n/g, ' ') : '')")"
# The choice to pick on each frame, as a JSON [label, group] pair (empty when the frame is not a dropdown step).
PICKS="$(node -e "for (const s of JSON.parse(require('fs').readFileSync('$DEMO/demo.json','utf8')).steps)
  console.log(s.status === 'ok' && s.action?.kind === 'select' && s.hotspot && s.action.options ? JSON.stringify([s.action.picked, s.action.pickedGroup ?? null]) : '')")"

# playwright-cli blocks file:// URLs, so serve the demo over HTTP.
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DEMO" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; playwright-cli -s=gif close >/dev/null 2>&1; rm -rf "$WORK"' EXIT
sleep 1

pw() { playwright-cli -s=gif "$@" >/dev/null; }
N=0
: > "$WORK/list.txt"
shot() {   # shot <seconds>: screenshot the player and show it for that long
  N=$((N + 1))
  pw mousemove 1270 630                 # keep the pointer off the buttons (no hover styles)
  pw eval "() => new Promise(r => setTimeout(r, ${2:-400}))"
  pw screenshot --filename "$WORK/$(printf %04d "$N").png"
  printf "file '%s'\nduration %s\n" "$(printf %04d "$N").png" "$1" >> "$WORK/list.txt"
}
pw open "http://127.0.0.1:$PORT/index.html"
pw resize 1280 640
LAST=$((FRAMES + 1))
for i in $(seq 1 "$LAST"); do          # every frame plus the end card
  d=1.6; [ "$i" = "$HOLD" ] && d=3.2; [ "$i" = "$LAST" ] && d=3
  value="$(sed -n "${i}p" <<< "$FILLS")"
  choice="$(sed -n "${i}p" <<< "$PICKS")"
  if [ -n "$choice" ]; then
    pw eval "() => document.getElementById('pick').focus()"
    shot 1
    # Open: show the list as a list box over the page, scrolled to the recorded choice and highlighting it.
    pw eval "() => { const [label, group] = $choice, p = document.getElementById('pick');
      const o = [...p.options].find(o => o.label === label && (!group || o.parentElement.label === group));
      p.dataset.h = p.style.height; Object.assign(p.style, { height: 'auto', zIndex: 5 }); p.size = 8;
      o.selected = true; p.scrollTop = Math.max(0, o.offsetTop - p.clientHeight / 2); document.getElementById('chip').hidden = true; }"
    shot 1.4
    # Closed, showing the choice; then the change event the player listens for moves to the next frame.
    pw eval "() => { const p = document.getElementById('pick'); p.size = 0; Object.assign(p.style, { height: p.dataset.h, zIndex: '' }); document.getElementById('chip').hidden = false; }"
    shot 0.7
    pw eval "() => document.getElementById('pick').dispatchEvent(new Event('change'))"
  elif [ -n "$value" ]; then
    pw eval "() => document.getElementById('typein').focus()"
    shot 1
    for ((k = 0; k < ${#value}; k += 2)); do
      pw type "${value:k:2}"
      if (( k + 2 < ${#value} )); then shot 0.12 50; fi
    done
    shot "$d"
    pw press Enter
  else
    shot "$d"
    playwright-cli -s=gif click "getByRole('button', { name: /Next|Finish/ })" >/dev/null 2>&1 || true
  fi
done
printf "file '%s'\n" "$(printf %04d "$N").png" >> "$WORK/list.txt"   # concat needs the last file twice

ffmpeg -loglevel error -y -f concat -safe 0 -i "$WORK/list.txt" \
  -vf "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  -loop 0 "$OUT"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1), $LAST frames, $N images)"
