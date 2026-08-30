import { app, ComfyApp } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const EXTENSION_NAME = "EDOU.ImageBrowserLoader.ThumbnailGrid";
const NODE_CLASS = "ImageBrowserLoader";
const MIN_NODE_WIDTH = 560;
const MIN_NODE_HEIGHT = 700;
const BROWSER_MIN_HEIGHT = 586;

function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function normalizePath(path) {
    return String(path || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function dirname(path) {
    path = normalizePath(path);
    const i = path.lastIndexOf("/");
    return i >= 0 ? path.slice(0, i) : "";
}

function joinPath(...parts) {
    return normalizePath(parts.filter(Boolean).join("/"));
}

function parseImageWidgetValue(value) {
    // Current ComfyUI MaskEditor writes values such as
    // "clipspace-painted-masked-123.png [input]" back into the image widget.
    // Keep the browser UI path clean while preserving the annotated type.
    if (value && typeof value === "object") {
        const filename = String(value.filename || "");
        const subfolder = String(value.subfolder || "");
        return {
            path: joinPath(subfolder, filename),
            type: String(value.type || "input"),
        };
    }

    let text = String(value || "").trim();
    let type = "input";
    const match = text.match(/\s+\[(input|output|temp)\]\s*$/i);
    if (match) {
        type = match[1].toLowerCase();
        text = text.slice(0, match.index).trim();
    }
    return { path: normalizePath(text), type };
}

function imageRefFromPath(relativePath, type = "input") {
    const clean = normalizePath(relativePath);
    const slash = clean.lastIndexOf("/");
    return {
        filename: slash >= 0 ? clean.slice(slash + 1) : clean,
        subfolder: slash >= 0 ? clean.slice(0, slash) : "",
        type: type || "input",
    };
}

function originalImageUrl(relativePath, type = "input") {
    const ref = imageRefFromPath(relativePath, type);
    const params = new URLSearchParams({
        filename: ref.filename,
        type: ref.type,
        subfolder: ref.subfolder,
    });
    return api.apiURL(`/view?${params.toString()}`);
}

function humanSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function thumbnailUrl(relativePath) {
    const clean = normalizePath(relativePath);
    const slash = clean.lastIndexOf("/");
    const filename = slash >= 0 ? clean.slice(slash + 1) : clean;
    const subfolder = slash >= 0 ? clean.slice(0, slash) : "";
    const params = new URLSearchParams({
        filename,
        type: "input",
        subfolder,
        preview: "webp;82",
    });
    return api.apiURL(`/view?${params.toString()}`);
}

function hideNativeWidget(widget) {
    if (!widget) return;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
    widget.serializeValue = () => widget.value ?? "";
}

function addStyles(root) {
    Object.assign(root.style, {
        width: "100%",
        height: "100%",
        minHeight: "0",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "8px",
        overflow: "hidden",
        color: "var(--input-text, #ddd)",
        fontFamily: "Arial, 'Microsoft YaHei', sans-serif",
        fontSize: "12px",
        userSelect: "none",
    });
}

function makeButton(label, title = "", width = null) {
    const button = el("button", "edou-ibl-btn", label);
    button.type = "button";
    button.title = title;
    Object.assign(button.style, {
        height: "30px",
        minWidth: width ? `${width}px` : "34px",
        width: width ? `${width}px` : "auto",
        padding: width ? "0 10px" : "0 9px",
        boxSizing: "border-box",
        border: "1px solid rgba(255,255,255,.16)",
        borderRadius: "6px",
        background: "rgba(255,255,255,.065)",
        color: "inherit",
        cursor: "pointer",
        fontSize: "12px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        flex: "0 0 auto",
    });
    button.onmouseenter = () => {
        if (!button.disabled) button.style.background = "rgba(255,255,255,.13)";
    };
    button.onmouseleave = () => {
        button.style.background = "rgba(255,255,255,.065)";
    };
    return button;
}

function makeFolderVisual() {
    const wrap = el("div");
    Object.assign(wrap.style, {
        width: "72%",
        maxWidth: "88px",
        aspectRatio: "1.35 / 1",
        position: "relative",
    });

    const tab = el("div");
    Object.assign(tab.style, {
        position: "absolute",
        left: "8%",
        top: "5%",
        width: "47%",
        height: "27%",
        borderRadius: "7px 7px 2px 2px",
        background: "linear-gradient(#63686e,#494e53)",
        border: "1px solid rgba(255,255,255,.14)",
    });

    const body = el("div");
    Object.assign(body.style, {
        position: "absolute",
        inset: "20% 0 0 0",
        borderRadius: "9px",
        background: "linear-gradient(#5d6268,#41464b)",
        border: "1px solid rgba(255,255,255,.19)",
        boxShadow: "inset 0 1px rgba(255,255,255,.07)",
    });

    wrap.append(tab, body);
    return wrap;
}

app.registerExtension({
    name: EXTENSION_NAME,

    async nodeCreated(node) {
        if (node.comfyClass !== NODE_CLASS) return;

        const imageWidget = node.widgets?.find((w) => w.name === "image");
        if (!imageWidget) return;
        hideNativeWidget(imageWidget);

        node.properties ||= {};
        let previewSize = Math.max(80, Math.min(240, Number(node.properties.edou_image_preview_size || 118)));

        const root = el("div", "edou-ibl-root");
        addStyles(root);

        // ---- navigation / upload toolbar ----
        const toolbar = el("div", "edou-ibl-toolbar");
        Object.assign(toolbar.style, {
            display: "grid",
            gridTemplateColumns: "38px minmax(0, 1fr) 92px 38px",
            gap: "7px",
            alignItems: "center",
            flex: "0 0 auto",
            minWidth: "0",
        });

        const backBtn = makeButton("←", "返回上一级", 38);

        const pathLabel = el("div", "edou-ibl-path", "input /");
        Object.assign(pathLabel.style, {
            minWidth: "0",
            height: "30px",
            lineHeight: "28px",
            boxSizing: "border-box",
            padding: "0 10px",
            border: "1px solid rgba(255,255,255,.12)",
            borderRadius: "6px",
            background: "rgba(0,0,0,.18)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
        });

        const uploadBtn = makeButton("上传图片", "上传图片到当前文件夹", 92);
        const refreshBtn = makeButton("↻", "刷新当前文件夹", 38);
        toolbar.append(backBtn, pathLabel, uploadBtn, refreshBtn);

        // ---- search row ----
        const searchRow = el("div");
        Object.assign(searchRow.style, {
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            flex: "0 0 auto",
            minWidth: "0",
        });

        const search = el("input");
        search.type = "search";
        search.placeholder = "搜索当前文件夹…";
        Object.assign(search.style, {
            width: "100%",
            minWidth: "0",
            height: "30px",
            boxSizing: "border-box",
            border: "1px solid rgba(255,255,255,.12)",
            borderRadius: "6px",
            outline: "none",
            padding: "0 10px",
            background: "rgba(0,0,0,.22)",
            color: "inherit",
        });
        searchRow.append(search);

        // ---- preview scale ----
        const zoomRow = el("div", "edou-ibl-zoom");
        Object.assign(zoomRow.style, {
            display: "grid",
            gridTemplateColumns: "72px minmax(0, 1fr) 48px",
            gap: "9px",
            alignItems: "center",
            flex: "0 0 auto",
            minWidth: "0",
            padding: "0 2px",
        });
        const zoomLabel = el("div", "", "预览缩放");
        Object.assign(zoomLabel.style, {
            fontSize: "11px",
            color: "rgba(255,255,255,.70)",
            whiteSpace: "nowrap",
        });
        const zoomSlider = document.createElement("input");
        zoomSlider.type = "range";
        zoomSlider.min = "80";
        zoomSlider.max = "240";
        zoomSlider.step = "4";
        zoomSlider.value = String(previewSize);
        Object.assign(zoomSlider.style, {
            width: "100%",
            minWidth: "0",
            cursor: "pointer",
            accentColor: "#58a6ff",
        });
        const zoomValue = el("div", "", `${previewSize}px`);
        Object.assign(zoomValue.style, {
            textAlign: "right",
            fontSize: "11px",
            color: "rgba(255,255,255,.70)",
        });
        zoomRow.append(zoomLabel, zoomSlider, zoomValue);

        // ---- scrollable thumbnail grid ----
        const grid = el("div", "edou-ibl-grid");
        Object.assign(grid.style, {
            flex: "1 1 auto",
            minHeight: "0",
            overflowY: "auto",
            overflowX: "hidden",
            overscrollBehavior: "contain",
            scrollbarWidth: "thin",
            scrollbarGutter: "stable",
            display: "grid",
            gridTemplateColumns: `repeat(auto-fill, minmax(${previewSize}px, 1fr))`,
            gridAutoRows: "max-content",
            alignContent: "start",
            alignItems: "start",
            gap: "10px",
            padding: "3px 5px 10px 2px",
        });

        // ---- footer ----
        const footer = el("div");
        Object.assign(footer.style, {
            flex: "0 0 auto",
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            alignItems: "center",
            gap: "10px",
            opacity: ".82",
            fontSize: "11px",
            padding: "1px 2px 0",
            minWidth: "0",
        });

        const selectedLabel = el("div", "edou-ibl-selected", "未选择图像");
        Object.assign(selectedLabel.style, {
            minWidth: "0",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
        });

        const countLabel = el("div", "edou-ibl-count", "");
        Object.assign(countLabel.style, {
            whiteSpace: "nowrap",
            textAlign: "right",
        });
        footer.append(selectedLabel, countLabel);

        // Hidden native file picker. The upload button opens this, then files are
        // sent to ComfyUI's local /upload/image endpoint into the current folder.
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*,.tif,.tiff";
        fileInput.multiple = true;
        fileInput.style.display = "none";

        // The native image widget sits immediately above this DOM widget on
        // recent ComfyUI builds. Reserve a real vertical gap so the two rows
        // never visually touch or overlap when node/widget metrics change.
        const topSpacer = el("div", "edou-ibl-top-spacer");
        Object.assign(topSpacer.style, {
            height: "11px",
            minHeight: "11px",
            flex: "0 0 11px",
            pointerEvents: "none",
        });

        root.append(topSpacer, toolbar, searchRow, zoomRow, grid, footer, fileInput);

        const browserWidget = node.addDOMWidget?.("image_browser", "image_browser", root, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => BROWSER_MIN_HEIGHT,
        });

        // Explicit minimum DOM-widget height is important on current ComfyUI.
        // Without it the DOM layout reserves ~50 px and the browser visually
        // compresses the thumbnail grid vertically.
        if (browserWidget?.options) {
            browserWidget.options.getMinHeight = () => BROWSER_MIN_HEIGHT;
        }

        const initialWidgetPath = parseImageWidgetValue(imageWidget.value).path;
        let currentFolder = normalizePath(
            node.properties.image_browser_folder || dirname(initialWidgetPath)
        );
        let allItems = [];
        let selectedCard = null;
        let requestSerial = 0;
        let uploading = false;

        function applyPreviewSize() {
            grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${previewSize}px, 1fr))`;
            zoomValue.textContent = `${previewSize}px`;
            node.properties.edou_image_preview_size = previewSize;
            markDirty();
        }

        zoomSlider.oninput = () => {
            previewSize = Math.max(80, Math.min(240, Number(zoomSlider.value || 118)));
            applyPreviewSize();
        };

        function markDirty() {
            node.graph?.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
        }

        function selectedPathFromNodeState() {
            // MaskEditor saves a structured node.images ref first; prefer that
            // because it preserves a possible subfolder even when the widget
            // text is only an annotated filename.
            const ref = node.images?.[0];
            if (ref?.filename) {
                return {
                    path: joinPath(ref.subfolder || "", ref.filename),
                    type: ref.type || "input",
                };
            }
            return parseImageWidgetValue(imageWidget.value);
        }

        function syncMaskEditorImageState(relativePath, type = "input") {
            const clean = normalizePath(relativePath);
            if (!clean) return;
            const ref = imageRefFromPath(clean, type);

            // Current MaskEditor accepts previewMediaType === "image" and then
            // resolves node.images[0] directly. This avoids adding a second
            // large canvas preview behind the thumbnail browser.
            node.previewMediaType = "image";
            node.images = [ref];
            node.imageIndex = 0;
        }

        function syncBrowserFromExternalImageValue({ refreshFolder = false } = {}) {
            const selected = selectedPathFromNodeState();
            if (!selected.path) return;
            selectedLabel.textContent = selected.path;
            selectedLabel.title = selected.path;

            const folder = dirname(selected.path);
            if (refreshFolder) {
                loadFolder(folder);
            } else if (folder === currentFolder) {
                render();
            }
            markDirty();
        }

        function startMaskEditorSaveWatcher(beforeValue) {
            // The stock MaskEditor writes imageWidget.value directly and does
            // not call the widget callback. Watch only after the editor is
            // opened, then stop as soon as Save changes the value.
            let attempts = 0;
            const timer = window.setInterval(() => {
                attempts += 1;
                if (String(imageWidget.value ?? "") !== String(beforeValue ?? "")) {
                    window.clearInterval(timer);
                    syncBrowserFromExternalImageValue({ refreshFolder: true });
                    return;
                }
                // Stop after 10 minutes if the editor was closed without Save.
                if (attempts >= 1200) window.clearInterval(timer);
            }, 500);
        }

        function openMaskEditorForNode() {
            const selected = selectedPathFromNodeState();
            if (!selected.path) {
                app.extensionManager?.toast?.add?.({
                    severity: "warn",
                    summary: "EDOU图像浏览加载",
                    detail: "请先选择一张图像，再打开遮罩编辑器。",
                    life: 3000,
                });
                return;
            }

            // Browser selections need a structured node.images reference so
            // ComfyUI's current MaskEditor can resolve /view correctly.
            syncMaskEditorImageState(selected.path, selected.type);
            const beforeValue = imageWidget.value;

            try {
                // Current ComfyUI still exposes this direct compatibility
                // bridge, and unlike the command route it does not depend on
                // canvas selection state. Prefer it when available.
                if (typeof ComfyApp?.open_maskeditor === "function") {
                    ComfyApp.clipspace_return_node = node;
                    ComfyApp.open_maskeditor();
                } else {
                    // Future fallback: use the public command manager.
                    app.canvas?.selectNode?.(node, false);
                    const commands = app.extensionManager?.command?.commands || [];
                    const hasModernCommand = commands.some(
                        (command) => command?.id === "Comfy.MaskEditor.OpenMaskEditor"
                    );
                    if (!hasModernCommand) {
                        throw new Error("当前 ComfyUI 前端没有可用的 MaskEditor API");
                    }
                    app.extensionManager.command.execute("Comfy.MaskEditor.OpenMaskEditor");
                }

                startMaskEditorSaveWatcher(beforeValue);
            } catch (error) {
                console.error("[EDOU ImageBrowserLoader] mask editor open failed", error);
                app.extensionManager?.toast?.add?.({
                    severity: "error",
                    summary: "遮罩编辑器打开失败",
                    detail: error?.message || String(error),
                    life: 5000,
                });
            }
        }

        function setSelected(item, card = null) {
            if (selectedCard) {
                selectedCard.style.outline = "1px solid rgba(255,255,255,.11)";
                selectedCard.style.background = "rgba(255,255,255,.035)";
            }

            selectedCard = card;
            if (card) {
                card.style.outline = "2px solid rgba(80,165,255,.98)";
                card.style.background = "rgba(80,165,255,.12)";
            }

            imageWidget.value = normalizePath(item.path);
            syncMaskEditorImageState(imageWidget.value, "input");
            selectedLabel.textContent = imageWidget.value;
            selectedLabel.title = imageWidget.value;

            if (typeof imageWidget.callback === "function") {
                try {
                    imageWidget.callback(imageWidget.value, app.canvas, node, app.canvas?.graph_mouse);
                } catch (_) {}
            }
            markDirty();
        }

        function makeCard(item) {
            const card = el("div", "edou-ibl-card");
            Object.assign(card.style, {
                minWidth: "0",
                borderRadius: "8px",
                overflow: "hidden",
                outline: "1px solid rgba(255,255,255,.11)",
                background: "rgba(255,255,255,.035)",
                cursor: "pointer",
                position: "relative",
            });

            const preview = el("div", "edou-ibl-preview");
            Object.assign(preview.style, {
                width: "100%",
                aspectRatio: "1 / 1",
                boxSizing: "border-box",
                background: "rgba(0,0,0,.22)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
                padding: item.type === "folder" ? "8px" : "4px",
            });

            const label = el("div", "edou-ibl-name", item.name);
            Object.assign(label.style, {
                minHeight: "34px",
                maxHeight: "34px",
                lineHeight: "15px",
                boxSizing: "border-box",
                padding: "3px 6px 2px",
                overflow: "hidden",
                wordBreak: "break-all",
                textAlign: "center",
                fontSize: "10.5px",
            });

            if (item.type === "folder") {
                preview.append(makeFolderVisual());
                card.title = item.path;
                card.ondblclick = card.onclick = () => loadFolder(item.path);
            } else {
                const img = new Image();
                img.loading = "lazy";
                img.decoding = "async";
                img.draggable = false;
                img.src = thumbnailUrl(item.path);
                Object.assign(img.style, {
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    objectPosition: "center center",
                    display: "block",
                });
                img.onerror = () => {
                    preview.replaceChildren(el("div", "", "预览失败"));
                    preview.style.opacity = ".55";
                };
                preview.append(img);
                card.title = `${item.path}\n${humanSize(item.size)}`;
                card.onclick = () => setSelected(item, card);
            }

            card.append(preview, label);

            if (
                item.type === "image" &&
                normalizePath(item.path) === parseImageWidgetValue(imageWidget.value).path
            ) {
                queueMicrotask(() => setSelected(item, card));
            }
            return card;
        }

        function render() {
            const q = search.value.trim().toLocaleLowerCase();
            const visible = q
                ? allItems.filter((item) => item.name.toLocaleLowerCase().includes(q))
                : allItems;

            grid.replaceChildren();
            selectedCard = null;

            if (!visible.length) {
                const empty = el("div", "", q ? "没有匹配项" : "此文件夹没有可预览图像");
                Object.assign(empty.style, {
                    gridColumn: "1 / -1",
                    padding: "32px 8px",
                    textAlign: "center",
                    opacity: ".55",
                });
                grid.append(empty);
                return;
            }

            const fragment = document.createDocumentFragment();
            for (const item of visible) fragment.append(makeCard(item));
            grid.append(fragment);
        }

        async function loadFolder(folder = currentFolder, keepSearch = false) {
            const serial = ++requestSerial;
            currentFolder = normalizePath(folder);
            pathLabel.textContent = currentFolder ? `input / ${currentFolder}` : "input /";
            pathLabel.title = currentFolder ? `input/${currentFolder}` : "input";
            backBtn.disabled = !currentFolder;
            grid.replaceChildren();

            const loading = el("div", "", "正在读取…");
            Object.assign(loading.style, {
                gridColumn: "1 / -1",
                padding: "28px",
                textAlign: "center",
                opacity: ".6",
            });
            grid.append(loading);

            try {
                const response = await api.fetchApi(
                    `/image_browser_loader/list?subfolder=${encodeURIComponent(currentFolder)}`
                );
                if (!response.ok) {
                    let message = `HTTP ${response.status}`;
                    try {
                        const body = await response.json();
                        message = body.error || message;
                    } catch (_) {}
                    throw new Error(message);
                }

                const data = await response.json();
                if (serial !== requestSerial) return;

                currentFolder = normalizePath(data.subfolder);
                node.properties.image_browser_folder = currentFolder;
                allItems = Array.isArray(data.items) ? data.items : [];
                pathLabel.textContent = currentFolder ? `input / ${currentFolder}` : "input /";
                pathLabel.title = currentFolder ? `input/${currentFolder}` : "input";
                backBtn.disabled = !currentFolder;
                countLabel.textContent = `${data.folder_count || 0} 文件夹 · ${data.image_count || 0} 图像`;
                if (!keepSearch) search.value = "";
                render();
            } catch (error) {
                if (serial !== requestSerial) return;
                grid.replaceChildren();
                const failed = el("div", "", `读取失败：${error?.message || error}`);
                Object.assign(failed.style, {
                    gridColumn: "1 / -1",
                    padding: "28px 8px",
                    textAlign: "center",
                    color: "#ff9b9b",
                    whiteSpace: "pre-wrap",
                });
                grid.append(failed);
            }
        }

        async function uploadFiles(files) {
            const imageFiles = Array.from(files || []).filter((file) => file?.size > 0);
            if (!imageFiles.length || uploading) return;

            uploading = true;
            uploadBtn.disabled = true;
            const oldLabel = uploadBtn.textContent;
            let lastUploadedPath = "";

            try {
                for (let i = 0; i < imageFiles.length; i++) {
                    uploadBtn.textContent = imageFiles.length > 1
                        ? `上传 ${i + 1}/${imageFiles.length}`
                        : "上传中…";
                    selectedLabel.textContent = `正在上传：${imageFiles[i].name}`;
                    selectedLabel.title = imageFiles[i].name;

                    const form = new FormData();
                    form.append("image", imageFiles[i], imageFiles[i].name);
                    form.append("type", "input");
                    form.append("subfolder", currentFolder);

                    const response = await api.fetchApi("/upload/image", {
                        method: "POST",
                        body: form,
                    });

                    if (!response.ok) {
                        let message = `HTTP ${response.status}`;
                        try {
                            const body = await response.json();
                            message = body.error || body.message || message;
                        } catch (_) {}
                        throw new Error(`${imageFiles[i].name}: ${message}`);
                    }

                    const result = await response.json();
                    lastUploadedPath = joinPath(result.subfolder || currentFolder, result.name || imageFiles[i].name);
                }

                if (lastUploadedPath) {
                    imageWidget.value = lastUploadedPath;
                    syncMaskEditorImageState(lastUploadedPath, "input");
                    selectedLabel.textContent = lastUploadedPath;
                    selectedLabel.title = lastUploadedPath;
                }
                await loadFolder(currentFolder);
            } catch (error) {
                selectedLabel.textContent = `上传失败：${error?.message || error}`;
                selectedLabel.title = selectedLabel.textContent;
                console.error("[EDOU ImageBrowserLoader] upload failed", error);
            } finally {
                uploading = false;
                uploadBtn.disabled = false;
                uploadBtn.textContent = oldLabel;
                fileInput.value = "";
                markDirty();
            }
        }

        backBtn.onclick = () => loadFolder(dirname(currentFolder));
        refreshBtn.onclick = () => loadFolder(currentFolder, true);
        search.oninput = render;
        uploadBtn.onclick = () => fileInput.click();
        fileInput.onchange = () => uploadFiles(fileInput.files);

        // Optional convenience: dropping image files onto the browser uploads
        // them into the currently open input subfolder.
        root.addEventListener("dragover", (event) => {
            if (event.dataTransfer?.types?.includes("Files")) {
                event.preventDefault();
                root.style.outline = "2px dashed rgba(80,165,255,.85)";
                root.style.outlineOffset = "-4px";
            }
        });
        root.addEventListener("dragleave", () => {
            root.style.outline = "none";
        });
        root.addEventListener("drop", (event) => {
            if (!event.dataTransfer?.files?.length) return;
            event.preventDefault();
            event.stopPropagation();
            root.style.outline = "none";
            uploadFiles(event.dataTransfer.files);
        });

        if (imageWidget.value) {
            const selected = parseImageWidgetValue(imageWidget.value);
            selectedLabel.textContent = selected.path;
            selectedLabel.title = selected.path;
            syncMaskEditorImageState(selected.path, selected.type);
        }

        // Add the same right-click MaskEditor entry users expect from the stock
        // Load Image node. If another extension/core already supplied it, do
        // not duplicate the menu item.
        const originalGetExtraMenuOptions = node.getExtraMenuOptions?.bind(node);
        node.getExtraMenuOptions = function(canvas, options) {
            const result = originalGetExtraMenuOptions?.(canvas, options);
            options ||= [];

            const alreadyPresent = options.some((option) => {
                const text = String(option?.content || option?.label || "").toLowerCase();
                return text.includes("maskeditor") || text.includes("mask editor") || text.includes("遮罩编辑");
            });

            if (!alreadyPresent) {
                if (options.length && options[options.length - 1] !== null) options.push(null);
                options.push({
                    content: "Open in MaskEditor | Image Canvas",
                    callback: () => openMaskEditorForNode(),
                });
            }
            return result;
        };

        // Give the browser a stable minimum area so the toolbar never crushes
        // and the thumbnail region can scroll vertically instead of being scaled.
        requestAnimationFrame(() => {
            const w = Math.max(Number(node.size?.[0]) || 0, MIN_NODE_WIDTH);
            const h = Math.max(Number(node.size?.[1]) || 0, MIN_NODE_HEIGHT);
            node.setSize?.([w, h]);
            markDirty();
        });

        loadFolder(currentFolder);
    },
});
