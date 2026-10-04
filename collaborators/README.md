# TTS Studio for collaborators

Everything you need to make listening material with TTS Studio. There are two
ways to use it; you may need one or both.

## 1. Material for the TTS Studio reader

Write dialogues, monologues or single sentences as plain text and send the file
to the site owner, who imports it into the reader.

| File | What it is |
| --- | --- |
| `listening-format.md` | The format, with a ready prompt for converting existing material with a chat model. |
| `listening-pack.txt` | A complete example file. |

## 2. Audio for your own pages

Build HTML exercises that play TTS Studio voices. The audio is made once, while
you build the page; the page then only plays permanent links, which costs
nothing however often students listen.

| File | What it is |
| --- | --- |
| `clips-api.md` | Everything an AI agent needs to do this. Give it this file. |
| `make-clips.mjs` | The build script from the guide, for Node 18 or later. |
| `make_clips.py` | The same script for Python 3. You only need one of the two. |
| `KEY.txt` | Your API key, if this folder was made for you. |

Your key is personal: keep it private, and never put it in a page you publish.
The build script reads it from the environment variable `TTS_STUDIO_KEY`.
