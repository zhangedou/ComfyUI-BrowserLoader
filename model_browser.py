import asyncio
import html
import json
import mimetypes
import os
import re
import shutil
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlencode

from aiohttp import ClientSession, ClientTimeout, web

import folder_paths
import nodes as comfy_nodes
from server import PromptServer


MODEL_KINDS = {
    "unet": {"folder_key": "diffusion_models", "label": "UNET"},
    "checkpoint": {"folder_key": "checkpoints", "label": "Checkpoint"},
    "lora": {"folder_key": "loras", "label": "LoRA"},
}

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
MAX_CIVITAI_IMAGES = 200
CIVITAI_HOSTS = {"civitai.com", "www.civitai.com", "civitai.red", "www.civitai.red", "civitai.green", "www.civitai.green"}
INFO_FORMAT = "ComfyUI-BrowserLoader model info v1"
COMMON_LOCAL_PROXY_PORTS = (7890, 7897, 7891, 10809, 10808, 1080, 8080)


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _settings_path() -> Path:
    """Persistent BrowserLoader settings path.

    Prefer ComfyUI's user directory so replacing/updating this custom node does
    not delete the user's proxy configuration. Fall back to the plugin folder
    on older ComfyUI builds that do not expose get_user_directory().
    """
    try:
        getter = getattr(folder_paths, "get_user_directory", None)
        user_dir = getter() if callable(getter) else None
    except Exception:
        user_dir = None
    if user_dir:
        root = Path(user_dir) / "ComfyUI-BrowserLoader"
    else:
        root = Path(__file__).resolve().parent
    root.mkdir(parents=True, exist_ok=True)
    return root / "settings.json"


def _read_settings() -> dict:
    path = _settings_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_settings(data: dict):
    path = _settings_path()
    payload = dict(data or {})
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _normalize_proxy_url(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if "://" not in raw:
        # Local proxy software usually exposes an HTTP CONNECT port. Let users
        # type the common shorthand 127.0.0.1:7890.
        raw = "http://" + raw
    parsed = urlparse(raw)
    if parsed.scheme.casefold() not in {"http", "https"}:
        raise ValueError("当前内置代理支持 HTTP/HTTPS 代理，例如 http://127.0.0.1:7890。")
    if not parsed.hostname or parsed.port is None:
        raise ValueError("代理地址格式无效，例如：http://127.0.0.1:7890")
    return raw


def _system_proxy_candidates():
    """Return environment / operating-system proxy candidates.

    urllib.request.getproxies() reads HTTP(S)_PROXY environment variables and,
    on Windows/macOS, the system proxy configuration as well. This makes the
    extension work with Clash/V2Ray/Surge-style local HTTP proxy ports without
    hard-coding a launcher-specific setup.
    """
    result = []
    explicit_env = (os.getenv("CIVITAI_PROXY") or "").strip()
    if explicit_env:
        try:
            result.append(("CIVITAI_PROXY", _normalize_proxy_url(explicit_env)))
        except Exception:
            pass
    try:
        proxies = urllib.request.getproxies() or {}
    except Exception:
        proxies = {}
    for key in ("https", "http", "all"):
        value = proxies.get(key)
        if not value:
            continue
        try:
            normalized = _normalize_proxy_url(value)
        except Exception:
            continue
        if all(normalized != item[1] for item in result):
            result.append((f"system:{key}", normalized))
    return result


async def _tcp_port_open(host: str, port: int, timeout: float = 0.22) -> bool:
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return True
    except Exception:
        return False


async def _detect_local_proxy() -> tuple[str, str]:
    """Choose the proxy to use for Civitai requests.

    Priority: BrowserLoader saved proxy -> CIVITAI_PROXY/system proxy -> common
    localhost HTTP proxy ports -> direct connection. Common ports are only
    selected when a TCP listener is actually present, so normal users are not
    forced through a guessed proxy.
    """
    settings = _read_settings()
    saved = str(settings.get("proxy_url") or "").strip()
    if saved:
        try:
            return "saved", _normalize_proxy_url(saved)
        except Exception:
            pass

    candidates = _system_proxy_candidates()
    if candidates:
        return candidates[0]

    for host in ("127.0.0.1", "localhost"):
        for port in COMMON_LOCAL_PROXY_PORTS:
            if await _tcp_port_open(host, port):
                return f"auto:{host}:{port}", f"http://{host}:{port}"
    return "direct", ""


def _proxy_display(proxy_url: str, source: str = "") -> str:
    if proxy_url:
        return f"{proxy_url} ({source or 'proxy'})"
    return "直连"


def _normalize_rel(value: str) -> str:
    return str(value or "").replace("\\", "/").strip("/")


def _model_config(kind: str):
    cfg = MODEL_KINDS.get(kind)
    if not cfg:
        raise ValueError(f"Unsupported model kind: {kind}")
    return cfg


def _model_path(kind: str, name: str) -> str:
    cfg = _model_config(kind)
    # Use ComfyUI's own model path resolver so extra_model_paths.yaml continues
    # to work and arbitrary filesystem paths cannot be supplied through the API.
    full = folder_paths.get_full_path_or_raise(cfg["folder_key"], name)
    full = os.path.realpath(full)
    if not os.path.isfile(full):
        raise FileNotFoundError(f"Model file does not exist: {name}")
    return full


def _info_path(model_path: str) -> str:
    return str(Path(model_path).with_suffix(".txt"))


def _preview_dir(model_path: str) -> str:
    p = Path(model_path)
    return str(p.parent / f"{p.stem}-Preview")


def _default_info(model_path: str, kind: str, name: str):
    return {
        "_format": INFO_FORMAT,
        "kind": kind,
        "model_file": os.path.basename(model_path),
        "model_name": Path(model_path).stem,
        "relative_name": name,
        "url": "",
        "version": "",
        "model_id": None,
        "model_version_id": None,
        "details": {},
        "user_note": "",
        "previews": [],
        "updated_at": "",
    }


def _read_info(model_path: str, kind: str, name: str):
    info = _default_info(model_path, kind, name)
    path = _info_path(model_path)
    if not os.path.isfile(path):
        return info
    try:
        text = Path(path).read_text(encoding="utf-8-sig")
    except Exception:
        return info
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            info.update(data)
            info["_format"] = INFO_FORMAT
            info["kind"] = kind
            info["relative_name"] = name
            return info
    except Exception:
        # Preserve a pre-existing plain-text annotation instead of overwriting it.
        info["user_note"] = text
    return info


def _write_info(model_path: str, info: dict):
    path = _info_path(model_path)
    info = dict(info)
    info["_format"] = INFO_FORMAT
    info["updated_at"] = _now_iso()
    tmp = path + ".tmp"
    Path(tmp).write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _cover_candidates(model_path: str):
    p = Path(model_path)
    # Favour the cover generated by this extension, then common sidecar naming.
    bases = [f"{p.stem}.preview", p.stem, f"{p.name}.preview", p.name]
    for base in bases:
        for ext in (".png", ".jpg", ".jpeg", ".webp"):
            yield p.parent / f"{base}{ext}"


def _find_cover(model_path: str):
    for candidate in _cover_candidates(model_path):
        if candidate.is_file():
            return str(candidate)

    # Case-insensitive fallback, useful on Windows when older helpers created
    # sidecars with different extension casing.
    p = Path(model_path)
    try:
        entries = list(p.parent.iterdir())
    except OSError:
        entries = []
    stem = p.stem.casefold()
    ranked = []
    for entry in entries:
        if not entry.is_file() or entry.suffix.casefold() not in IMAGE_EXTENSIONS:
            continue
        n = entry.name.casefold()
        if n.startswith(stem + ".preview"):
            ranked.append((0, entry))
        elif entry.stem.casefold() == stem:
            ranked.append((1, entry))
    if ranked:
        ranked.sort(key=lambda t: (t[0], t[1].name.casefold()))
        return str(ranked[0][1])

    # If information has already been fetched but no sidecar cover exists, use
    # the first image inside <model>-Preview.
    preview_dir = Path(_preview_dir(model_path))
    if preview_dir.is_dir():
        images = sorted(
            (x for x in preview_dir.iterdir() if x.is_file() and x.suffix.casefold() in IMAGE_EXTENSIONS),
            key=lambda x: x.name.casefold(),
        )
        if images:
            return str(images[0])
    return None


def _strip_html(value):
    if value is None:
        return ""
    text = str(value)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).strip()


