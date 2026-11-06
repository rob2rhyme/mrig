# Live checks

The checks that need Robin's API keys or Mac. Everything else is built and tested with mock models (`bun run check`). These prove each feature against the real thing. Tick each box as you go, and paste the output to the agent so it can mark the roadmap item ✅ or fix what broke.

Order: cheapest first, most expensive last. Each check says what it costs, what to run, and what passing looks like.

## Before you start (once)

- [ ] **Install mrig** from the repo folder:

  ```bash
  git clone https://github.com/rob2rhyme/mrig.git && cd mrig
  ```
  ```bash
  bun install && bun run build
  ```
  ```bash
  mkdir -p ~/.local/bin && cp dist/mrig ~/.local/bin/
  ```
  If `mrig --version` isn't found afterwards, add `~/.local/bin` to your PATH.
- [ ] **Create your config:** `mrig init` writes `~/.mrig/config.json`. The checks below add blocks to it. Each block goes inside the outer `{ }`, separated by commas.
- [ ] **Put keys in your shell, never in the config or the repo.** Add only the lines you need to `~/.zshrc`, then open a new terminal:

  ```bash
  export ANTHROPIC_API_KEY=sk-ant-...
  ```
  ```bash
  export OPENAI_API_KEY=sk-...
  ```
  ```bash
  export AI_GATEWAY_API_KEY=...
  ```

## 1. Prompt caching (L0)

Needs: Anthropic key. Costs: a few cents.

- [x] Start a session:

  ```bash
  mrig -P claude
  ```
- [x] Ask two questions in a row, for example "what files are here?" and then "which one is largest?".
- [x] Type `/cost`.

**Passed 2026-11-06** on `claude-sonnet-5-5`: `4 requests · 29,489 input (21,690 cache read, 7,787 cache write) · 630 output · ~$0.0301`, with the `prompt cache: 5m TTL` line.

**Pass:** the first line shows `(N cache read, …)` with N above 0, and a line reads `prompt cache: 5m TTL · writes billed at 1.25× input`. If N is 0, `/cost` prints a line explaining why; send that line.

## 2. Vision input (T3)

Needs: Anthropic key. Costs: a few cents.

- [ ] In a folder with any screenshot:

  ```bash
  mrig -P claude -p "what is in shot.png?"
  ```

**Pass:** it describes the picture, and there is no "Image not attached" notice.

## 3. Image generation (T4)

Needs: OpenAI key. Costs: the price of one image.

- [ ] Look up the price per image for `gpt-image-1` on OpenAI's pricing page.
- [ ] Add this block to your config, with that price in place of 0.04:

  ```json
  "image": { "model": "gpt-image-1", "pricePerImage": 0.04 }
  ```
- [ ] Run it, and answer `y` when it asks:

  ```bash
  mrig -p "draw a red fox in the snow" --json
  ```

**Pass:** a PNG appears in `images/` and opens. The JSON shows `"media":{"image":{"count":1,…}}` with your price.

## 4. Speech (T5)

### 4a. Cloud

Needs: OpenAI key. Costs: under a cent.

- [ ] Add these blocks, with the prices from OpenAI's page:

  ```json
  "speech": { "model": "gpt-4o-mini-tts", "voice": "alloy", "pricePerMillionChars": 15 },
  "transcription": { "model": "whisper-1", "pricePerMinute": 0.006 }
  ```
- [ ] Run:

  ```bash
  mrig -p "read 'Hello from mrig' aloud, then transcribe the file you made"
  ```

**Pass:** an audio file in `audio/` plays, and the transcript says "Hello from mrig".

### 4b. Local, with Wi-Fi off

Needs: a local audio server and Ollama (check 6). Costs: nothing.

- [ ] Run a local server that speaks OpenAI's `/v1/audio/speech` and `/v1/audio/transcriptions` (Speaches is one), following its own setup.
- [ ] Add a profile for it, and point both blocks at it. Replace the earlier `speech` and `transcription` blocks, and use the model ids your server lists:

  ```json
  "providers": { "audio": { "kind": "openai-compatible", "baseURL": "http://localhost:8000/v1", "model": "any" } },
  "speech": { "profile": "audio", "model": "<voice model id>", "format": "wav" },
  "transcription": { "profile": "audio", "model": "<whisper model id>" }
  ```
