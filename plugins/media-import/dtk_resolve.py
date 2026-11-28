"""Local Douyin / TikTok resolver for the Vectrail media link importer.

Uses the pure-Python signing core of the Apache-2.0 licensed
Douyin_TikTok_Download_API project (KonradIT-style reverse engineering):

* Douyin  - a_bogus plus x-secsdk-web-signature over a minted visitor jar.
* TikTok  - X-Dynosaur / X-Gnarly over the platform's own web API.

Both are computed locally; no third-party parsing service is contacted and
no browser is required. The host application supplies the ``dtk`` package
through PYTHONPATH.
"""

from __future__ import annotations

import json
import random
import sys
import uuid
from asyncio import run as asyncio_run

import httpx
from urllib.parse import urlencode

from dtk.platforms.douyin.endpoints import DEFAULT_HEADERS, DouyinAPIEndpoints
from dtk.platforms.douyin.params import base_params
from dtk.platforms.douyin.parser import parse_content
from dtk.platforms.tiktok.endpoints import TikTokAPIEndpoints
from dtk.platforms.tiktok.params import base_params as tiktok_base_params
from dtk.platforms.tiktok.parser import parse_content as parse_tiktok_content
from dtk.signing.native.abogus import ABogus
from dtk.signing.native.tiktok_sign import sign as tiktok_sign
from dtk.signing.native.tokens import gen_false_ms_token
from dtk.signing.native.websign import sign as douyin_sign
from dtk.urls.expand import RedirectFetcher, expand as expand_short_link
from dtk.urls.parse import first_url, identify

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
)


class HttpxRedirectFetcher(RedirectFetcher):
    def __init__(self, client: httpx.AsyncClient):
        self.client = client

    async def __call__(self, url: str) -> str | None:
        response = await self.client.get(url)
        return response.headers.get("location")


def check() -> None:
    try:
        import dtk.platforms.douyin.parser
        import dtk.platforms.tiktok.parser
        import dtk.signing.native.abogus
        import dtk.signing.native.tiktok_sign

        print(json.dumps({"ok": True, "version": "DTK-native-5.1.13"}))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))


async def mint_jar(client: httpx.AsyncClient):
    await client.post(
        "https://ttwid.bytedance.com/ttwid/union/register/",
        json={
            "region": "cn",
            "aid": 1768,
            "needFid": False,
            "service": "www.ixigua.com",
            "migrate_info": {"ticket": "", "source": "node"},
            "cbUrlProtocol": "https",
            "union": True,
        },
    )
    jar = {
        name: [cookie.value for cookie in client.cookies.jar if cookie.name == name][-1]
        for name in {cookie.name for cookie in client.cookies.jar}
    }
    uifid = uuid.uuid4().hex + uuid.uuid4().hex[:16]
    verify_fp = "verify_" + "".join(
        random.choice("0123456789abcdefghijklmnopqrstuvwxyz") for _ in range(32)
    )
    jar["uifid"] = uifid
    jar["UIFID_TEMP"] = uifid
    jar["s_v_web_id"] = verify_fp
    return jar, uifid, verify_fp


async def resolve_share_text(client: httpx.AsyncClient, text: str):
    url = first_url(text)
    if not url:
        raise ValueError("no URL in share text")
    kind = identify(url)
    if kind.needs_expansion and kind.url:
        final_url = await expand_short_link(kind.url, HttpxRedirectFetcher(client))
        kind = identify(final_url)
    platform = str(kind.platform).split(".")[-1]
    resource = str(kind.resource).split(".")[-1]
    if resource != "video":
        raise ValueError(f"unsupported DTK target: {kind.platform} {kind.resource}")
    return platform, str(kind.resource_id)


def streams_from_media(media, main_label: str) -> list:
    streams = []
    if media.video:
        streams.append(
            {
                "id": f"main-{media.video.height or 0}",
                "label": f"{media.video.height or 0}p {main_label}",
                "url": media.video.url,
                "height": media.video.height or 0,
                "width": media.video.width or 0,
                "size_bytes": media.video.size_bytes,
                "watermark": bool(media.video.watermark),
            }
        )
    for index, stream in enumerate(media.streams):
        streams.append(
            {
                "id": f"stream-{index}",
                "label": f"{stream.height or 0}p" + (" watermark" if stream.watermark else ""),
                "url": stream.url,
                "height": stream.height or 0,
                "width": stream.width or 0,
                "size_bytes": stream.size_bytes,
                "watermark": bool(stream.watermark),
            }
        )
    return streams


