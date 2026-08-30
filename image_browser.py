import os
import re

from aiohttp import web

import folder_paths
import nodes as comfy_nodes
from server import PromptServer


IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".bmp",
    ".gif",
    ".tif",
    ".tiff",
}


def _natural_key(value: str):
    """Sort image_2 before image_10."""
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", value)]


def _is_within(root: str, path: str) -> bool:
    """Version-tolerant containment check, including symlink resolution."""
    root_real = os.path.realpath(root)
    path_real = os.path.realpath(path)

    helper = getattr(folder_paths, "is_within_directory", None)
    if callable(helper):
        return bool(helper(root_real, path_real))

    try:
        return os.path.commonpath((root_real, path_real)) == root_real
    except ValueError:
        return False


def _resolve_input_subfolder(raw_subfolder: str):
    root = os.path.realpath(folder_paths.get_input_directory())
    raw_subfolder = (raw_subfolder or "").replace("\\", "/").strip("/")

    candidate = os.path.realpath(os.path.join(root, raw_subfolder))
    if not _is_within(root, candidate):
        raise ValueError("Path escapes the ComfyUI input directory")
    if not os.path.isdir(candidate):
        raise FileNotFoundError("Folder does not exist")

    canonical = os.path.relpath(candidate, root)
    if canonical == ".":
        canonical = ""
    canonical = canonical.replace("\\", "/")
    return root, candidate, canonical


def _entry_relpath(root: str, full_path: str) -> str:
    return os.path.relpath(full_path, root).replace("\\", "/")


@PromptServer.instance.routes.get("/image_browser_loader/list")
async def image_browser_list(request):
    """Return folders + image files for one directory inside ComfyUI/input."""
    requested = request.rel_url.query.get("subfolder", "")

    try:
        root, current_dir, canonical = _resolve_input_subfolder(requested)
    except (ValueError, FileNotFoundError) as exc:
        return web.json_response({"error": str(exc)}, status=400)

    folders = []
    images = []

    try:
        entries = list(os.scandir(current_dir))
    except OSError as exc:
        return web.json_response({"error": f"Cannot read folder: {exc}"}, status=500)

    for entry in entries:
        try:
            full_path = os.path.realpath(entry.path)
            if not _is_within(root, full_path):
                continue

            if entry.is_dir(follow_symlinks=True):
                folders.append(
                    {
                        "type": "folder",
                        "name": entry.name,
                        "path": _entry_relpath(root, full_path),
                    }
                )
                continue

            if not entry.is_file(follow_symlinks=True):
                continue

            ext = os.path.splitext(entry.name)[1].lower()
            if ext not in IMAGE_EXTENSIONS:
                continue

            stat = entry.stat(follow_symlinks=True)
            images.append(
                {
                    "type": "image",
                    "name": entry.name,
                    "path": _entry_relpath(root, full_path),
                    "size": stat.st_size,
                    "mtime": int(stat.st_mtime),
                }
            )
        except (OSError, ValueError):
            continue

    folders.sort(key=lambda item: _natural_key(item["name"]))
    images.sort(key=lambda item: _natural_key(item["name"]))

    parent = ""
    if canonical:
        parent = os.path.dirname(canonical).replace("\\", "/")
        if parent == ".":
            parent = ""

    return web.json_response(
        {
            "subfolder": canonical,
            "parent": parent,
            "items": folders + images,
            "folder_count": len(folders),
            "image_count": len(images),
        }
    )


class ImageBrowserLoader(comfy_nodes.LoadImage):
    """Stock LoadImage backend + EDOU thumbnail-browser frontend."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "由 EDOU 图像浏览器写入的 ComfyUI/input 相对路径",
                    },
                )
            }
        }

    CATEGORY = "image/loaders"
    DESCRIPTION = "EDOU 文件管理器式图像浏览器：完整缩略图、文件夹浏览、滚动预览、上传，并兼容 ComfyUI MaskEditor 遮罩编辑。"


NODE_CLASS_MAPPINGS = {
    "ImageBrowserLoader": ImageBrowserLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageBrowserLoader": "EDOU图像浏览加载",
}