- [ ] Turn Wi-Fi off, then run:

  ```bash
  mrig --offline -P ollama -p "read 'The river is high today' aloud, then transcribe it"
  ```

**Pass:** both steps work with no network, and the transcript matches the sentence.

## 5. Video (T6)

Needs: an AI Gateway key, created in the AI Gateway section of the Vercel dashboard. Costs: the most of any check, so keep the cap low.

- [ ] Find the per-second price on the gateway's model page.
- [ ] Add this block, with that price in place of 0.15:

  ```json
  "video": { "model": "google/veo-3.1-fast-generate-001", "pricePerSecond": 0.15, "maxCostPerJob": 1 }
  ```
- [ ] Make a short clip:

  ```bash
  mrig -p "make a 4-second clip of a fox walking in snow"
  ```
- [ ] Check the cap: ask for a 30-second clip.

**Pass:** an `.mp4` in `videos/` plays, and the cost line matches the price × 4 seconds. The 30-second request is refused with "Nothing was started", and the gateway dashboard shows no new charge.

## 6. Local models and the eval matrix (L2, L3)

Needs: Ollama on the Mac. Costs: nothing but time.

- [ ] Install [Ollama](https://ollama.com), then start it with a large enough context:

  ```bash
  OLLAMA_CONTEXT_LENGTH=65536 ollama serve
  ```
- [ ] In a second terminal, pull a model and check it:

  ```bash
  ollama pull qwen3-coder
  ```
  ```bash
  mrig doctor -P ollama
  ```
  Both the model line and the context line should pass.
- [ ] **Trial session:** in a small scratch repo, run `mrig -P ollama` and try the three tasks in [`LOCAL_MODELS.md`](LOCAL_MODELS.md): read, rename a function, run the tests. Fill in its results table.
- [ ] **The matrix:** from the mrig folder, compare the local model with Claude on the ten eval tasks:

  ```bash
  bun run eval -P ollama,claude --matrix docs/COMPATIBILITY.md
  ```
- [ ] Commit `docs/COMPATIBILITY.md`. It's what the agent needs to choose the default `local` profile.

## 7. The web app on your Mac (Track 4, U2)

Needs: mrig built from main, and the Anthropic key from check 1. Costs: a few cents.

- [ ] Start it, then use the browser window it opens:

  ```bash
  mrig app
  ```
- [ ] Install it as an app: in Chrome or Edge, the install icon at the right of the address bar;
  in Safari, **File → Add to Dock**. Open it from the Dock.
- [ ] Open a project (the mrig folder is fine), choose **claude** in the model picker, and ask
  for a small change, for example "add a comment at the top of README.md". Answer the permission
  request with **Allow once**, then look at the diff in the card.
- [ ] Ask something long, then press **Stop**.
- [ ] Check the allowlist: `mrig app devices` lists `mac` as paired.

**Pass:** everything above works. Then write down anything that feels wrong or slow, such as
layout, wording, or keys you expected to work, and send that list. Those fixes finish U2.

## Not here

- **The A1 font spike** runs in the GurbachhanAkkhaRik font repo, not mrig. The kit (the re-encoding script, the test words and the browser page) and its steps are in [`tools/akkha-spike/`](../tools/akkha-spike/README.md); the plan is in [the encoding decision](decisions/2026-09-23-akkha-encoding.md) under "Font spike".

## Seeing progress

- **[`ROADMAP.md`](ROADMAP.md)** is the single source of status. ✅ means built; ⏳ means waiting on one of these checks.
- **[Pull requests](https://github.com/rob2rhyme/mrig/pulls):** open means waiting for review; closed means merged. Each description says what changed, what was verified and what wasn't.
- **[CI (the Actions tab)](https://github.com/rob2rhyme/mrig/actions)** shows the tests on Linux, macOS and Windows for every change.
- **`git log --oneline`** in the mrig folder lists everything merged.
