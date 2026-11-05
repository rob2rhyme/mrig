# Local models: bring-up, trials and results

Companion to ROADMAP **L2**. The hardening half of L2 is in the code (Ollama context warning,
`toolMode: "minimal"`, empty-argument retry, see README "Notes on local models"). This file
holds the half that needs the M4 Pro: which models actually complete agent tasks. The machine
has 24 GB today and goes to 64 GB soon, so there are two waves of candidates.

## Runtime

Ollama or LM Studio; both support tool calling. Not `mlx_lm.server` for the agent (no tool
calling, "not recommended for production"); MLX stays for fine-tuning.

```sh
OLLAMA_CONTEXT_LENGTH=65536 ollama serve        # agents need ≥32k; the default is 4,096
ollama pull <model>
mrig doctor -P ollama                           # model listed? context ≥32k?
```

Set the context to fit the memory budget: about 16–18 GB for models at 24 GB, 48–52 GB at
64 GB, leaving 6–8 GB for macOS and apps. Default to 64k context; use 128k where the model
supports it. At 64 GB the limit is speed, not memory: decode speed is roughly memory
bandwidth (about 273 GB/s) divided by the model's size in memory, so a 40 GB model tops out
near 7 tok/s while a mixture-of-experts model stays fast. These are estimates; the eval
harness records the real numbers. If a model only works with `toolMode: "minimal"`, say so
in the table.

## Trial task (the same for every model)

In a scratch copy of a small repo, one `mrig -P <profile>` session:

1. **read:** "What does `src/x.ts` export?" (expects a `read` call and a correct answer).
2. **edit:** "Rename function `a` to `b` in `src/x.ts` and update its one caller." (expects
   `read` then `edit`; check the diff).
3. **bash:** "Run the tests." (expects a `bash` call and a truthful summary of the output).

Pass = all three complete without a wrong answer, a hallucinated result, or more than one
retry per step. Note `/cost` for tokens, the `⚙` timings for tokens/s, and any `!` notices
(empty arguments, invalid calls).

## Results

| Model | Quant | Runtime | num_ctx | toolMode | read | edit | bash | tok/s | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Qwen3.5-9B | Q4 | Ollama | | full | | | | | |
| Qwen3.5-9B | Q6 | Ollama | | full | | | | | |
| Gemma 4 12B | Q4 | Ollama | | full | | | | | |
| Gemma 4 12B | Q6 | Ollama | | full | | | | | |
| Gemma 4 26B-A4B | Q4 | Ollama | | full | | | | | Tight fit at 24 GB |
| *Second wave, 64 GB:* | | | | | | | | | confirm tags on ollama.com first |
| Gemma 4 26B-A4B | Q8 | Ollama | | full | | | | | |
| Qwen3.5, largest dense variant | Q6 | Ollama | | full | | | | | |
| Gemma 4, largest dense variant | Q6 | Ollama | | full | | | | | |
| 70B-class model | Q4 | Ollama | | full | | | | | ceiling test; expect single-digit tok/s |

Fill a row per trial; copy a row for `toolMode: "minimal"` when the full set fails. When the
L3 harness lands, it runs this task list headless and writes the compatibility matrix for you;
pick the default `local` profile from that.
