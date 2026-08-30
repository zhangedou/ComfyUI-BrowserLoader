import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const EXTENSION_NAME = "EDOU.BrowserLoader.ModelVisual";
const MODEL_CONFIGS = {
    EDOUUNETLoader: {
        kind: "unet",
        modelWidget: "unet_name",
        title: "EDOU-UNET加载器",
        hierarchical: false,
    },
    EDOUCheckpointLoader: {
        kind: "checkpoint",
        modelWidget: "ckpt_name",
        title: "EDOU-Checkpoint模型加载器",
        hierarchical: false,
    },
    EDOULoraLoader: {
        kind: "lora",
        modelWidget: "lora_name",
        title: "EDOU-Lora加载器",
        hierarchical: true,
    },
};

const MIN_NODE_WIDTH = 560;
const MODEL_BROWSER_HEIGHT = 500;
let activeOverlay = null;

function el(tag, className = "", text = "") {
    const x = document.createElement(tag);
    if (className) x.className = className;
    if (text !== undefined && text !== null) x.textContent = text;
    return x;
}

function norm(path) {
    return String(path || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function dirname(path) {
    const p = norm(path);
    const i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(0, i) : "";
}

function basename(path) {
    const p = norm(path);
    return p.slice(p.lastIndexOf("/") + 1);
}

function showToast(summary, detail, severity = "info") {
    if (app.extensionManager?.toast?.add) {
        app.extensionManager.toast.add({ summary, detail, severity, life: 4500 });
    } else {
        console[severity === "error" ? "error" : "log"](`[${summary}] ${detail}`);
    }
}

async function apiJson(url, options = undefined) {
    const r = await api.fetchApi(url, options);
    let data = null;
    try { data = await r.json(); } catch (_) { data = {}; }
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
}

function coverUrl(kind, name, bust = "") {
    const q = new URLSearchParams({ kind, name });
    if (bust) q.set("t", bust);
    return api.apiURL(`/browser_loader/cover?${q.toString()}`);
}

function previewUrl(kind, name, file) {
    const q = new URLSearchParams({ kind, name, file });
    return api.apiURL(`/browser_loader/preview?${q.toString()}`);
}

function styleButton(button, primary = false) {
    Object.assign(button.style, {
        height: "34px",
        borderRadius: "5px",
        border: "1px solid rgba(255,255,255,.13)",
        background: primary ? "#48ad6d" : "rgba(255,255,255,.10)",
        color: "#f2f2f2",
        padding: "0 12px",
        cursor: "pointer",
        fontSize: "12px",
        minWidth: "0",
    });
    button.onmouseenter = () => { if (!button.disabled) button.style.filter = "brightness(1.12)"; };
    button.onmouseleave = () => { button.style.filter = "none"; };
}

function makeSelect(title = "") {
    const s = document.createElement("select");
    s.className = "edou-dark-select";
    s.title = title;
    Object.assign(s.style, {
        height: "31px",
        minWidth: "0",
        width: "100%",
        border: "1px solid rgba(255,255,255,.13)",
        borderRadius: "6px",
        background: "#2b2b2b",
        color: "#eee",
        padding: "0 8px",
        outline: "none",
        fontSize: "11px",
        colorScheme: "dark",
    });
    return s;
}

function fillSelect(select, items, selected, allLabel) {
    select.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = allLabel;
    all.style.background = "#2b2b2b";
    all.style.color = "#f1f1f1";
    select.append(all);
    for (const item of items) {
        const opt = document.createElement("option");
        opt.value = item;
        opt.textContent = item;
        opt.style.background = "#2b2b2b";
        opt.style.color = "#f1f1f1";
        select.append(opt);
    }
    select.value = items.includes(selected) ? selected : "";
}

function placeholderCard(text = "无封面") {
    const p = el("div", "", text);
    Object.assign(p.style, {
        width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
        background: "linear-gradient(145deg, rgba(255,255,255,.07), rgba(0,0,0,.18))",
        color: "rgba(255,255,255,.38)", fontSize: "11px", textAlign: "center", padding: "8px", boxSizing: "border-box",
    });
    return p;
}

function makeModelCard(item, config, selectedName, onSelect) {
    const card = el("div", "edou-model-card");
    const active = String(item.name) === String(selectedName);
    Object.assign(card.style, {
        minWidth: "0",
        borderRadius: "7px",
        overflow: "hidden",
        border: active ? "2px solid #4da5ff" : "1px solid rgba(255,255,255,.12)",
        background: active ? "rgba(77,165,255,.10)" : "rgba(0,0,0,.18)",
        cursor: "pointer",
        boxSizing: "border-box",
    });

    const preview = el("div");
    Object.assign(preview.style, {
        width: "100%",
        aspectRatio: "2 / 3",
        background: "rgba(0,0,0,.25)",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    });
    if (item.has_preview) {
        const img = new Image();
        img.loading = "lazy";
        img.decoding = "async";
        img.src = coverUrl(config.kind, item.name);
        Object.assign(img.style, { width: "100%", height: "100%", objectFit: "contain", objectPosition: "center", display: "block" });
        img.onerror = () => preview.replaceChildren(placeholderCard("无封面"));
        preview.append(img);
    } else {
        preview.append(placeholderCard("无封面\n点击“获取信息”可下载 Civitai 预览"));
    }

    const name = el("div", "", item.display_name || basename(item.path));
    Object.assign(name.style, {
        height: "36px", lineHeight: "15px", padding: "3px 5px", boxSizing: "border-box",
        fontSize: "10px", overflow: "hidden", wordBreak: "break-all", textAlign: "left",
        background: "rgba(0,0,0,.16)",
    });
    card.title = item.path;
    card.append(preview, name);
    card.onclick = () => onSelect(item.name);
    return card;
}

function makeFolderVisual() {
    const wrap = el("div");
    Object.assign(wrap.style, { width: "72%", maxWidth: "92px", aspectRatio: "1.35 / 1", position: "relative" });
    const tab = el("div");
    Object.assign(tab.style, {
        position: "absolute", left: "8%", top: "5%", width: "48%", height: "27%",
        borderRadius: "7px 7px 2px 2px", background: "linear-gradient(#656a70,#484d52)",
        border: "1px solid rgba(255,255,255,.14)",
    });
    const body = el("div");
    Object.assign(body.style, {
        position: "absolute", inset: "20% 0 0 0", borderRadius: "9px",
        background: "linear-gradient(#60656b,#42474c)", border: "1px solid rgba(255,255,255,.19)",
        boxShadow: "inset 0 1px rgba(255,255,255,.07)",
    });
    wrap.append(tab, body);
    return wrap;
}

function makeFolderCard(folderName, fullPath, onOpen) {
    const card = el("div", "edou-model-folder-card");
    Object.assign(card.style, {
        minWidth: "0", borderRadius: "7px", overflow: "hidden", border: "1px solid rgba(255,255,255,.12)",
        background: "rgba(0,0,0,.18)", cursor: "pointer", boxSizing: "border-box",
    });
    const preview = el("div");
    Object.assign(preview.style, {
        width: "100%", aspectRatio: "2 / 3", background: "rgba(0,0,0,.20)", display: "flex",
        alignItems: "center", justifyContent: "center", padding: "14px", boxSizing: "border-box",
    });
    preview.append(makeFolderVisual());
    const name = el("div", "", folderName);
    Object.assign(name.style, {
        height: "36px", lineHeight: "30px", padding: "3px 5px", boxSizing: "border-box", fontSize: "10px",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "center", background: "rgba(0,0,0,.16)",
    });
    card.title = fullPath;
    card.append(preview, name);
    card.onclick = () => onOpen(fullPath);
    return card;
}

function uniqueSorted(values) {
    return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function allFolderPaths(items) {
    const paths = [];
    for (const item of items) {
        const parts = norm(item.folder).split("/").filter(Boolean);
        for (let i = 1; i <= parts.length; i++) paths.push(parts.slice(0, i).join("/"));
    }
    return uniqueSorted(paths);
}

function descendantsAtDepth(items, prefix, depthIndex) {
    const prefixParts = norm(prefix).split("/").filter(Boolean);
    const results = [];
    for (const item of items) {
        const folderParts = norm(item.folder).split("/").filter(Boolean);
        let ok = true;
        for (let i = 0; i < prefixParts.length; i++) {
            if (folderParts[i] !== prefixParts[i]) { ok = false; break; }
        }
        if (!ok || folderParts.length <= depthIndex) continue;
        results.push(folderParts[depthIndex]);
    }
    return uniqueSorted(results);
}

function buildTree(container, items, selectedName, onSelect) {
    container.replaceChildren();
    const root = { folders: new Map(), files: [] };
    for (const item of items) {
        const parts = norm(item.path).split("/").filter(Boolean);
        const file = parts.pop() || item.display_name;
        let node = root;
        for (const part of parts) {
            if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
            node = node.folders.get(part);
        }
        node.files.push({ ...item, file });
    }

    function renderBranch(tree, host, depth = 0) {
        for (const [folder, child] of [...tree.folders.entries()].sort((a,b)=>a[0].localeCompare(b[0], undefined, {numeric:true}))) {
            const details = document.createElement("details");
            details.open = depth < 2;
            const summary = document.createElement("summary");
            summary.textContent = folder;
            Object.assign(summary.style, { padding: "7px 6px", cursor: "pointer", color: "#ddd" });
            details.append(summary);
            const inner = el("div");
            inner.style.paddingLeft = "11px";
            renderBranch(child, inner, depth + 1);
            details.append(inner);
            host.append(details);
        }
        for (const item of tree.files.sort((a,b)=>a.file.localeCompare(b.file, undefined, {numeric:true}))) {
            const row = el("div", "", item.file);
            Object.assign(row.style, {
                padding: "8px 7px",
                margin: "1px 0",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "11px",
                background: item.name === selectedName ? "rgba(70,130,230,.34)" : "transparent",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            });
            row.title = item.path;
            row.onclick = () => onSelect(item);
            host.append(row);
        }
    }
    renderBranch(root, container);
}

function makeInfoRow(label, value) {
    const row = el("div");
    Object.assign(row.style, {
        display: "grid", gridTemplateColumns: "132px minmax(0,1fr)", gap: "12px",
        padding: "9px 2px", borderBottom: "1px solid rgba(255,255,255,.08)", alignItems: "start",
    });
    const l = el("div", "", label);
    l.style.color = "rgba(255,255,255,.56)";
    const v = el("div", "", value == null || value === "" ? "—" : String(value));
    Object.assign(v.style, { color: "#e5e5e5", wordBreak: "break-word", whiteSpace: "pre-wrap" });
    row.append(l, v);
    return row;
}

function detailSummary(info) {
    const d = info?.details || {};
    const rows = [];
    rows.push(["网址地址", info?.url || ""]);
    rows.push(["模型版本号", info?.version || d.version_name || ""]);
    rows.push(["Civitai ModelVersion ID", info?.model_version_id || ""]);
    rows.push(["Civitai Model ID", info?.model_id || ""]);
    rows.push(["模型名称", d.model_name || info?.model_name || ""]);
    rows.push(["类型", d.type || ""]);
    rows.push(["基础模型", d.base_model || ""]);
    rows.push(["基础模型类型", d.base_model_type || ""]);
    rows.push(["发布时间", d.published || ""]);
    rows.push(["作者", d.creator || ""]);
    rows.push(["AIR", d.air || ""]);
    const hashes = d.hashes || {};
    rows.push(["Hash / AutoV2", hashes.AutoV2 || hashes.SHA256 || ""]);
    const stats = d.stats || {};
    rows.push(["统计", Object.keys(stats).length ? JSON.stringify(stats, null, 2) : ""]);
    const versionStats = d.version_stats || {};
    rows.push(["版本统计", Object.keys(versionStats).length ? JSON.stringify(versionStats, null, 2) : ""]);
    rows.push(["源文件名", d.file_name || ""]);
    rows.push(["标签", Array.isArray(d.tags) ? d.tags.join(", ") : ""]);
    rows.push(["模型说明", d.description || ""]);
    rows.push(["版本说明", d.version_description || ""]);
    return rows;
}

function openMetaPopup(meta) {
    const shade = el("div");
    Object.assign(shade.style, {
        position: "fixed", inset: "0", zIndex: "100001", background: "rgba(0,0,0,.70)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: "4vh 6vw",
    });
    const box = el("div");
    Object.assign(box.style, {
        width: "min(760px, 90vw)", maxHeight: "88vh", background: "#24262b", border: "1px solid rgba(255,255,255,.16)",
        borderRadius: "10px", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 70px rgba(0,0,0,.65)",
        color: "#dfe5ee", fontFamily: "Arial, 'Microsoft YaHei', sans-serif",
    });
    const head = el("div");
    Object.assign(head.style, {
        display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px",
        borderBottom: "1px solid rgba(255,255,255,.09)", flex: "0 0 auto",
    });
    const headTitle = el("strong", "", "生成信息");
    headTitle.style.fontSize = "18px";
    const actions = el("div");
    Object.assign(actions.style, { display: "flex", gap: "8px" });
    const copyPrompt = el("button", "", "复制 Prompt"); styleButton(copyPrompt, false);
    const copyAll = el("button", "", "复制全部"); styleButton(copyAll, true);
    const close = el("button", "", "关闭"); styleButton(close, false);
    actions.append(copyPrompt, copyAll, close); head.append(headTitle, actions);

    const body = el("div");
    Object.assign(body.style, { overflowY: "auto", padding: "18px 20px 22px", minHeight: "0", scrollbarWidth: "thin" });

    const generation = (meta?.generation && typeof meta.generation === "object") ? meta.generation : {};
    const get = (...keys) => {
        for (const key of keys) {
            const value = generation?.[key] ?? meta?.[key];
            if (value !== undefined && value !== null && value !== "") return value;
        }
        return "";
    };
    const prompt = get("prompt", "Prompt", "positivePrompt", "Positive prompt");
    const negative = get("negativePrompt", "Negative prompt", "negative_prompt");

    const promptHeader = el("div");
    Object.assign(promptHeader.style, { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "8px" });
    const promptTitle = el("div", "", "Prompt");
    Object.assign(promptTitle.style, { fontSize: "19px", fontWeight: "700", color: "#e9edf5" });
    promptHeader.append(promptTitle);
    const badge = (text) => {
        const b = el("span", "", text);
        Object.assign(b.style, {
            padding: "3px 8px", borderRadius: "5px", background: "#243a5e", color: "#7eb8ff",
            fontWeight: "700", fontSize: "10px", letterSpacing: ".3px", whiteSpace: "nowrap",
        });
        return b;
    };
    promptHeader.append(badge("EXTERNAL GENERATOR"));
    const engine = get("engine", "Engine", "process", "Process", "Version");
    if (engine) promptHeader.append(badge(String(engine).toUpperCase()));
    body.append(promptHeader);

    const promptText = el("div", "", prompt || "—");
    Object.assign(promptText.style, {
        fontSize: "15px", lineHeight: "1.55", color: "#aebfe0", whiteSpace: "pre-wrap", wordBreak: "break-word",
        userSelect: "text", paddingBottom: "14px",
    });
    body.append(promptText);

    if (negative) {
        const negTitle = el("div", "", "Negative Prompt");
        Object.assign(negTitle.style, { fontSize: "14px", fontWeight: "700", margin: "3px 0 6px", color: "#dfe5ee" });
        const negText = el("div", "", String(negative));
        Object.assign(negText.style, { color: "#aebfe0", lineHeight: "1.5", whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text" });
        body.append(negTitle, negText);
    }

    const divider = el("div");
    Object.assign(divider.style, { height: "1px", background: "rgba(255,255,255,.09)", margin: "17px 0 15px" });
    body.append(divider);

    const otherTitle = el("div", "", "Other metadata");
    Object.assign(otherTitle.style, { fontSize: "17px", fontWeight: "700", marginBottom: "10px", color: "#e9edf5" });
    body.append(otherTitle);

    const chipWrap = el("div");
    Object.assign(chipWrap.style, { display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "12px" });
    const metaDefs = [
        ["CFGSCALE", ["cfgScale", "cfgscale", "cfg", "CFG scale"]],
        ["STEPS", ["steps", "Steps"]],
        ["SAMPLER", ["sampler", "Sampler"]],
        ["SCHEDULER", ["scheduler", "Scheduler"]],
        ["SEED", ["seed", "Seed"]],
        ["WIDTH", ["width", "Width"]],
        ["HEIGHT", ["height", "Height"]],
        ["MODEL", ["Model", "model"]],
        ["CLIP SKIP", ["clipSkip", "Clip skip"]],
        ["DENOISE", ["denoise", "Denoise"]],
    ];
    const humanLines = [];
    if (prompt) humanLines.push(`Prompt: ${prompt}`);
    if (negative) humanLines.push(`Negative Prompt: ${negative}`);
    for (const [label, keys] of metaDefs) {
        let value = "";
        for (const key of keys) {
            value = get(key);
            if (value !== "") break;
        }
        if (value === "" || typeof value === "object") continue;
        const chip = el("div", "", `${label}: ${value}`);
        Object.assign(chip.style, {
            padding: "6px 10px", borderRadius: "5px", background: "#293b57", color: "#86b8f7",
            fontSize: "11px", fontWeight: "700", userSelect: "text",
        });
        chipWrap.append(chip);
        humanLines.push(`${label}: ${value}`);
    }
    if (!chipWrap.childElementCount) {
        const empty = el("div", "", "暂无可识别的生成参数");
        empty.style.color = "rgba(255,255,255,.45)";
        chipWrap.append(empty);
    }
    body.append(chipWrap);

    const resources = Array.isArray(generation?.resources) && generation.resources.length
        ? generation.resources
        : (Array.isArray(meta?.resources) ? meta.resources : []);
    if (resources.length) {
        const resTitle = el("div", "", "Resources");
        Object.assign(resTitle.style, { fontSize: "14px", fontWeight: "700", margin: "13px 0 7px" });
        const resWrap = el("div");
        Object.assign(resWrap.style, { display: "grid", gap: "6px" });
        for (const r of resources) {
            const name = r?.name || r?.modelName || r?.hash || "resource";
            const type = r?.type || "";
            const hash = r?.hash || "";
            const line = el("div", "", [type, name, hash].filter(Boolean).join(" · "));
            Object.assign(line.style, { padding: "7px 9px", borderRadius: "5px", background: "rgba(255,255,255,.045)", color: "#c9d2df", wordBreak: "break-word", userSelect: "text" });
            resWrap.append(line);
            humanLines.push(`Resource: ${[type, name, hash].filter(Boolean).join(" · ")}`);
        }
        body.append(resTitle, resWrap);
    }

    const rawDetails = document.createElement("details");
    rawDetails.style.marginTop = "16px";
    const rawSummary = document.createElement("summary");
    rawSummary.textContent = "查看原始数据";
    Object.assign(rawSummary.style, { cursor: "pointer", color: "rgba(255,255,255,.58)", userSelect: "none" });
    const pre = el("pre", "", JSON.stringify(meta || {}, null, 2));
    Object.assign(pre.style, {
        margin: "9px 0 0", padding: "12px", borderRadius: "6px", background: "#14161a", overflow: "auto",
        whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "11px", color: "#bfc6d0", userSelect: "text",
    });
    rawDetails.append(rawSummary, pre); body.append(rawDetails);

    copyPrompt.onclick = async () => {
        try { await navigator.clipboard.writeText(String(prompt || "")); copyPrompt.textContent = "已复制"; setTimeout(()=>copyPrompt.textContent="复制 Prompt", 1200); }
        catch (_) { showToast("复制失败", "浏览器未允许剪贴板权限", "error"); }
    };
    copyAll.onclick = async () => {
        try { await navigator.clipboard.writeText(humanLines.join("\n")); copyAll.textContent = "已复制"; setTimeout(()=>copyAll.textContent="复制全部", 1200); }
        catch (_) { showToast("复制失败", "浏览器未允许剪贴板权限", "error"); }
    };
    close.onclick = () => shade.remove();
    shade.onclick = (e) => { if (e.target === shade) shade.remove(); };
    box.append(head, body); shade.append(box); document.body.append(shade);
}

async function openModelDetail(config, initialName, mode) {
    if (!initialName) {
        showToast(config.title, "请先选择一个模型。", "warn");
        return;
    }
    if (activeOverlay) activeOverlay.remove();

    const overlay = el("div");
    activeOverlay = overlay;
    Object.assign(overlay.style, {
        position: "fixed", inset: "12px", zIndex: "100000", background: "#191b1e",
        border: "1px solid rgba(255,255,255,.18)", borderRadius: "9px", color: "#e6e6e6",
        boxShadow: "0 22px 90px rgba(0,0,0,.65)", display: "flex", flexDirection: "column", overflow: "hidden",
        fontFamily: "Arial, 'Microsoft YaHei', sans-serif", fontSize: "12px",
    });

    const header = el("div");
    Object.assign(header.style, {
        height: "64px", flex: "0 0 64px", display: "flex", alignItems: "center", gap: "10px",
        padding: "0 18px", borderBottom: "1px solid rgba(255,255,255,.09)", boxSizing: "border-box",
    });
    const icon = el("span", "", "🎨"); icon.style.fontSize = "22px";
    const title = el("div", "", initialName);
    Object.assign(title.style, { fontSize: "20px", color: "#f3f3f3", flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    const typeBadge = el("div", "", `模型类型：${config.title}`);
    Object.assign(typeBadge.style, {
        maxWidth: "38vw", padding: "8px 12px", borderRadius: "6px", border: "1px solid rgba(255,255,255,.10)",
        color: "rgba(255,255,255,.65)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    });
    const close = el("button", "", "×");
    Object.assign(close.style, { border: "0", background: "transparent", color: "#ddd", fontSize: "34px", cursor: "pointer", width: "44px" });
    close.onclick = () => { overlay.remove(); if (activeOverlay === overlay) activeOverlay = null; };
    header.append(icon, title, typeBadge, close);

    // One scrollbar for the entire detail page.
    const scroller = el("div");
    Object.assign(scroller.style, {
        flex: "1 1 auto", minHeight: "0", overflowY: "auto", overflowX: "hidden",
        scrollbarWidth: "thin", scrollbarGutter: "stable", overscrollBehavior: "contain",
    });

    const top = el("div");
    Object.assign(top.style, {
        display: "grid", gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)", gap: "22px",
        alignItems: "start", padding: "18px", boxSizing: "border-box",
    });

    const center = el("div");
    const coverCard = el("div");
    Object.assign(coverCard.style, {
        border: "1px solid rgba(255,255,255,.17)", borderRadius: "7px", overflow: "hidden", background: "#101214",
        position: "sticky", top: "0",
    });
    const cover = new Image();
    Object.assign(cover.style, {
        width: "100%", aspectRatio: "2 / 3", objectFit: "contain", objectPosition: "center",
        background: "#101214", display: "block",
    });
    const modelNameLabel = el("div", "", "");
    Object.assign(modelNameLabel.style, {
        padding: "11px", fontWeight: "700", fontSize: "13px", wordBreak: "break-all", minHeight: "42px", boxSizing: "border-box",
        borderTop: "1px solid rgba(255,255,255,.07)",
    });
    const centerButtons = el("div");
    Object.assign(centerButtons.style, { padding: "10px", display: "grid", gap: "8px", borderTop: "1px solid rgba(255,255,255,.07)" });
    const openUrlBtn = el("button", "", "打开网址"); styleButton(openUrlBtn, true);
    const setUrlBtn = el("button", "", "设置网址"); styleButton(setUrlBtn, false);
    const getInfoBtn = el("button", "", "获取信息"); styleButton(getInfoBtn, false);
    const proxyBtn = el("button", "", "代理设置"); styleButton(proxyBtn, false);
    const proxyStatus = el("div", "", "网络：正在检测…");
    Object.assign(proxyStatus.style, { minHeight: "16px", color: "rgba(255,255,255,.48)", lineHeight: "1.4", wordBreak: "break-word", fontSize: "11px" });
    const fetchStatus = el("div", "", "");
    Object.assign(fetchStatus.style, { minHeight: "18px", color: "rgba(255,255,255,.55)", lineHeight: "1.45", wordBreak: "break-word" });
    centerButtons.append(openUrlBtn, setUrlBtn, getInfoBtn, proxyBtn, proxyStatus, fetchStatus);
    coverCard.append(cover, modelNameLabel, centerButtons); center.append(coverCard);

    const right = el("div");
    Object.assign(right.style, { minWidth: "0", padding: "2px 2px 18px" });
    const infoHeader = el("div");
    Object.assign(infoHeader.style, { display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" });
    const infoTitle = el("div", "", mode === "edit" ? "模型详情（可编辑）" : "模型详情");
    Object.assign(infoTitle.style, { fontSize: "18px", fontWeight: "700", flex: "1" });
    const saveAll = el("button", "", "保存全部修改"); styleButton(saveAll, true);
    saveAll.style.display = mode === "edit" ? "inline-block" : "none";
    infoHeader.append(infoTitle, saveAll);

    // Two-column metadata area. Long description fields span both columns.
    const infoRows = el("div");
    Object.assign(infoRows.style, {
        display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: "24px", rowGap: "0",
        borderTop: "1px solid rgba(255,255,255,.08)",
    });
    right.append(infoHeader, infoRows);

    const noteTitle = el("div", "", mode === "edit" ? "模型注释（可编辑）" : "模型注释");
    Object.assign(noteTitle.style, { marginTop: "18px", marginBottom: "7px", fontWeight: "700", fontSize: "14px" });
    const note = document.createElement("textarea");
    note.readOnly = mode !== "edit";
    Object.assign(note.style, {
        width: "100%", minHeight: "140px", resize: "vertical", boxSizing: "border-box", borderRadius: "6px",
        border: "1px solid rgba(255,255,255,.13)", background: mode === "edit" ? "#101214" : "rgba(255,255,255,.04)",
        color: "#e4e4e4", padding: "10px", outline: "none", fontFamily: "inherit", lineHeight: "1.5",
    });
    right.append(noteTitle, note);
    top.append(center, right);

    const gallery = el("div");
    Object.assign(gallery.style, {
        borderTop: "1px solid rgba(255,255,255,.09)", padding: "16px 18px 26px", minHeight: "220px", boxSizing: "border-box",
    });
    const galleryTitle = el("div", "", "网址示例图片 / 生成信息");
    Object.assign(galleryTitle.style, { fontSize: "14px", fontWeight: "700", marginBottom: "12px" });
    const galleryGrid = el("div");
    Object.assign(galleryGrid.style, {
        display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: "12px", alignItems: "start",
    });
    gallery.append(galleryTitle, galleryGrid);

    scroller.append(top, gallery);
    overlay.append(header, scroller);
    document.body.append(overlay);

    let currentName = initialName;
    let currentInfo = null;
    const editors = new Map();

    const fieldDefs = [
        { key: "url", label: "网址地址" },
        { key: "version", label: "模型版本号" },
        { key: "model_version_id", label: "Civitai ModelVersion ID" },
        { key: "model_id", label: "Civitai Model ID" },
        { key: "model_name", label: "模型名称" },
        { key: "type", label: "类型" },
        { key: "base_model", label: "基础模型" },
        { key: "base_model_type", label: "基础模型类型" },
        ...(config.kind === "lora" ? [{ key: "trained_words", label: "触发词", chips: true, span: 2 }] : []),
        { key: "published", label: "发布时间" },
        { key: "creator", label: "作者" },
        { key: "air", label: "AIR", span: 2 },
        { key: "hash", label: "Hash / AutoV2", span: 2 },
        { key: "stats", label: "统计", json: true },
        { key: "version_stats", label: "版本统计", json: true },
        { key: "file_name", label: "源文件名", span: 2 },
        { key: "tags", label: "标签", span: 2 },
        { key: "description", label: "模型说明", multiline: true, span: 2 },
        { key: "version_description", label: "版本说明", multiline: true, span: 2 },
    ];

    function valueFor(info, key) {
        const d = info?.details || {};
        if (key === "url") return info?.url || "";
        if (key === "version") return info?.version || d.version_name || "";
        if (key === "model_version_id") return info?.model_version_id ?? "";
        if (key === "model_id") return info?.model_id ?? "";
        if (key === "model_name") return d.model_name || info?.model_name || "";
        if (key === "hash") return d.hashes?.AutoV2 || d.hashes?.SHA256 || "";
        if (key === "stats") return d.stats && Object.keys(d.stats).length ? JSON.stringify(d.stats, null, 2) : "";
        if (key === "version_stats") return d.version_stats && Object.keys(d.version_stats).length ? JSON.stringify(d.version_stats, null, 2) : "";
        if (key === "tags") return Array.isArray(d.tags) ? d.tags.join(", ") : (d.tags || "");
        if (key === "trained_words") return Array.isArray(d.trained_words) ? d.trained_words.join(", ") : (d.trained_words || "");
        return d[key] ?? "";
    }

    function makeDetailField(def, value) {
        const wrap = el("div");
        Object.assign(wrap.style, {
            display: "grid", gridTemplateColumns: def.multiline ? "1fr" : "132px minmax(0,1fr)", gap: def.multiline ? "6px" : "12px",
            padding: "9px 2px", borderBottom: "1px solid rgba(255,255,255,.08)", alignItems: "start",
            gridColumn: def.span === 2 ? "1 / -1" : "auto", minWidth: "0",
        });
        const lab = el("div", "", def.label);
        lab.style.color = "rgba(255,255,255,.56)";
        wrap.append(lab);

        if (mode === "edit") {
            const control = def.multiline || def.json || def.chips ? document.createElement("textarea") : document.createElement("input");
            if (control.tagName === "INPUT") control.type = "text";
            control.value = value == null ? "" : String(value);
            Object.assign(control.style, {
                width: "100%", minWidth: "0", minHeight: def.multiline ? "116px" : (def.json ? "88px" : (def.chips ? "64px" : "32px")),
                resize: def.multiline || def.json || def.chips ? "vertical" : "none", boxSizing: "border-box", borderRadius: "5px",
                border: "1px solid rgba(255,255,255,.13)", background: "#101214", color: "#e6e6e6",
                padding: def.multiline || def.json || def.chips ? "8px" : "0 8px", outline: "none", fontFamily: "inherit", lineHeight: "1.45",
            });
            editors.set(def.key, control);
            wrap.append(control);
        } else if (def.chips) {
            const chipBox = el("div");
            Object.assign(chipBox.style, { display: "flex", flexWrap: "wrap", gap: "7px", minWidth: "0" });
            const words = String(value || "").split(/[,，\n]+/).map(x => x.trim()).filter(Boolean);
            if (!words.length) {
                const empty = el("div", "", "—"); empty.style.color = "#e5e5e5"; chipBox.append(empty);
            } else {
                for (const word of words) {
                    const chip = el("button", "", `${word}  ⧉`);
                    Object.assign(chip.style, {
                        border: "0", borderRadius: "5px", padding: "6px 9px", background: "#3d315e", color: "#c8a9ff",
                        fontSize: "11px", fontWeight: "700", cursor: "pointer", userSelect: "text",
                    });
                    chip.title = `点击复制触发词：${word}`;
                    chip.onclick = async () => {
                        try { await navigator.clipboard.writeText(word); showToast("触发词", `已复制：${word}`, "success"); }
                        catch (_) { showToast("复制失败", "浏览器未允许剪贴板权限", "error"); }
                    };
                    chipBox.append(chip);
                }
            }
            wrap.append(chipBox);
        } else {
            const val = el("div", "", value == null || value === "" ? "—" : String(value));
            Object.assign(val.style, { color: "#e5e5e5", wordBreak: "break-word", whiteSpace: "pre-wrap", minWidth: "0", userSelect: "text" });
            wrap.append(val);
        }
        return wrap;
    }

    function renderGallery(info) {
        galleryGrid.replaceChildren();
        const previews = info?.previews || [];
        galleryTitle.textContent = `网址示例图片 / 生成信息（${previews.length} 张）`;
        if (!previews.length) {
            const empty = el("div", "", "暂无下载的示例图片。设置 Civitai 网址后点击“获取信息”。");
            Object.assign(empty.style, { color: "rgba(255,255,255,.48)", padding: "18px 4px", gridColumn: "1 / -1" });
            galleryGrid.append(empty);
            return;
        }
        for (const p of previews) {
            const card = el("div");
            Object.assign(card.style, {
                position: "relative", border: "1px solid rgba(255,255,255,.12)", borderRadius: "6px",
                overflow: "hidden", background: "#0f1113", minHeight: "210px",
            });
            const img = new Image(); img.loading = "lazy"; img.src = previewUrl(config.kind, currentName, p.file);
            Object.assign(img.style, { width: "100%", aspectRatio: "2 / 3", objectFit: "contain", display: "block", background: "#0d0f11" });
            const infoBtn = el("button", "", "ⓘ");
            Object.assign(infoBtn.style, {
                position: "absolute", right: "7px", bottom: "7px", width: "30px", height: "30px", borderRadius: "50%",
                border: "1px solid rgba(255,255,255,.65)", background: "rgba(0,0,0,.70)", color: "#fff", cursor: "pointer",
                fontSize: "17px", padding: "0",
            });
            infoBtn.title = "查看 / 复制生成信息";
            infoBtn.onclick = (e) => { e.stopPropagation(); openMetaPopup(p.meta || {}); };
            card.append(img, infoBtn); galleryGrid.append(card);
        }
    }

    function renderInfo(info) {
        currentInfo = info || {};
        title.textContent = currentName;
        modelNameLabel.textContent = basename(currentName);
        cover.src = coverUrl(config.kind, currentName, Date.now());
        cover.onerror = () => {
            cover.removeAttribute("src");
            cover.style.background = "linear-gradient(145deg,#282b2f,#141619)";
        };
        editors.clear();
        infoRows.replaceChildren();
        for (const def of fieldDefs) infoRows.append(makeDetailField(def, valueFor(currentInfo, def.key)));
        note.value = currentInfo?.user_note || "";
        openUrlBtn.disabled = !currentInfo?.url;
        renderGallery(currentInfo);
    }

    async function loadNetworkStatus() {
        try {
            const data = await apiJson("/browser_loader/network_settings");
            proxyStatus.textContent = `网络：${data.display || "直连"}`;
            proxyStatus.title = data.proxy_url
                ? `已保存代理：${data.proxy_url}`
                : "未保存固定代理；将自动读取系统代理或检测常见本地代理端口。";
            return data;
        } catch (e) {
            proxyStatus.textContent = `网络检测失败：${e.message}`;
            return null;
        }
    }

    async function loadDetail(name) {
        currentName = name;
        modelNameLabel.textContent = basename(name);
        title.textContent = name;
        fetchStatus.textContent = "";
        try {
            const data = await apiJson(`/browser_loader/detail?kind=${encodeURIComponent(config.kind)}&name=${encodeURIComponent(name)}`);
            renderInfo(data.info || {});
        } catch (e) {
            renderInfo({ url: "", version: "", details: {}, user_note: "", previews: [] });
            fetchStatus.textContent = `详情读取失败：${e.message}`;
            showToast("模型详情读取失败", e.message, "error");
        }
    }

    function editorValue(key, fallback = "") {
        return editors.get(key)?.value ?? fallback;
    }

    function parseJsonEditor(key, label, fallback = {}) {
        const raw = editorValue(key, "").trim();
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
            throw new Error("必须是 JSON 对象");
        } catch (e) {
            throw new Error(`${label}格式错误：${e.message}`);
        }
    }

    function buildSavePayload() {
        const d0 = currentInfo?.details || {};
        const hashes = { ...(d0.hashes || {}) };
        const hashText = editorValue("hash", valueFor(currentInfo, "hash")).trim();
        if (hashText) hashes.AutoV2 = hashText;
        else delete hashes.AutoV2;
        return {
            kind: config.kind,
            name: currentName,
            url: editorValue("url", currentInfo?.url || "").trim(),
            version: editorValue("version", currentInfo?.version || ""),
            model_version_id: editorValue("model_version_id", currentInfo?.model_version_id ?? ""),
            model_id: editorValue("model_id", currentInfo?.model_id ?? ""),
            user_note: note.value,
            details: {
                ...d0,
                model_name: editorValue("model_name", valueFor(currentInfo, "model_name")),
                type: editorValue("type", valueFor(currentInfo, "type")),
                version_name: editorValue("version", valueFor(currentInfo, "version")),
                base_model: editorValue("base_model", valueFor(currentInfo, "base_model")),
                base_model_type: editorValue("base_model_type", valueFor(currentInfo, "base_model_type")),
                trained_words: editorValue("trained_words", valueFor(currentInfo, "trained_words")).split(/[,，\n]+/).map(x => x.trim()).filter(Boolean),
                published: editorValue("published", valueFor(currentInfo, "published")),
                creator: editorValue("creator", valueFor(currentInfo, "creator")),
                air: editorValue("air", valueFor(currentInfo, "air")),
                hashes,
                stats: parseJsonEditor("stats", "统计", d0.stats || {}),
                version_stats: parseJsonEditor("version_stats", "版本统计", d0.version_stats || {}),
                file_name: editorValue("file_name", valueFor(currentInfo, "file_name")),
                tags: editorValue("tags", valueFor(currentInfo, "tags")).split(/[,，\n]+/).map(x => x.trim()).filter(Boolean),
                description: editorValue("description", valueFor(currentInfo, "description")),
                version_description: editorValue("version_description", valueFor(currentInfo, "version_description")),
            },
        };
    }

    openUrlBtn.onclick = () => {
        const url = mode === "edit" ? editorValue("url", currentInfo?.url || "").trim() : currentInfo?.url;
        if (url) window.open(url, "_blank", "noopener,noreferrer");
    };

    setUrlBtn.onclick = async () => {
        const defaultUrl = mode === "edit" ? editorValue("url", currentInfo?.url || "") : (currentInfo?.url || "");
        const value = window.prompt("输入该模型的 Civitai 网址：", defaultUrl);
        if (value === null) return;
        try {
            const data = await apiJson("/browser_loader/set_url", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: config.kind, name: currentName, url: value.trim() }),
            });
            renderInfo(data.info || {});
            fetchStatus.textContent = "网址已保存。";
        } catch (e) {
            fetchStatus.textContent = `设置网址失败：${e.message}`;
            showToast("设置网址失败", e.message, "error");
        }
    };

    proxyBtn.onclick = async () => {
        let current = null;
        try { current = await apiJson("/browser_loader/network_settings"); } catch (_) {}
        const saved = current?.proxy_url || "";
        const suggested = saved || current?.effective_proxy || "http://127.0.0.1:7890";
        const message = [
            "设置 Civitai 本地 HTTP/HTTPS 代理。",
            "例如 Clash / V2Ray 的 HTTP 或 Mixed 端口：",
            "http://127.0.0.1:7890",
            "",
            "也可以只输入 127.0.0.1:7890。",
            "留空 = 自动读取系统代理并检测常见本地端口。",
        ].join("\n");
        const value = window.prompt(message, saved || suggested);
        if (value === null) return;
        proxyBtn.disabled = true;
        const oldText = proxyBtn.textContent;
        proxyBtn.textContent = "正在测试…";
        try {
            const savedData = await apiJson("/browser_loader/network_settings", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ proxy_url: value.trim() }),
            });
            proxyStatus.textContent = `网络：${savedData.display || "直连"}`;
            const tested = await apiJson("/browser_loader/test_network", { method: "POST" });
            proxyStatus.textContent = `网络：${tested.display || savedData.display || "直连"} · Civitai 可访问`;
            showToast("代理设置", `Civitai 连接测试成功：${tested.display || "直连"}`, "success");
        } catch (e) {
            await loadNetworkStatus();
            showToast("代理 / 网络测试失败", e.message, "error");
            fetchStatus.textContent = e.message;
        } finally {
            proxyBtn.disabled = false;
            proxyBtn.textContent = oldText;
        }
    };

    getInfoBtn.onclick = async () => {
        let url = mode === "edit" ? editorValue("url", currentInfo?.url || "").trim() : (currentInfo?.url || "");
        if (!url) {
            const value = window.prompt("先输入该模型的 Civitai 网址：", "");
            if (value === null || !value.trim()) return;
            url = value.trim();
        }
        const old = getInfoBtn.textContent;
        getInfoBtn.disabled = true; setUrlBtn.disabled = true; saveAll.disabled = true;
        getInfoBtn.textContent = "正在获取…";
        fetchStatus.textContent = "正在从 Civitai API 读取模型、版本和示例图片信息…";
        try {
            const data = await apiJson("/browser_loader/get_info", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: config.kind, name: currentName, url }),
            });
            renderInfo(data.info || {});
            const networkText = data.network?.display ? `，网络：${data.network.display}` : "";
            const showcaseCount = Number(data.info?.details?.showcase_count || 0);
            const countText = showcaseCount
                ? `识别 ${showcaseCount} 张 Showcase，成功保存 ${data.downloaded || 0} 张`
                : `保存 ${data.downloaded || 0} 张示例图片`;
            fetchStatus.textContent = `获取完成：Model ID ${data.info?.model_id ?? "—"} / Version ID ${data.info?.model_version_id ?? "—"}，${countText}${networkText}。`;
            if (data.network?.display) proxyStatus.textContent = `网络：${data.network.display}`;
            showToast("获取完成", `模型详情已补齐，${countText}并保存生成信息。`, "success");
        } catch (e) {
            fetchStatus.textContent = `获取信息失败：${e.message}`;
            showToast("获取信息失败", e.message, "error");
        } finally {
            getInfoBtn.disabled = false; setUrlBtn.disabled = false; saveAll.disabled = false; getInfoBtn.textContent = old;
        }
    };

    saveAll.onclick = async () => {
        if (mode !== "edit") return;
        try {
            const payload = buildSavePayload();
            const data = await apiJson("/browser_loader/save_detail", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            renderInfo(data.info || {});
            fetchStatus.textContent = "模型详情和注释已保存到与模型同名的 TXT 文档。";
            showToast("EDOU BrowserLoader", "模型详情和注释已保存。", "success");
        } catch (e) {
            fetchStatus.textContent = `保存失败：${e.message}`;
            showToast("保存模型详情失败", e.message, "error");
        }
    };

    await Promise.all([loadDetail(initialName), loadNetworkStatus()]);
    if (mode === "edit") setTimeout(() => editors.get("url")?.focus(), 80);
}

app.registerExtension({
    name: EXTENSION_NAME,
    async nodeCreated(node) {
        const config = MODEL_CONFIGS[node.comfyClass];
        if (!config) return;
        const modelWidget = node.widgets?.find(w => w.name === config.modelWidget);
        if (!modelWidget) return;

        node.properties ||= {};
        let previewSize = Math.max(80, Math.min(220, Number(node.properties.edou_preview_size || 112)));

        // Keep the backend input key unchanged (strength_model) while presenting
        // the user-facing label requested for the EDOU LoRA node.  New installs
        // expose the backend input as Lora_strength; keep a fallback for workflows
        // created with the previous package revision.
        if (config.kind === "lora") {
            const strengthWidget = node.widgets?.find(w => w.name === "Lora_strength" || w.name === "strength_model");
            if (strengthWidget) {
                strengthWidget.label = "Lora_strength";
                strengthWidget.options ||= {};
                strengthWidget.options.label = "Lora_strength";
            }
        }

        const root = el("div");
        Object.assign(root.style, {
            height: "100%", minHeight: "0", display: "flex", flexDirection: "column", gap: "9px",
            padding: "10px", boxSizing: "border-box", color: "#eee", fontFamily: "Arial, 'Microsoft YaHei', sans-serif",
            background: "rgba(0,0,0,.10)", borderRadius: "8px", overflow: "hidden",
        });
        const selectStyle = document.createElement("style");
        selectStyle.textContent = `
            .edou-dark-select { color-scheme: dark !important; background:#2b2b2b !important; color:#f1f1f1 !important; }
            .edou-dark-select option { background:#2b2b2b !important; color:#f1f1f1 !important; }
            .edou-dark-select option:checked { background:#454545 !important; color:#ffffff !important; }
        `;
        root.append(selectStyle);

        const filters = el("div");
        Object.assign(filters.style, { display: "grid", gap: "8px", gridTemplateColumns: config.hierarchical ? "1fr 1fr 1fr 1.55fr" : "170px minmax(0,1fr)", flex: "0 0 auto" });
        const folderSelect = makeSelect("文件夹过滤");
        const level1 = makeSelect("一级目录 / 基础模型");
        const level2 = makeSelect("二级目录 / 文件路径");
        const level3 = makeSelect("剩余路径");
        const search = document.createElement("input"); search.type = "search"; search.placeholder = "搜索…";
        Object.assign(search.style, { height: "31px", minWidth: "0", border: "1px solid rgba(255,255,255,.13)", borderRadius: "16px", background: "#08090a", color: "#eee", padding: "0 13px", outline: "none", fontSize: "11px" });
        if (config.hierarchical) filters.append(level1, level2, level3, search); else filters.append(folderSelect, search);

        const zoomRow = el("div");
        Object.assign(zoomRow.style, {
            display: "grid", gridTemplateColumns: "72px minmax(0,1fr) 48px", gap: "9px", alignItems: "center",
            flex: "0 0 auto", minWidth: "0", padding: "0 2px",
        });
        const zoomLabel = el("div", "", "预览缩放");
        Object.assign(zoomLabel.style, { fontSize: "11px", color: "rgba(255,255,255,.70)", whiteSpace: "nowrap" });
        const zoomSlider = document.createElement("input");
        zoomSlider.type = "range"; zoomSlider.min = "80"; zoomSlider.max = "220"; zoomSlider.step = "4"; zoomSlider.value = String(previewSize);
        Object.assign(zoomSlider.style, { width: "100%", minWidth: "0", accentColor: "#58a6ff", cursor: "pointer" });
        const zoomValue = el("div", "", `${previewSize}px`);
        Object.assign(zoomValue.style, { textAlign: "right", fontSize: "11px", color: "rgba(255,255,255,.70)" });
        zoomRow.append(zoomLabel, zoomSlider, zoomValue);

        const selectedBar = el("div", "", basename(modelWidget.value || ""));
        Object.assign(selectedBar.style, { height: "38px", lineHeight: "38px", textAlign: "center", fontSize: "12px", border: "1px solid rgba(255,255,255,.10)", borderRadius: "5px", background: "rgba(0,0,0,.24)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "0 8px", flex: "0 0 auto" });

        const grid = el("div");
        Object.assign(grid.style, { flex: "1 1 auto", minHeight: "0", overflowY: "auto", display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${previewSize}px,1fr))`, gridAutoRows: "max-content", gap: "10px", padding: "5px 4px", alignContent: "start", scrollbarWidth: "thin" });

        const buttons = el("div"); Object.assign(buttons.style, { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", flex: "0 0 auto" });
        const viewBtn = el("button", "", "查看注释"); styleButton(viewBtn, false);
        const editBtn = el("button", "", "修改注释"); styleButton(editBtn, true);
        buttons.append(viewBtn, editBtn);
        root.append(filters, zoomRow, selectedBar, grid, buttons);

        const widget = node.addDOMWidget?.("edou_model_browser", "edou_model_browser", root, {
            serialize: false, hideOnZoom: false, getMinHeight: () => MODEL_BROWSER_HEIGHT,
        });
        if (widget?.options) widget.options.getMinHeight = () => MODEL_BROWSER_HEIGHT;

        let items = [];
        let selectedName = String(modelWidget.value || "");
        let l1 = node.properties.edou_lora_l1 || "";
        let l2 = node.properties.edou_lora_l2 || "";
        let l3 = node.properties.edou_lora_l3 || "";
        let folderFilter = node.properties.edou_folder_filter || "";

        function applyPreviewSize() {
            grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${previewSize}px,1fr))`;
            zoomValue.textContent = `${previewSize}px`;
            node.properties.edou_preview_size = previewSize;
            node.graph?.setDirtyCanvas?.(true, true);
        }

        zoomSlider.oninput = () => {
            previewSize = Math.max(80, Math.min(220, Number(zoomSlider.value || 112)));
            applyPreviewSize();
        };

        function setWidgetValue(value) {
            modelWidget.value = value;
            selectedName = String(value || "");
            selectedBar.textContent = basename(selectedName);
            selectedBar.title = selectedName;
            if (typeof modelWidget.callback === "function") {
                try { modelWidget.callback(value, app.canvas, node, app.canvas?.graph_mouse); } catch (_) {}
            }
            node.graph?.setDirtyCanvas?.(true, true);
            render();
        }

        function rebuildLoraFilters() {
            if (!config.hierarchical) return;
            const firsts = uniqueSorted(items.map(x => norm(x.folder).split("/").filter(Boolean)[0] || ""));
            if (l1 && !firsts.includes(l1)) { l1 = ""; l2 = ""; l3 = ""; }
            fillSelect(level1, firsts, l1, "一级目录 / 全部");

            const seconds = l1 ? descendantsAtDepth(items, l1, 1) : [];
            if (l2 && !seconds.includes(l2)) { l2 = ""; l3 = ""; }
            fillSelect(level2, seconds, l2, l1 ? "二级目录 / 全部" : "先选择一级目录");
            level2.disabled = !l1;

            let thirdPaths = [];
            if (l1 && l2) {
                const prefix = `${l1}/${l2}`;
                thirdPaths = uniqueSorted(items.map(x => {
                    const f = norm(x.folder);
                    if (f === prefix) return "";
                    return f.startsWith(prefix + "/") ? f.slice(prefix.length + 1) : "";
                }));
            }
            if (l3 && !thirdPaths.includes(l3)) l3 = "";
            fillSelect(level3, thirdPaths, l3, l1 && l2 ? "剩余路径 / 全部" : "先选择二级目录");
            level3.disabled = !(l1 && l2);
        }

        function loraCurrentPath() {
            return [l1, l2, l3].filter(Boolean).join("/");
        }

        function setLoraFolderPath(path) {
            const parts = norm(path).split("/").filter(Boolean);
            l1 = parts[0] || "";
            l2 = parts[1] || "";
            l3 = parts.slice(2).join("/");
            node.properties.edou_lora_l1 = l1;
            node.properties.edou_lora_l2 = l2;
            node.properties.edou_lora_l3 = l3;
            rebuildLoraFilters();
            render();
        }

        function currentFolderPath() {
            return config.hierarchical ? loraCurrentPath() : norm(folderFilter);
        }

        function immediateFolders(currentPath) {
            const current = norm(currentPath);
            const prefix = current ? `${current}/` : "";
            const names = [];
            for (const item of items) {
                const folder = norm(item.folder);
                if (current) {
                    if (!folder.startsWith(prefix)) continue;
                    const rest = folder.slice(prefix.length);
                    if (!rest) continue;
                    const child = rest.split("/")[0];
                    if (child) names.push(child);
                } else {
                    const child = folder.split("/").filter(Boolean)[0];
                    if (child) names.push(child);
                }
            }
            return uniqueSorted(names).map(name => ({ name, path: current ? `${current}/${name}` : name }));
        }

        function rebuildFolderFilter() {
            if (config.hierarchical) return;
            const folders = allFolderPaths(items);
            if (folderFilter && !folders.includes(norm(folderFilter))) folderFilter = "";
            fillSelect(folderSelect, folders, norm(folderFilter), "根目录");
        }

        function setFolderPath(path) {
            if (config.hierarchical) {
                setLoraFolderPath(path);
                return;
            }
            folderFilter = norm(path);
            node.properties.edou_folder_filter = folderFilter;
            rebuildFolderFilter();
            folderSelect.value = folderFilter;
            render();
        }

        function filteredItems() {
            const q = search.value.trim().toLocaleLowerCase();
            const current = currentFolderPath();
            return items.filter(item => {
                // File-manager behaviour for UNET, Checkpoint and LoRA alike:
                // only models directly inside the selected folder are shown.
                // Descendant folders are represented by folder cards.
                if (norm(item.folder) !== current) return false;
                return !q || `${item.path} ${item.display_name}`.toLocaleLowerCase().includes(q);
            });
        }

        function render() {
            grid.replaceChildren();
            const visible = filteredItems();
            const q = search.value.trim().toLocaleLowerCase();
            const folders = immediateFolders(currentFolderPath()).filter(folder =>
                !q || `${folder.name} ${folder.path}`.toLocaleLowerCase().includes(q)
            );

            if (!visible.length && !folders.length) {
                const empty = el("div", "", "当前文件夹没有匹配模型或子文件夹");
                Object.assign(empty.style, { gridColumn: "1/-1", padding: "30px", textAlign: "center", color: "rgba(255,255,255,.45)" });
                grid.append(empty); return;
            }
            const frag = document.createDocumentFragment();
            for (const folder of folders) frag.append(makeFolderCard(folder.name, folder.path, setFolderPath));
            for (const item of visible) frag.append(makeModelCard(item, config, selectedName, setWidgetValue));
            grid.append(frag);
        }

        async function reload() {
            grid.replaceChildren(el("div", "", "正在读取模型…"));
            try {
                const data = await apiJson(`/browser_loader/models?kind=${encodeURIComponent(config.kind)}`);
                items = data.items || [];
                rebuildLoraFilters(); rebuildFolderFilter(); render();
            } catch (e) {
                grid.replaceChildren(el("div", "", `读取失败：${e.message}`));
            }
        }

        if (config.hierarchical) {
            level1.onchange = () => { l1 = level1.value; l2 = ""; l3 = ""; node.properties.edou_lora_l1 = l1; node.properties.edou_lora_l2 = ""; node.properties.edou_lora_l3 = ""; rebuildLoraFilters(); render(); };
            level2.onchange = () => { l2 = level2.value; l3 = ""; node.properties.edou_lora_l2 = l2; node.properties.edou_lora_l3 = ""; rebuildLoraFilters(); render(); };
            level3.onchange = () => { l3 = level3.value; node.properties.edou_lora_l3 = l3; render(); };
        } else {
            folderSelect.onchange = () => setFolderPath(folderSelect.value);
        }
        search.oninput = render;
        viewBtn.onclick = () => openModelDetail(config, String(modelWidget.value || selectedName || ""), "view", setWidgetValue, items);
        editBtn.onclick = () => openModelDetail(config, String(modelWidget.value || selectedName || ""), "edit", setWidgetValue, items);

        // Keep the card browser in sync if the user changes the normal ComfyUI
        // combo widget at the top of the node.
        const originalCallback = modelWidget.callback;
        modelWidget.callback = function(...args) {
            const result = originalCallback?.apply(this, args);
            selectedName = String(modelWidget.value || "");
            selectedBar.textContent = basename(selectedName);
            selectedBar.title = selectedName;
            render();
            return result;
        };

        const oldOnResize = node.onResize?.bind(node);
        node.onResize = function(size) {
            if (size[0] < MIN_NODE_WIDTH) size[0] = MIN_NODE_WIDTH;
            return oldOnResize?.(size);
        };
        if (node.size?.[0] < MIN_NODE_WIDTH) node.size[0] = MIN_NODE_WIDTH;
        const needed = Math.max(node.size?.[1] || 0, config.hierarchical ? 690 : 650);
        node.setSize?.([Math.max(node.size?.[0] || MIN_NODE_WIDTH, MIN_NODE_WIDTH), needed]);

        await reload();
    },
});
