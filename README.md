# Editroom for Windows

Fast, open-source AI-native video editor for Windows — an authoritative Windows adaptation of [robbietilton/Editroom](https://github.com/robbietilton/Editroom), built with Electron, React, TypeScript, WebGL2, FFmpeg, and a built-in Model Context Protocol (MCP) server.

## Features

- **Real-time WebGL2 Preview**: Multi-track compositing, 11 built-in 3D LUT looks + `.cube` LUT import, exposure/contrast/saturation/temperature/tint/lift-gamma-gain color wheels, smooth zoom/pan curves, `dissolve`/`dipToBlack`/`wipe` transitions, fade curves, and word-highlighted caption preview.
- **Universal Format Support**: Native `editroom-media://` byte-range streaming plus automatic background FFmpeg playable proxy/remuxing for `.mkv`, `.mxf`, `.avi`, and `.mov` (HEVC/ProRes/PCM) files while exporting directly from original sources.
- **Non-linear Multi-track Timeline**: Video tracks (`V1`, `V2`, ...) and audio tracks (`A1`, `A2`, ...), linked audio/video pairs, library drag-and-drop, snapping, ripple delete (`Shift+Delete`), split (`S`), `J`/`K`/`L` shuttle, `I`/`O` In/Out range, freeze frame, speed & piecewise speed ramps, reverse playback, track ducking (`duck_under`/`duck_db`), editable shortcuts, and undo/redo (`Ctrl+Z` / `Ctrl+Shift+Z`).
- **Local Whisper Transcription & Scene Tags**: Built-in `whisper.cpp` speech transcription via FFmpeg (`ggml-tiny`/`ggml-base` download in Settings) and automatic visual scene tagging (`bright`, `night`, `action`, `people`, `vivid`, `sharp`) for instant media search.
- **AI-Native MCP Server (45 tools) & Magic Bar**: Built-in local HTTP MCP server (`127.0.0.1:47920/mcp` with dynamic port discovery via `%APPDATA%\EditroomWindows\Runtime\mcp-port.json`) plus standalone stdio bridge (`dist-electron/main/mcp/bridge.js`) for **Codex CLI**, **Claude Code**, and **Claude Desktop**. Supports `@asset` / `@clip` / `@playhead` mentions, live agent cursor feedback, `look_at_media` contact sheets, `analyze_media`, `transcribe_media`, `auto_edit`, and background `export`.
- **FFmpeg Export Engine**: Hardware-probed H.264/HEVC MP4 (NVENC / QSV / AMF with automatic `libx264` / `libx265` fallback), audio-only WAV, aspect ratio presets (`16:9`, `9:16 Reels`, `1:1 Square`, `4:5 Portrait`), EBU R128 loudness normalization, 3D LUT `.cube` bake, speed ramps, and caption burn-in.

## Prerequisites

- **Windows 10 / 11 (x64)**
- **Node.js 20+** (for building from source)
- **FFmpeg & FFprobe** on `PATH` (for example `winget install Gyan.FFmpeg`, or placed under `resources/ffmpeg/ffmpeg.exe`)

## AI Agent Integration (MCP)

1. Launch Editroom and open **Settings → AI Agents**.
2. Click **Connect** for **Codex** (`%USERPROFILE%\.codex\config.toml`), **Claude Code**, or **Claude Desktop** to write the `editroom` stdio MCP server entry automatically.
3. You can also use the in-app **Magic** prompt bar (`codex` / `claude` CLI integration) with `@` mentions for assets, clips, and playhead context.

If you run the Portable executable, Editroom writes the bridge script to `%APPDATA%\EditroomWindows\Runtime\mcp-bridge.js` so agent configs remain valid across temporary extraction directories.

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
- `Editroom Setup 1.0.0.exe` (NSIS installer)
- `Editroom-Windows-Portable-1.0.0-x64.exe` (single-file portable executable)
- `win-unpacked/Editroom.exe`

## Live QA

With Editroom running and fixtures present in `%TEMP%\editroom-live-test`, import the fixtures, build a beat-synced cut, apply a color grade, seek, inspect the playhead frame, and save:

```powershell
npm run qa:live
```

## Architecture

- `src/main/` — Electron main process, `editroom-media://` protocol handler, FFmpeg analyzer/exporter/proxy pipeline, Magic agent connector, and MCP HTTP + stdio server (`45` tools).
- `src/renderer/` — React + Tailwind UI, WebGL2 color-grading compositor, Web Audio mixer, timeline, inspector, library, and modals.
- `src/shared/` — Cross-process project model, 3D `.cube` LUT parser & baker, caption layout, speed ramp math, beat-cut planner, themes, and shortcuts.
- `tests/` — Unit tests and end-to-end MCP + real FFmpeg pipeline tests (`vitest`).

## Attribution & License

MIT License — see [LICENSE](LICENSE).
Inspired by and adapted for Windows from [robbietilton/Editroom](https://github.com/robbietilton/Editroom).
