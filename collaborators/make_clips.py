# make_clips.py — usage: TTS_STUDIO_KEY=… python make_clips.py items.json > audio-map.json
import json, os, sys, time, urllib.error, urllib.request

API = "https://tts.example.com/api/v1/clips"
key = os.environ["TTS_STUDIO_KEY"]
request = json.load(open(sys.argv[1], encoding="utf-8"))
items = request.pop("items")
if any("ref" not in item for item in items):
    sys.exit("Every item needs a ref.")
urls = {}
left = items

def call(batch):
    body = json.dumps({**request, "items": batch}).encode()
    req = urllib.request.Request(API, data=body, method="POST", headers={
        "authorization": f"Bearer {key}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as response:
            return 200, json.load(response), response.headers
    except urllib.error.HTTPError as error:
        return error.code, json.load(error), error.headers

for round in range(1, 61):
    if not left:
        break
    status, body, headers = call(left[:100])
    if status == 429 and body["error"]["code"] == "rate_limited":
        seconds = int(headers.get("retry-after") or 60)
        print(f"Rate limited; waiting {seconds} s…", file=sys.stderr)
        time.sleep(seconds)
        continue
    if status != 200:
        sys.exit(f'{body["error"]["code"]}: {body["error"]["message"]}')
    for item in body["items"]:
        if item["status"] == "failed":
            sys.exit(f'{item["ref"]}: {item["error"]["code"]}: {item["error"]["message"]}')
        if item["status"] == "ready":
            urls[item["ref"]] = item["url"]
    # Send again only what is not ready yet.
    left = [item for item in left if item["ref"] not in urls]
    print(f"{len(items) - len(left)} of {len(items)} ready", file=sys.stderr)
else:
    sys.exit(f"{len(left)} clips are still pending.")

print(json.dumps(urls, indent=2, ensure_ascii=False))
