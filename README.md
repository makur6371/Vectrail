![Vectrail](docs/banner.png)

# Vectrail

Fast, open-source **AI-native video editor for Windows**, built from the ground up with Electron, React, TypeScript, WebGL2, FFmpeg, Cloud AI planning, and a built-in 45-tool Model Context Protocol (MCP) server.

*Built by Makur · Inspired by [robbietilton/Editroom](https://github.com/robbietilton/Editroom) for macOS.*

## Features

- **Real-time WebGL2 Preview & Direct Canvas Gizmo**: Multi-track compositing, 11 built-in 3D LUT looks + `.cube` LUT import, exposure/contrast/saturation/temperature/tint/lift-gamma-gain color wheels, smooth zoom/pan curves, `dissolve`/`dipToBlack`/`wipe` transitions, fade curves, word-highlighted captions, and direct Viewer drag/scale handles with center-snap guides.
- **Media Library Hover Scrubbing & Source In/Out**: Move your cursor across any library video card to scrub frames live in the Viewer, or pin a source clip to mark `I`/`O` subclip ranges before inserting.
- **Resizable Pro Workspace**: Drag panel splitters between Library, Viewer, Inspector, and Timeline (saved automatically) with four built-in palettes (`Dark`, `Grey`, `Amber`, `Light`).
- **Universal Format Support**: Native `vectrail-media://` byte-range streaming plus automatic background FFmpeg playable proxy/remuxing for `.mkv`, `.mxf`, `.avi`, and `.mov` (HEVC/ProRes/PCM) files while exporting directly from original sources.
- **Non-linear Multi-track Timeline**: Video (`V1`, `V2`, ...) and audio (`A1`, `A2`, ...) tracks, continuous filmstrip tiling, linked pairs, snapping, right-click clip context menu, marker tint/rename popover, ripple delete (`Shift+Delete`), split (`S`), `J`/`K`/`L` shuttle with rate badge, freeze frame, piecewise speed ramps, reverse playback, track ducking, editable shortcuts, and undo/redo (`Ctrl+Z` / `Ctrl+Shift+Z`).
- **Local Whisper Transcription & Scene Tags**: Built-in `whisper.cpp` speech transcription via FFmpeg (`ggml-tiny`/`ggml-base` download in Settings) and automatic visual scene tagging (`bright`, `night`, `action`, `people`, `vivid`, `sharp`) for instant media search.
- **Magic AI Bar (Cloud OpenAI-Compatible API + Codex/Claude + 45-Tool MCP)**: Floating Magic popover with `@` mention autocomplete, live execution steps, one-click undo, configurable **OpenAI-compatible Cloud AI** (`Base URL`, `API Key`, `Model`), and local HTTP/stdio MCP server (`127.0.0.1:47920/mcp`, port file at `%APPDATA%\Vectrail\Runtime\mcp-port.json`).
- **FFmpeg Export Engine**: Hardware-probed H.264/HEVC MP4 (NVENC / QSV / AMF with `libx264` / `libx265` fallback), Lanczos + Contrast Adaptive Sharpen (`cas`) detail enhancement on upscales, audio-only WAV, aspect ratio presets (`16:9`, `9:16`, `1:1`, `4:5`), EBU R128 loudness normalization, `.cube` LUT bake, and caption burn-in.

## Prerequisites

- **Windows 10 / 11 (x64)**
- **Node.js 20+** (for building from source)
- **FFmpeg & FFprobe** on `PATH` (for example `winget install Gyan.FFmpeg`, or placed under `resources/ffmpeg/ffmpeg.exe`)

## AI Agent Integration (MCP & Cloud AI)

1. Launch Vectrail and open **Settings**.
2. For **Cloud AI** inside the Magic popover, enter any OpenAI-compatible `Base URL`, `API Key`, and `Model` and click **Test**.
3. For external coding/editing agents, click **Connect** under **AI Agents & MCP Server** for **Codex** (`%USERPROFILE%\.codex\config.toml`), **Claude Code**, or **Claude Desktop** to register the `vectrail` stdio MCP server automatically.

If you run the Portable executable, Vectrail copies the bridge script to `%APPDATA%\Vectrail\Runtime\vectrail-mcp-bridge.js` so agent configs stay valid across launches.

## Development & Testing

```powershell
npm install
npm run typecheck
npm test
npm start
```

## Packaging for Windows

```powershell
npm run dist:win
```

If GitHub is unavailable or you want to reuse the Electron runtime already installed by `npm install`:

```powershell
npm run dist:win:offline
```

Outputs are generated in `release/`:
- `Vectrail Setup 1.0.0.exe` (NSIS installer)
- `Vectrail-Windows-Portable-1.0.0-x64.exe` (single-file portable executable)
- `win-unpacked/Vectrail.exe`

## Live QA

With Vectrail running and fixtures present in `%TEMP%\vectrail-live-test`, import the fixtures, build a beat-synced cut, apply a color grade, seek, inspect the playhead frame, and save:

```powershell
npm run qa:live
```

## Architecture

- `src/main/` — Electron main process, `vectrail-media://` protocol handler, FFmpeg analyzer/exporter/proxy pipeline, Cloud AI & Magic agent connector, and MCP HTTP + stdio server (`45` tools).
- `src/renderer/` — React + Tailwind UI, WebGL2 color-grading compositor, Web Audio mixer, timeline, inspector, library, and modals.
- `src/shared/` — Cross-process project model, 3D `.cube` LUT parser & baker, caption layout, speed ramp math, beat-cut planner, themes, and shortcuts.
- `tests/` — Unit tests and end-to-end MCP + real FFmpeg pipeline tests (`vitest`).

## Attribution & License

MIT License — see [LICENSE](LICENSE).
Built by Makur. Inspired by [robbietilton/Editroom](https://github.com/robbietilton/Editroom) for macOS.