async def resolve_douyin(client: httpx.AsyncClient, aweme_id: str) -> dict:
    jar, uifid, verify_fp = await mint_jar(client)
    params = base_params()
    params["aweme_id"] = aweme_id
    params["msToken"] = gen_false_ms_token(126, rng=random.Random())
    params["verifyFp"] = verify_fp
    params["fp"] = verify_fp
    query = urlencode(params)
    signed = ABogus(UA).get_value(query)
    pairs = [tuple(pair.split("=", 1)) for pair in query.split("&") if "=" in pair]
    signed_query, _signature, web_headers = douyin_sign(pairs, uifid)
    url = f"{DouyinAPIEndpoints.POST_DETAIL}?{signed_query}"
    response = await client.get(url, headers={**DEFAULT_HEADERS, **web_headers}, cookies=jar)
    if response.status_code != 200:
        raise RuntimeError(f"Douyin HTTP {response.status_code}: {response.text[:160]}")
    payload = json.loads(response.content)
    if payload.get("status_code") != 0:
        raise RuntimeError(f"Douyin API status_code {payload.get('status_code')}")
    content = parse_content(payload, fetched_at=__import__("datetime").datetime.now())
    media = content.media
    return {
        "platform": "douyin",
        "id": aweme_id,
        "title": content.title,
        "author": content.author.nickname,
        "durationMs": content.duration_ms,
        "thumbnail": media.covers[0].url if media.covers else None,
        "formats": streams_from_media(media, "main"),
        "gallery": [image.url for image in media.images],
    }


async def resolve_tiktok(client: httpx.AsyncClient, item_id: str) -> dict:
    await client.post(
        "https://ttwid.bytedance.com/ttwid/union/register/",
        json={
            "region": "cn",
            "aid": 1768,
            "needFid": False,
            "service": "www.ixigua.com",
            "migrate_info": {"ticket": "", "source": "node"},
            "cbUrlProtocol": "https",
            "union": True,
        },
    )
    jar = {cookie.name: cookie.value for cookie in client.cookies.jar}
    params = tiktok_base_params()
    params["itemId"] = item_id
    signed_query, _added = tiktok_sign(list(params.items()), UA, ms_token="", rng=random.Random())
    url = f"{TikTokAPIEndpoints.POST_DETAIL}?{signed_query}"
    response = await client.get(
        url,
        headers={
            "Referer": "https://www.tiktok.com/",
            "Origin": "https://www.tiktok.com",
            "Accept": "application/json, text/plain, */*",
        },
        cookies=jar,
    )
    if response.status_code != 200:
        raise RuntimeError(f"TikTok HTTP {response.status_code}: {response.text[:160]}")
    payload = json.loads(response.content)
    if not payload.get("itemInfo"):
        raise RuntimeError(f"TikTok API statusCode {payload.get('statusCode')}: item not viewable")
    content = parse_tiktok_content(payload, fetched_at=__import__("datetime").datetime.now())
    media = content.media
    return {
        "platform": "tiktok",
        "id": item_id,
        "title": content.title,
        "author": content.author.nickname,
        "durationMs": content.duration_ms,
        "thumbnail": media.covers[0].url if media.covers else None,
        "formats": streams_from_media(media, "main"),
        "gallery": [image.url for image in media.images],
    }


async def resolve_media(share_text: str) -> dict:
    async with httpx.AsyncClient(headers={"User-Agent": UA}) as client:
        platform, resource_id = await resolve_share_text(client, share_text)
        if platform == "tiktok":
            return await resolve_tiktok(client, resource_id)
        if platform == "douyin":
            return await resolve_douyin(client, resource_id)
        raise ValueError(f"unsupported DTK platform: {platform}")


def emit(payload) -> None:
    print(json.dumps(payload, ensure_ascii=False))


if len(sys.argv) > 1 and sys.argv[1] == "--check":
    check()
    sys.exit(0)

if len(sys.argv) > 2 and sys.argv[1] == "--resolve":
    try:
        emit({"ok": True, **asyncio_run(resolve_media(sys.argv[2]))})
    except Exception as exc:
        emit({"ok": False, "error": str(exc)})
    sys.exit(0)

text = sys.stdin.read()
try:
    emit({"ok": True, **asyncio_run(resolve_media(text))})
except Exception as exc:
    emit({"ok": False, "error": str(exc)})