def _canonical_civitai_page_url(url: str) -> str:
    """Map Civitai mirror/safety domains to the canonical .com page URL.

    The model/version IDs are shared across Civitai domains.  Fetching public
    API metadata from civitai.com is more reliable than trying to scrape the
    mirror page itself, while the user's original URL is still preserved in
    the sidecar metadata file.
    """
    parsed = urlparse(str(url or '').strip())
    host = (parsed.hostname or '').casefold()
    if host in CIVITAI_HOSTS and host not in {"civitai.com", "www.civitai.com"}:
        port = f":{parsed.port}" if parsed.port else ""
        return parsed._replace(netloc=f"civitai.com{port}").geturl()
    return str(url or '').strip()


def _parse_civitai_url(url: str):
    raw_url = url.strip()
    parsed = urlparse(raw_url)
    host = (parsed.hostname or "").casefold()
    if host not in CIVITAI_HOSTS:
        raise ValueError("“获取信息”目前支持 Civitai 模型网址（civitai.com / civitai.red / civitai.green）。")
    match = re.search(r"/models/(\d+)", parsed.path)
    model_id = int(match.group(1)) if match else None
    qs = parse_qs(parsed.query)
    version_id = None
    raw = (qs.get("modelVersionId") or qs.get("modelversionid") or [None])[0]
    if raw and str(raw).isdigit():
        version_id = int(raw)
    if version_id is None:
        # Be tolerant of copied/encoded URLs and newer route formats.
        version_match = re.search(r"modelVersionId(?:=|%3[dD])(\d+)", raw_url, flags=re.I)
        if version_match:
            version_id = int(version_match.group(1))
    if version_id is None:
        version_match = re.search(r"/model-versions/(\d+)", parsed.path, flags=re.I)
        if version_match:
            version_id = int(version_match.group(1))
    if model_id is None and version_id is None:
        raise ValueError("无法从网址识别 Civitai modelId / modelVersionId。")
    return model_id, version_id


async def _get_json(session: ClientSession, url: str, proxy_url: str = ""):
    kwargs = {"proxy": proxy_url} if proxy_url else {}
    async with session.get(url, headers={"Accept": "application/json"}, **kwargs) as response:
        if response.status >= 400:
            body = await response.text()
            raise RuntimeError(f"Civitai API HTTP {response.status}: {body[:240]}")
        return await response.json(content_type=None)


