# Vendored DTK protocol core

This directory contains a trimmed subset of the pure-Python protocol core from
[Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)
by Evil0ctal, licensed under the Apache License 2.0 (see `LICENSE`).

What is vendored here:

- `platforms/douyin` — Douyin endpoint tables, request parameters, response parsing.
- `platforms/tiktok` — TikTok endpoint tables, request parameters, response parsing.
- `signing/native` — pure-Python `a_bogus`, `x-secsdk-web-signature`,
  `X-Dynosaur` / `X-Gnarly` implementations and guest token helpers.
- `urls` — URL recognition, canonicalization, and short-link expansion.
- `core`, `models`, `platforms/base` — shared value types and helpers.

What was changed relative to upstream:

- Package `__init__.py` files were trimmed so importing a submodule does not pull
  in the upstream service stack (FastAPI, Redis, SQLAlchemy, browser-rpc, ...).
- Modules outside the list above were not copied.

The signing implementations are upstream's own clean-room work: the Douyin
`a_bogus` and `x-secsdk-web-signature` code and the TikTok `X-Dynosaur` /
`X-Gnarly` code were derived from the platforms' own JavaScript artifacts, not
from any third-party downloader.

Runtime Python requirements (`httpx`, `pydantic`, `pydantic-settings`,
`structlog`) are installed on demand into the Vectrail plugin cache directory
the first time the native route is used.
