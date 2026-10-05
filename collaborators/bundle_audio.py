# bundle_audio.py — usage: python bundle_audio.py page.html [--files]
#
# Puts the DialogueLab audio a finished page uses inside the page, for places
# that only play media of their own, such as pages published by Claude: there,
# audio linked from another site stays silent.
#
#   default   page.bundled.html: one file, every clip embedded in it
#   --files   page-bundle/index.html and page-bundle/audio/<id>.mp3: publish
#             them together, for a page too big to hold its audio (over 15 MB)
#
# The page itself is untouched. Python 3.8 or later, nothing to install.
import base64, concurrent.futures, re, sys, urllib.request
from pathlib import Path

# A clip link, also written with JSON's escaped slashes (https:\/\/…).
CLIP = re.compile(
    r"https?:(?:\\?/){2}[^\s\"'<>()]+?(?:\\?/)api(?:\\?/)v1(?:\\?/)clips(?:\\?/)([0-9a-f]{32})\.mp3")
LIMIT = 15_000_000  # Claude's published pages take at most 16 MB


def fetch(url):
    # Cloudflare refuses Python's own User-Agent (error 1010), so send another.
    request = urllib.request.Request(url.replace("\\/", "/"), headers={"user-agent": "dialoguelab-bundle/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    if not (data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0)):
        raise SystemExit(f"{url} did not return an MP3.")
    return data


args = sys.argv[1:]
as_files = "--files" in args
pages = [a for a in args if a != "--files"]
if len(pages) != 1:
    sys.exit("usage: python bundle_audio.py page.html [--files]")
page = Path(pages[0])
with open(page, encoding="utf-8", newline="") as f:  # newline="": keep the page's line endings
    html = f.read()

links = {m.group(1): m.group(0) for m in CLIP.finditer(html)}  # clip id -> a link to it
if not links:
    sys.exit(f"No DialogueLab clip links in {page.name}: nothing to bundle.")
print(f"{page.name}: {len(links)} clips, fetching…", file=sys.stderr)
with concurrent.futures.ThreadPoolExecutor(8) as pool:
    audio = dict(zip(links, pool.map(fetch, links.values())))


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


if as_files:
    out = page.with_name(page.stem + "-bundle")
    (out / "audio").mkdir(parents=True, exist_ok=True)
    for clip_id, data in audio.items():
        (out / "audio" / f"{clip_id}.mp3").write_bytes(data)
    write(out / "index.html", CLIP.sub(lambda m: f"audio/{m.group(1)}.mp3", html))
    size = sum(map(len, audio.values()))
    print(f"Wrote {out}: index.html and {len(audio)} clips in audio/ ({size / 1e6:.1f} MB).")
    print("Publish them together: the page plays audio/<id>.mp3 by relative path.")
else:
    embedded = {clip_id: "data:audio/mpeg;base64," + base64.b64encode(data).decode() for clip_id, data in audio.items()}
    out = page.with_name(page.stem + ".bundled.html")
    write(out, CLIP.sub(lambda m: embedded[m.group(1)], html))
    size = out.stat().st_size
    print(f"Wrote {out.name}: {len(audio)} clips inside, {size / 1e6:.1f} MB. Publish this file.")
    if size > LIMIT:
        print("Too big for a page published by Claude (16 MB at most): run again with --files,", file=sys.stderr)
        print("or split the exercise into several pages.", file=sys.stderr)