async def _get_all_civitai_images(
    session: ClientSession,
    version_id: int,
    proxy_url: str = "",
    model_id: int | None = None,
    username: str = "",
    target_keys: set[str] | None = None,
    max_items: int = MAX_CIVITAI_IMAGES,
):
    """Read Civitai's image API with its current cursor pagination.

    Civitai switched the images endpoint to cursor pagination.  Recent responses
    may expose ``metadata.nextCursor`` even when ``nextPage``/page counters are
    absent or stale.  v7 only followed the old page metadata, which is why a
    model page showing 20 showcase images could stop after the first 10.

    ``target_keys`` lets the caller use the broad image API only to enrich the
    exact showcase images returned by ``/api/v1/models/{modelId}``, preventing
    unrelated community generations from being added to the model's local
    showcase folder.
    """
    collected = []
    seen = set()
    target_keys = set(target_keys or [])
    max_pages = 80
    page_limit = min(200, max(1, int(max_items or MAX_CIVITAI_IMAGES)))

    def image_key(image):
        return _image_identity(image)

    async def fetch_pass(nsfw_value=None):
        params = {
            "modelVersionId": int(version_id),
            "limit": page_limit,
            "sort": "Newest",
            "period": "AllTime",
            # Civitai's current /api/v1/images endpoint omits generation
            # metadata unless it is explicitly requested.  The first 10
            # showcase images may appear to have metadata only because
            # /api/v1/model-versions/{id} embeds a richer 10-image subset;
            # the additional showcase images from /api/v1/models/{id}
            # otherwise end up with only width/height.  These two flags are
            # the same ones used by Civitai's official CLI for full image
            # detail and make Prompt/seed/sampler/CFG/resources available for
            # every showcase image whose uploader has not hidden metadata.
            "withMeta": "true",
            "flatMeta": "true",
        }
        if model_id is not None:
            params["modelId"] = int(model_id)
        if username:
            params["username"] = username
        if nsfw_value is not None:
            params["nsfw"] = nsfw_value

        cursor = None
        page = 1
        seen_cursors = set()
        next_url = ""

        for _ in range(max_pages):
            if next_url:
                request_url = next_url
            else:
                call_params = dict(params)
                if cursor is not None:
                    call_params["cursor"] = cursor
                elif page > 1:
                    call_params["page"] = page
                request_url = "https://civitai.com/api/v1/images?" + urlencode(call_params)

            payload = await _get_json(session, request_url, proxy_url)
            items = payload.get("items") or []
            if not isinstance(items, list):
                items = []

            for image in items:
                if not isinstance(image, dict) or not image.get("url"):
                    continue
                key = image_key(image)
                # When an exact showcase set is known, ignore community images.
                if target_keys and key not in target_keys:
                    continue
                if key in seen:
                    continue
                seen.add(key)
                collected.append(image)
                if target_keys and target_keys.issubset(seen):
                    return True
                if not target_keys and len(collected) >= max_items:
                    return True

            metadata = payload.get("metadata") or {}

            # Current Civitai image API: cursor is authoritative.
            next_cursor = metadata.get("nextCursor")
            if next_cursor in (None, ""):
                next_cursor = metadata.get("next_cursor")
            if next_cursor not in (None, ""):
                cursor_key = str(next_cursor)
                if cursor_key in seen_cursors:
                    break
                seen_cursors.add(cursor_key)
                cursor = next_cursor
                next_url = ""
                page = 1
                continue

            # Compatibility with older deployments that still return nextPage.
            candidate = metadata.get("nextPage")
            if candidate:
                candidate = str(candidate)
                if candidate.startswith("http://civitai.com/"):
                    candidate = "https://civitai.com/" + candidate[len("http://civitai.com/"):]
                if candidate == request_url:
                    break
                next_url = candidate
                cursor = None
                continue

            try:
                current_page = int(metadata.get("currentPage") or page)
                total_pages = int(metadata.get("totalPages") or current_page)
            except Exception:
                current_page, total_pages = page, page
            if current_page < total_pages:
                page = current_page + 1
                cursor = None
                next_url = ""
                continue
            break
        return False

    # Undefined nsfw is documented as all browsing levels.  Keep one legacy
    # mature pass only when targets are still missing; duplicates are removed.
    if await fetch_pass(None):
        return collected
    if target_keys and target_keys.issubset(seen):
        return collected
    try:
        await fetch_pass("true")
    except Exception:
        pass
    return collected


async def _resolve_civitai_page_version(session: ClientSession, source_url: str, proxy_url: str = ""):
    """Best-effort extraction of the version actually selected on a Civitai page.

    Some copied Civitai links omit modelVersionId even though the page resolves to
    a concrete version.  Prefer the final URL/canonical URL before falling back to
    embedded page data.  Failure is intentionally non-fatal: the caller can still
    match the local model filename against the public model API.
    """
    try:
        kwargs = {"proxy": proxy_url} if proxy_url else {}
        async with session.get(
            source_url,
            allow_redirects=True,
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Referer": "https://civitai.com/",
            },
            **kwargs,
        ) as response:
            if response.status >= 400:
                return None, str(response.url)
            final_url = str(response.url)
            try:
                _, final_version = _parse_civitai_url(final_url)
                if final_version:
                    return final_version, final_url
            except Exception:
                pass

            # Keep the page read bounded.  This is only a resolver, not a scraper.
            text = await response.text(errors="ignore")
            if len(text) > 8_000_000:
                text = text[:8_000_000]

            # Canonical/og:url generally points at the version represented by the
            # currently opened page and is safer than taking an arbitrary ID from
            # the application payload.
            url_patterns = [
                r'<link[^>]+rel=["\']canonical["\'][^>]+href=["\']([^"\']+)["\']',
                r'<meta[^>]+property=["\']og:url["\'][^>]+content=["\']([^"\']+)["\']',
            ]
            for pattern in url_patterns:
                m = re.search(pattern, text, flags=re.I)
                if not m:
                    continue
                candidate = html.unescape(m.group(1))
                try:
                    _, resolved = _parse_civitai_url(candidate)
                    if resolved:
                        return resolved, final_url
                except Exception:
                    continue

            # Last-resort embedded application data.  These patterns are kept
            # deliberately specific to avoid mistaking image/resource IDs for a
            # model-version ID.
            embedded_patterns = [
                r'"modelVersionId"\s*:\s*(\d+)',
                r'&quot;modelVersionId&quot;\s*:\s*(\d+)',
                r'modelVersionId%22%3A(\d+)',
            ]
            for pattern in embedded_patterns:
                m = re.search(pattern, text, flags=re.I)
                if m:
                    return int(m.group(1)), final_url
            return None, final_url
    except Exception:
        return None, source_url


def _pick_version(model_data: dict, requested_version_id, local_filename: str):
    versions = model_data.get("modelVersions") or []
    if requested_version_id is not None:
        for v in versions:
            if v.get("id") == requested_version_id:
                return v
    local_cf = os.path.basename(local_filename).casefold()
    for v in versions:
        for f in v.get("files") or []:
            if os.path.basename(str(f.get("name") or "")).casefold() == local_cf:
                return v
    return versions[0] if versions else None


def _version_from_parent_model(model_data: dict, version_id):
    if version_id is None:
        return None
    for version in model_data.get("modelVersions") or []:
        try:
            if int(version.get("id")) == int(version_id):
                return version
        except Exception:
            continue
    return None


