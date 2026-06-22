# LLM Wiki Bridge

Obsidian desktop plugin that provides a thin UI for the local LLM-Wiki harness.

It runs the existing local commands instead of duplicating business logic:

- `~/.ai_harness/bin/wiki`
- `8000_DEV/8100_Super-Power/8140_llm-wiki-launcher/wiki-now.sh`

## What it does

- Safe check: `wiki-now.sh --safe`
- Full refine: `wiki-now.sh`
- Refine scan: `wiki refine-scan --agent codex-cli`
- One-shot: full refine + refine scan
- Progress modal with streamed stdout/stderr
- Confirm modal with journal count and refine limit

## Requirements

- Obsidian desktop
- Local vault layout compatible with `wiki-now.sh`
- `~/.ai_harness`
- `codex` CLI installed and logged in for refine generation

## Install (manual)

1. Copy `manifest.json`, `main.js`, `styles.css`, `versions.json`
2. Place them under:

```text
<your-vault>/.obsidian/plugins/llm-wiki-bridge/
```

3. Enable **LLM Wiki Bridge** in Obsidian community plugins

## Settings

- `Harness Root`: default `~/.ai_harness`
- `Refine Agent`: default `codex-cli`
- `Default Refine Limit`: default `3`
- `wiki-now.sh Relative Path`: default `8000_DEV/8100_Super-Power/8140_llm-wiki-launcher/wiki-now.sh`

## Commands

- `LLM Wiki Bridge: ③ 정제 안전 점검`
- `LLM Wiki Bridge: ③ 전체 정제`
- `LLM Wiki Bridge: ③ refine-scan 위키 생성`
- `LLM Wiki Bridge: ③ 전체 정제 + 위키 생성 (원샷)`

Ribbon icon:

- `book-open` -> one-shot

## Architecture

This plugin intentionally keeps the UI in Obsidian and the actual pipeline in the external harness.

Cause:
- The wiki workflow already exists in `bin/wiki` and `wiki-now.sh`.

Effect:
- The plugin stays thin, easier to maintain, and follows the single-source-of-truth approach.

## Release

Release tag must match `manifest.json` version exactly.

For `0.1.0`, upload these assets directly to the GitHub release:

- `manifest.json`
- `main.js`
- `styles.css`

## License

MIT