def _image_identity(image: dict) -> str:
    """Return a stable key across Civitai's differently transformed image URLs.

    The parent model endpoint intentionally removes the image id and rewrites the
    image URL to an ``original=true`` edge URL, while /api/v1/images commonly
    returns a resized URL for the same underlying media.  Both forms retain the
    underlying UUID path segment, so prefer that *even when an image id exists*.
    This makes parent-model showcase entries and image-API metadata entries merge
    into the same record instead of becoming duplicate 20+10 records.
    """
    url = str(image.get("url") or "").strip()
    # Civitai image URLs normally contain a UUID identifying the source media.
    match = re.search(
        r"(?i)([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})",
        url,
    )
    if match:
        return f"asset:{match.group(1).lower()}"
    # Some older media URLs use a long opaque asset segment instead of a UUID.
    try:
        parts = [x for x in urlparse(url).path.split("/") if x]
        for part in parts:
            if len(part) >= 24 and re.fullmatch(r"[A-Za-z0-9_-]+", part):
                return f"asset:{part}"
    except Exception:
        pass
    if image.get("id") is not None:
        return f"id:{image.get('id')}"
    return f"url:{url}"


def _merge_image_groups(*groups):
    """Merge image payloads without changing showcase order.

    The public model endpoint carries the exact website showcase order (up to
    20 images), while the exact version endpoint / image endpoint can carry
    richer ``meta`` fields.  Start with the website showcase and enrich matching
    entries in place rather than appending unrelated community images.
    """
    merged = {}
    order = []
    for group in groups:
        for image in group or []:
            if not isinstance(image, dict) or not image.get("url"):
                continue
            key = _image_identity(image)
            if key not in merged:
                merged[key] = dict(image)
                order.append(key)
            else:
                current = merged[key]
                for k, v in image.items():
                    if v in (None, "", [], {}):
                        continue
                    # Keep the first (parent showcase) URL: /api/v1/models uses
                    # an original=true edge URL, while /api/v1/images may carry
                    # a resized URL. Later payloads enrich ids/meta/stats without
                    # downgrading the image that will actually be downloaded.
                    if k == "url" and current.get("url"):
                        continue
                    current[k] = v
    return [merged[key] for key in order]


def _metadata_is_useful(image: dict) -> bool:
    if not isinstance(image, dict):
        return False
    meta = image.get("meta") or {}
    if isinstance(meta, dict):
        for key in ("prompt", "Prompt", "negativePrompt", "Negative prompt", "negative_prompt", "sampler", "Sampler", "steps", "Steps", "seed", "Seed", "cfgScale", "CFG scale", "cfg", "CFG"):
            value = meta.get(key)
            if value not in (None, "", [], {}):
                return True
    resources = image.get("resources") or []
    return bool(resources)


def _looks_like_image_record(obj, image_id=None, asset_key: str = "") -> bool:
    if not isinstance(obj, dict):
        return False
    if image_id is not None:
        try:
            if int(obj.get("id")) == int(image_id):
                return True
        except Exception:
            pass
    if obj.get("url") and asset_key:
        try:
            return _image_identity(obj) == asset_key
        except Exception:
            return False
    return False


def _candidate_score(obj: dict) -> int:
    score = 0
    if not isinstance(obj, dict):
        return score
    if obj.get("meta") and isinstance(obj.get("meta"), dict):
        score += len([k for k, v in (obj.get("meta") or {}).items() if v not in (None, "", [], {})]) * 3
    if obj.get("resources"):
        score += len(obj.get("resources") or []) * 2
    if obj.get("stats"):
        score += 1
    if obj.get("width"):
        score += 1
    if obj.get("height"):
        score += 1
    return score


def _walk_json_candidates(root, image_id=None, asset_key: str = ""):
    candidates = []
    stack = [root]
    seen = set()
    while stack:
        obj = stack.pop()
        oid = id(obj)
        if oid in seen:
            continue
        seen.add(oid)
        if isinstance(obj, dict):
            if _looks_like_image_record(obj, image_id=image_id, asset_key=asset_key):
                candidates.append(obj)
            for value in obj.values():
                if isinstance(value, (dict, list)):
                    stack.append(value)
        elif isinstance(obj, list):
            for value in obj:
                if isinstance(value, (dict, list)):
                    stack.append(value)
    return sorted(candidates, key=_candidate_score, reverse=True)


def _parse_next_data_json(text: str):
    patterns = [
        r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
        r'<script[^>]+type=["\']application/json["\'][^>]*>(.*?)</script>',
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.I | re.S):
            raw = html.unescape((match.group(1) or '').strip())
            if not raw or raw[0] not in '{[':
                continue
            try:
                yield json.loads(raw)
            except Exception:
                continue


async def _scrape_civitai_image_page_meta(session: ClientSession, image: dict, proxy_url: str = "") -> dict:
    image_id = image.get("id")
    asset_key = _image_identity(image)
    candidates = []

    def add_candidate(obj):
        if isinstance(obj, dict):
            candidates.append(obj)

    # 1) Try the dedicated image page. Even when the public images API omits
    #    meta for some records, the page payload often still embeds the image
    #    object used by the website info panel.
    page_urls = []
    if image_id is not None:
        page_urls.append(f"https://civitai.com/images/{image_id}")

    kwargs = {"proxy": proxy_url} if proxy_url else {}
    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://civitai.com/",
    }

    for page_url in page_urls:
        if not page_url:
            continue
        try:
            async with session.get(page_url, allow_redirects=True, headers=headers, **kwargs) as response:
                if response.status >= 400:
                    continue
                text = await response.text(errors='ignore')
        except Exception:
            continue
        if len(text) > 12_000_000:
            text = text[:12_000_000]
        for root in _parse_next_data_json(text):
            for candidate in _walk_json_candidates(root, image_id=image_id, asset_key=asset_key):
                add_candidate(candidate)

        # 2) Best-effort raw regex fallback: some deployments inline the current
        #    image object outside __NEXT_DATA__. Search for the image UUID / id
        #    and an adjacent meta payload.
        try:
            uuid_match = re.search(r'asset:([^\s]+)', asset_key)
            uuid_part = uuid_match.group(1) if uuid_match else ''
        except Exception:
            uuid_part = ''
        snippets = []
        if image_id is not None:
            snippets.extend(re.finditer(r'\{[^{}]{0,200}"id"\s*:\s*%s[^{}]{0,4000}\}' % re.escape(str(image_id)), text, flags=re.S))
        if uuid_part:
            snippets.extend(re.finditer(r'\{[^{}]{0,500}%s[^{}]{0,5000}\}' % re.escape(uuid_part), text, flags=re.S | re.I))
        for match in snippets[:20]:
            raw = html.unescape(match.group(0))
            try:
                add_candidate(json.loads(raw))
            except Exception:
                continue

    if not candidates:
        return {}

    best = sorted(candidates, key=_candidate_score, reverse=True)[0]
    result = {}
    for key in ("id", "url", "width", "height", "nsfwLevel", "nsfw", "stats", "resources", "postId"):
        value = best.get(key)
        if value not in (None, "", [], {}):
            result[key] = value
    meta = best.get("meta") or {}
    if isinstance(meta, dict) and meta:
        result["meta"] = meta
    return result


async def _backfill_missing_showcase_metadata(session: ClientSession, images: list[dict], proxy_url: str = ""):
    if not images:
        return images, 0
    filled = 0
    for idx, image in enumerate(images):
        if _metadata_is_useful(image):
            continue
        try:
            fallback = await _scrape_civitai_image_page_meta(session, image, proxy_url)
        except Exception:
            fallback = {}
        if fallback:
            merged = _merge_image_groups([image], [fallback])
            if merged:
                improved = merged[0]
                if _metadata_is_useful(improved) and not _metadata_is_useful(image):
                    filled += 1
                images[idx] = improved
        if not _metadata_is_useful(images[idx]):
            # Preserve a human-readable reason for the UI when Civitai really
            # does not expose generation metadata for this image.
            images[idx]["meta_missing_reason"] = "Civitai 未公开该图片的完整生成信息，或公开 API / 页面数据未返回。"
    return images, filled


def _primary_file(version_data: dict):
    files = version_data.get("files") or []
    for f in files:
        if f.get("primary"):
            return f
    return files[0] if files else {}


def _detail_payload(model_data: dict, version_data: dict):
    primary = _primary_file(version_data)
    creator = model_data.get("creator") or {}
    return {
        "model_name": model_data.get("name") or (version_data.get("model") or {}).get("name") or "",
        "type": model_data.get("type") or (version_data.get("model") or {}).get("type") or "",
        "version_name": version_data.get("name") or "",
        "base_model": version_data.get("baseModel") or "",
        "base_model_type": version_data.get("baseModelType") or "",
        "trained_words": version_data.get("trainedWords") or [],
        "training_status": version_data.get("trainingStatus") or "",
        "training_details": version_data.get("trainingDetails") or {},
        "published": version_data.get("publishedAt") or version_data.get("createdAt") or "",
        "creator": creator.get("username") or "",
        "stats": model_data.get("stats") or {},
        "version_stats": version_data.get("stats") or {},
        "hashes": primary.get("hashes") or version_data.get("hashes") or {},
        "air": version_data.get("air") or "",
        "file_name": primary.get("name") or "",
        "file_metadata": primary.get("metadata") or {},
        "tags": model_data.get("tags") or [],
        "description": _strip_html(model_data.get("description")),
        "version_description": _strip_html(version_data.get("description")),
    }


def _safe_gallery_filename(value: str):
    name = os.path.basename(str(value or ""))
    if not name or name in {".", ".."}:
        raise ValueError("Invalid gallery filename")
    return name


def _extension_from_content_type(content_type: str, url: str):
    ctype = (content_type or "").split(";", 1)[0].strip().casefold()
    table = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }
    if ctype in table:
        return table[ctype]
    ext = Path(urlparse(url).path).suffix.casefold()
    if ext in IMAGE_EXTENSIONS:
        return ext
    guess = mimetypes.guess_extension(ctype) if ctype else None
    return guess if guess in IMAGE_EXTENSIONS else ".jpg"


async def _download_one_preview(session, semaphore, image, preview_dir: Path, index: int, proxy_url: str = ""):
    url = str(image.get("url") or "").strip()
    if not url.startswith(("https://", "http://")):
        return None
    image_id = image.get("id")
    id_part = re.sub(r"[^0-9A-Za-z_-]+", "_", str(image_id or index))

    async with semaphore:
        kwargs = {"proxy": proxy_url} if proxy_url else {}
        async with session.get(url, allow_redirects=True, **kwargs) as response:
            if response.status >= 400:
                return None
            data = await response.read()
            ext = _extension_from_content_type(response.headers.get("Content-Type", ""), str(response.url))

    filename = f"{index:03d}_{id_part}{ext}"
    image_path = preview_dir / filename
    image_path.write_bytes(data)

    metadata = {
        "source_url": url,
        "image_id": image_id,
        "width": image.get("width"),
        "height": image.get("height"),
        "nsfw_level": image.get("nsfwLevel"),
        "stats": image.get("stats") or {},
        "generation": image.get("meta") or {},
        "resources": image.get("resources") or [],
        "meta_missing_reason": image.get("meta_missing_reason") or "",
    }
    meta_name = f"{index:03d}_{id_part}.txt"
    (preview_dir / meta_name).write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"file": filename, "meta_file": meta_name, "meta": metadata}


async def _fetch_civitai(model_path: str, source_url: str):
    model_id, requested_version_id = _parse_civitai_url(source_url)
    proxy_source, proxy_url = await _detect_local_proxy()
    timeout = ClientTimeout(total=180, connect=30, sock_connect=30, sock_read=90)
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 ComfyUI-BrowserLoader/1.5",
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://civitai.com/",
    }
    # Optional support for private/mature resources without forcing credentials
    # into the node UI.  Users can set either environment variable before
    # launching ComfyUI; public models continue to work without a token.
    api_token = (os.getenv("CIVITAI_API_TOKEN") or os.getenv("CIVITAI_TOKEN") or "").strip()
    if api_token:
        headers["Authorization"] = f"Bearer {api_token}"

    # trust_env remains enabled for direct mode as a second compatibility path
    # for launchers that inject proxy variables after BrowserLoader starts.
    async with ClientSession(timeout=timeout, headers=headers, trust_env=not bool(proxy_url)) as session:
        version_data = None
        resolved_url = source_url

        if requested_version_id is None:
            page_version_id, resolved_url = await _resolve_civitai_page_version(session, _canonical_civitai_page_url(source_url), proxy_url)
            if page_version_id:
                requested_version_id = page_version_id

        version_fetch_error = None
        if requested_version_id is not None:
            try:
                version_data = await _get_json(session, f"https://civitai.com/api/v1/model-versions/{requested_version_id}", proxy_url)
                if model_id is None:
                    model_id = version_data.get("modelId") or (version_data.get("model") or {}).get("id")
            except Exception as exc:
                # Do not discard the whole request if one exact version endpoint
                # is unavailable.  When the URL also contains modelId we can still
                # read the parent model and match the requested/local version.
                version_fetch_error = str(exc)
                version_data = None

        if model_id is None:
            raise RuntimeError("Civitai 返回数据中缺少 modelId。")
        try:
            model_data = await _get_json(session, f"https://civitai.com/api/v1/models/{model_id}", proxy_url)
        except Exception as model_exc:
            # The exact model-version endpoint can still be available when the
            # parent model page is restricted/archived.  Keep the version data
            # usable instead of discarding everything.
            embedded_model = (version_data or {}).get("model") or {}
            if not version_data:
                raise RuntimeError(f"读取 Civitai 模型信息失败：{model_exc}") from model_exc
            model_data = {
                "id": model_id,
                "name": embedded_model.get("name") or "",
                "type": embedded_model.get("type") or "",
                "creator": embedded_model.get("creator") or {},
                "description": embedded_model.get("description") or "",
                "tags": embedded_model.get("tags") or [],
                "stats": embedded_model.get("stats") or {},
                "modelVersions": [version_data],
            }

        if version_data is None:
            version_data = _pick_version(model_data, requested_version_id, os.path.basename(model_path))
            if not version_data:
                raise RuntimeError("该 Civitai 模型没有可用版本。")
            version_id = version_data.get("id")
            if version_id:
                # The version endpoint contains richer fields such as AIR/hashes.
                try:
                    version_data = await _get_json(session, f"https://civitai.com/api/v1/model-versions/{version_id}", proxy_url)
                except Exception:
                    pass

        version_id = version_data.get("id")

        # IMPORTANT: Civitai's public /model-versions/{id} endpoint is hardcoded
        # to only 10 showcase images.  The public /models/{modelId} endpoint uses
        # Civitai's 20-image model-version showcase cache, which is also what the
        # website carousel uses.  Therefore the parent model endpoint is the
        # authoritative source for the exact showcase set/order.
        parent_version = _version_from_parent_model(model_data, version_id)
        parent_showcase = [
            x for x in ((parent_version or {}).get("images") or [])
            if isinstance(x, dict) and x.get("url")
        ]
        version_showcase = [
            x for x in (version_data.get("images") or [])
            if isinstance(x, dict) and x.get("url")
        ]
        images = _merge_image_groups(parent_showcase, version_showcase)
        showcase_source = "model_endpoint_20" if parent_showcase else "version_endpoint_10"

        # The 20-image parent-model payload may omit generation meta.  Enrich
        # only those exact showcase IDs through /api/v1/images.  The image API is
        # broader than the website showcase, so target filtering is intentional.
        # Current Civitai pagination is cursor-based; _get_all_civitai_images
        # follows metadata.nextCursor until all showcase IDs are found.
        enriched_count = 0
        if version_id and images:
            try:
                target_keys = {_image_identity(x) for x in images}
                creator_name = str((model_data.get("creator") or {}).get("username") or "").strip()
                enriched = await _get_all_civitai_images(
                    session,
                    int(version_id),
                    proxy_url,
                    model_id=int(model_id) if model_id is not None else None,
                    username=creator_name,
                    target_keys=target_keys,
                    max_items=max(20, len(target_keys)),
                )
                enriched_count = len(enriched)
                images = _merge_image_groups(images, enriched)
            except Exception as gallery_exc:
                if not version_fetch_error:
                    version_fetch_error = f"示例图生成信息补全失败：{gallery_exc}"

        scraped_meta_count = 0
        if images:
            try:
                images, scraped_meta_count = await _backfill_missing_showcase_metadata(session, images, proxy_url)
            except Exception as scrape_exc:
                if not version_fetch_error:
                    version_fetch_error = f"缺失示例图生成信息补抓失败：{scrape_exc}"

        # Rare fallback: if the parent model endpoint was unavailable/stripped
        # and only the 10-image version payload remains, query the creator-scoped
        # image API and take at most 20. This still avoids unrelated community
        # generations as much as the public API allows.
        if version_id and not parent_showcase and len(images) < 20:
            try:
                creator_name = str((model_data.get("creator") or {}).get("username") or "").strip()
                fallback_gallery = await _get_all_civitai_images(
                    session,
                    int(version_id),
                    proxy_url,
                    model_id=int(model_id) if model_id is not None else None,
                    username=creator_name,
                    max_items=20,
                )
                images = _merge_image_groups(images, fallback_gallery)[:20]
                if fallback_gallery:
                    showcase_source = "creator_image_api_fallback"
            except Exception as gallery_exc:
                if not version_fetch_error:
                    version_fetch_error = f"完整示例图库获取失败：{gallery_exc}"

        images = [x for x in images if isinstance(x, dict) and x.get("url")][:20]

        preview_dir = Path(_preview_dir(model_path))
        preview_dir.mkdir(parents=True, exist_ok=True)
        # Remove only files previously generated by BrowserLoader so a refreshed
        # 20-image gallery cannot leave stale numbered files from an older fetch.
        for old in preview_dir.iterdir():
            if old.is_file() and (re.match(r"^\d{3}_[^/]+\.(?:png|jpe?g|webp|gif|txt)$", old.name, flags=re.I) or old.name == "gallery.json"):
                try:
                    old.unlink()
                except OSError:
                    pass

        semaphore = asyncio.Semaphore(6)
        tasks = [
            _download_one_preview(session, semaphore, image, preview_dir, i + 1, proxy_url)
            for i, image in enumerate(images)
        ]
        downloaded = []
        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            downloaded = [x for x in results if isinstance(x, dict)]

    # First Civitai example image becomes the node cover.
    if downloaded:
        first = Path(_preview_dir(model_path)) / downloaded[0]["file"]
        p = Path(model_path)
        for old in p.parent.glob(f"{p.stem}.preview.*"):
            if old.is_file() and old.suffix.casefold() in IMAGE_EXTENSIONS:
                try:
                    old.unlink()
                except OSError:
                    pass
        cover = p.parent / f"{p.stem}.preview{first.suffix.casefold()}"
        shutil.copy2(first, cover)

    return {
        "model_id": model_id,
        "model_version_id": version_data.get("id"),
        "version": version_data.get("name") or "",
        "details": {
            **_detail_payload(model_data, version_data),
            "source_url": source_url,
            "resolved_url": resolved_url,
            "api_warning": version_fetch_error or "",
            "showcase_source": showcase_source,
            "showcase_count": len(images),
            "showcase_meta_enriched": enriched_count,
            "showcase_meta_page_backfilled": scraped_meta_count,
        },
        "previews": downloaded,
        "_network": {
            "proxy_url": proxy_url,
            "proxy_source": proxy_source,
            "display": _proxy_display(proxy_url, proxy_source),
        },
    }


@PromptServer.instance.routes.get("/browser_loader/network_settings")
async def browser_loader_network_settings(request):
    try:
        settings = _read_settings()
        source, effective = await _detect_local_proxy()
        return web.json_response({
            "proxy_url": str(settings.get("proxy_url") or ""),
            "effective_proxy": effective,
            "proxy_source": source,
            "display": _proxy_display(effective, source),
            "common_ports": list(COMMON_LOCAL_PROXY_PORTS),
        })
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/browser_loader/network_settings")
async def browser_loader_save_network_settings(request):
    try:
        data = await request.json()
        raw = str(data.get("proxy_url") or "").strip()
        normalized = _normalize_proxy_url(raw) if raw else ""
        settings = _read_settings()
        settings["proxy_url"] = normalized
        _write_settings(settings)
        source, effective = await _detect_local_proxy()
        return web.json_response({
            "ok": True,
            "proxy_url": normalized,
            "effective_proxy": effective,
            "proxy_source": source,
            "display": _proxy_display(effective, source),
        })
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/browser_loader/test_network")
async def browser_loader_test_network(request):
    try:
        source, proxy_url = await _detect_local_proxy()
        timeout = ClientTimeout(total=20, connect=8, sock_connect=8, sock_read=12)
        headers = {
            "User-Agent": "Mozilla/5.0 ComfyUI-BrowserLoader/1.5",
            "Accept": "application/json,text/plain,*/*",
        }
        async with ClientSession(timeout=timeout, headers=headers, trust_env=not bool(proxy_url)) as session:
            data = await _get_json(session, "https://civitai.com/api/v1/models?limit=1", proxy_url)
        return web.json_response({
            "ok": True,
            "display": _proxy_display(proxy_url, source),
            "proxy_url": proxy_url,
            "proxy_source": source,
            "reachable": bool(data),
        })
    except Exception as exc:
        source, proxy_url = await _detect_local_proxy()
        return web.json_response({
            "error": f"Civitai 连接测试失败：{exc}",
            "display": _proxy_display(proxy_url, source),
        }, status=400)


@PromptServer.instance.routes.get("/browser_loader/models")
async def browser_loader_models(request):
    kind = request.rel_url.query.get("kind", "")
    try:
        cfg = _model_config(kind)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)

    items = []
    try:
        names = folder_paths.get_filename_list(cfg["folder_key"])
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)

    for name in names:
        try:
            path = _model_path(kind, name)
            norm = _normalize_rel(name)
            folder = norm.rsplit("/", 1)[0] if "/" in norm else ""
            items.append(
                {
                    "name": name,
                    "display_name": os.path.basename(norm),
                    "path": norm,
                    "folder": folder,
                    "has_preview": bool(_find_cover(path)),
                    "has_info": os.path.isfile(_info_path(path)),
                }
            )
        except Exception:
            continue

    items.sort(key=lambda x: x["path"].casefold())
    return web.json_response({"kind": kind, "items": items, "count": len(items)})


@PromptServer.instance.routes.get("/browser_loader/cover")
async def browser_loader_cover(request):
    kind = request.rel_url.query.get("kind", "")
    name = request.rel_url.query.get("name", "")
    try:
        path = _model_path(kind, name)
        cover = _find_cover(path)
        if not cover:
            raise FileNotFoundError("No preview")
        return web.FileResponse(cover)
    except Exception as exc:
        return web.Response(text=str(exc), status=404)


@PromptServer.instance.routes.get("/browser_loader/preview")
async def browser_loader_preview(request):
    kind = request.rel_url.query.get("kind", "")
    name = request.rel_url.query.get("name", "")
    file_name = request.rel_url.query.get("file", "")
    try:
        model_path = _model_path(kind, name)
        safe_name = _safe_gallery_filename(file_name)
        root = Path(_preview_dir(model_path)).resolve()
        target = (root / safe_name).resolve()
        if target.parent != root or not target.is_file() or target.suffix.casefold() not in IMAGE_EXTENSIONS:
            raise FileNotFoundError("Preview not found")
        return web.FileResponse(str(target))
    except Exception as exc:
        return web.Response(text=str(exc), status=404)


@PromptServer.instance.routes.get("/browser_loader/detail")
async def browser_loader_detail(request):
    kind = request.rel_url.query.get("kind", "")
    name = request.rel_url.query.get("name", "")
    try:
        model_path = _model_path(kind, name)
        info = _read_info(model_path, kind, name)
        # Rehydrate preview metadata from per-image text files if the model info
        # file came from an older version or was manually edited.
        previews = []
        for item in info.get("previews") or []:
            if not isinstance(item, dict):
                continue
            file_name = item.get("file")
            if not file_name:
                continue
            meta = item.get("meta") or {}
            meta_file = item.get("meta_file")
            if meta_file:
                try:
                    raw = (Path(_preview_dir(model_path)) / _safe_gallery_filename(meta_file)).read_text(encoding="utf-8-sig")
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict):
                        meta = parsed
                except Exception:
                    pass
            previews.append({"file": file_name, "meta_file": meta_file, "meta": meta})
        info["previews"] = previews
        return web.json_response({"info": info, "cover": bool(_find_cover(model_path))})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


async def _body_model(request):
    data = await request.json()
    kind = str(data.get("kind") or "")
    name = str(data.get("name") or "")
    model_path = _model_path(kind, name)
    return data, kind, name, model_path


@PromptServer.instance.routes.post("/browser_loader/set_url")
async def browser_loader_set_url(request):
    try:
        data, kind, name, model_path = await _body_model(request)
        url = str(data.get("url") or "").strip()
        if url:
            parsed = urlparse(url)
            if parsed.scheme not in {"http", "https"}:
                raise ValueError("网址必须以 http:// 或 https:// 开头。")
        info = _read_info(model_path, kind, name)
        info["url"] = url
        _write_info(model_path, info)
        return web.json_response({"ok": True, "info": info})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/browser_loader/save_note")
async def browser_loader_save_note(request):
    try:
        data, kind, name, model_path = await _body_model(request)
        info = _read_info(model_path, kind, name)
        info["user_note"] = str(data.get("note") or "")
        _write_info(model_path, info)
        return web.json_response({"ok": True, "info": info})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/browser_loader/save_detail")
async def browser_loader_save_detail(request):
    """Save editable model metadata to the model-sidecar text document.

    This edits only BrowserLoader metadata; it never mutates the model file.
    The payload is deliberately normalized so arbitrary top-level keys cannot
    be written into the sidecar format.
    """
    try:
        data, kind, name, model_path = await _body_model(request)
        info = _read_info(model_path, kind, name)

        def text_value(key, current=""):
            value = data.get(key, current)
            return "" if value is None else str(value)

        def int_or_none(value):
            if value in (None, "", "—"):
                return None
            try:
                return int(str(value).strip())
            except Exception:
                return None

        info["url"] = text_value("url", info.get("url") or "").strip()
        info["version"] = text_value("version", info.get("version") or "")
        info["model_version_id"] = int_or_none(data.get("model_version_id", info.get("model_version_id")))
        info["model_id"] = int_or_none(data.get("model_id", info.get("model_id")))
        info["user_note"] = text_value("user_note", info.get("user_note") or "")

        old_details = dict(info.get("details") or {})
        incoming = data.get("details") or {}
        if not isinstance(incoming, dict):
            incoming = {}
        allowed = {
            "model_name", "type", "version_name", "base_model", "base_model_type",
            "trained_words", "training_status", "training_details",
            "published", "creator", "air", "file_name", "file_metadata", "tags",
            "description", "version_description", "stats", "version_stats", "hashes",
            "source_url", "resolved_url",
        }
        for key in allowed:
            if key in incoming:
                old_details[key] = incoming[key]
        info["details"] = old_details
        if not info.get("model_name"):
            info["model_name"] = Path(model_path).stem
        _write_info(model_path, info)
        return web.json_response({"ok": True, "info": info})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/browser_loader/get_info")
async def browser_loader_get_info(request):
    try:
        data, kind, name, model_path = await _body_model(request)
        info = _read_info(model_path, kind, name)
        url = str(data.get("url") or info.get("url") or "").strip()
        if not url:
            raise ValueError("请先为模型设置 Civitai 网址。")

        fetched = await _fetch_civitai(model_path, url)
        network = fetched.pop("_network", {})
        # Keep the user's note across refreshes.
        note = info.get("user_note") or ""
        info.update(fetched)
        info["url"] = url
        info["user_note"] = note
        _write_info(model_path, info)

        # Store a folder-level index as well as per-image generation metadata.
        preview_dir = Path(_preview_dir(model_path))
        preview_dir.mkdir(parents=True, exist_ok=True)
        (preview_dir / "gallery.json").write_text(
            json.dumps(info.get("previews") or [], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return web.json_response({
            "ok": True,
            "info": info,
            "downloaded": len(info.get("previews") or []),
            "network": network,
        })
    except Exception as exc:
        source, proxy_url = await _detect_local_proxy()
        hint = (
            f" 当前网络模式：{_proxy_display(proxy_url, source)}。"
            "可在模型详情点击“代理设置”，填写本地 HTTP 代理，例如 http://127.0.0.1:7890。"
        )
        return web.json_response({"error": str(exc) + hint}, status=400)


class EDOUUNETLoader(comfy_nodes.UNETLoader):
    CATEGORY = "EDOU/BrowserLoader"
    DESCRIPTION = "EDOU UNET loader with model-cover browser and Civitai detail/gallery support."


class EDOUCheckpointLoader(comfy_nodes.CheckpointLoaderSimple):
    CATEGORY = "EDOU/BrowserLoader"
    DESCRIPTION = "EDOU checkpoint loader with model-cover browser and Civitai detail/gallery support."


class EDOULoraLoader(comfy_nodes.LoraLoaderModelOnly):
    CATEGORY = "EDOU/BrowserLoader"
    DESCRIPTION = "EDOU model-only LoRA loader with hierarchical path filters, cover browser and Civitai detail/gallery support."

    @classmethod
    def INPUT_TYPES(cls):
        base = super().INPUT_TYPES()
        required = dict(base.get("required") or {})
        strength_spec = required.pop("strength_model", ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01}))
        required["Lora_strength"] = strength_spec
        result = dict(base)
        result["required"] = required
        return result

    def load_lora(self, model, lora_name, Lora_strength):
        return super().load_lora(model, lora_name, Lora_strength)


NODE_CLASS_MAPPINGS = {
    "EDOUUNETLoader": EDOUUNETLoader,
    "EDOUCheckpointLoader": EDOUCheckpointLoader,
    "EDOULoraLoader": EDOULoraLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "EDOUUNETLoader": "EDOU-UNET加载器",
    "EDOUCheckpointLoader": "EDOU-Checkpoint模型加载器",
    "EDOULoraLoader": "EDOU-Lora加载器",
}
