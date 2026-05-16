import { ASSET_DRAG_TYPE, createImageStore, isLibraryAssetFile } from "./markdown-images.js";
import { createPdfBuilder } from "./wasm-pdf.js";
import { replaceRefs } from "./compiler-utils.js";

const STORAGE_KEYS = {
  markdown: "md2pdf-content",
  noPageNumbers: "md2pdf-no-page-numbers",
  useSourceSans: "md2pdf-use-source-sans"
};

const DEFAULT_MARKDOWN = `# Fast Tour

> A compact sample that exercises the main rendering features.

![Markdown mark](https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Markdown-mark.svg/330px-Markdown-mark.svg.png =200x)

- [x] Task lists
- [x] **Bold**, _italic_, and [links](https://pandoc.org/)
- [ ] Replace this sample with your own document

| Feature | Example |
| --- | --- |
| Inline math | $E = mc^2$ |
| Code | \`npm run build\` |
| Quote | See the intro above |

:::info
This PDF is produced locally with Pandoc and SwiftLaTeX.
:::

1. Write markdown.
2. Build the PDF.
3. Download or keep editing.

\`\`\`js
const total = [2, 4, 6].reduce((sum, value) => sum + value, 0);
\`\`\`

$$
\int_0^1 x^2\,dx = \\frac{1}{3}
$$

### Other features to test
- Images (try dragging some into the library on the right)
- Page numbers (toggle the checkbox below)
- And
  - much
    - more
`;

const el = (id) => document.getElementById(id);

const elements = {
  buildBtn: el("buildBtn"),
  downloadBtn: el("downloadBtn"),
  errorLogs: el("errorLogs"),
  errorModal: el("errorModal"),
  errorModalClose: el("errorModalClose"),
  imageLibrary: el("imageLibrary"),
  libraryDropzone: el("libraryDropzone"),
  libraryFileInput: el("libraryFileInput"),
  markdown: el("markdown"),
  noPageNumbers: el("noPageNumbers"),
  pdfFrame: el("pdfFrame"),
  resetWorkspaceBtn: el("resetWorkspaceBtn"),
  status: el("status"),
  useSourceSans: el("useSourceSans")
};

let easyMDE = null;
let isBuilding = false;
let currentPdfUrl = "";
let draggedAssetId = "";
let activeAliasTargetId = "";

const pdfBuilder = createPdfBuilder();
const imageStore = createImageStore({ onChange: renderLibrary });

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

async function init() {
  initEditor();
  restorePreferences();
  bindEvents();
  try {
    await imageStore.restore();
  } catch (error) {
    console.warn("Unable to restore image library", error);
  }

  setStatus("Loading local PDF engine...");
  elements.buildBtn.disabled = true;

  try {
    await pdfBuilder.prepare();
    setStatus("Ready");
  } catch (error) {
    console.error(error);
    setStatus("Engine failed to load");
    showBuildError(error);
  } finally {
    elements.buildBtn.disabled = false;
  }
}

function initEditor() {
  if (!window.EasyMDE || !window.CodeMirror || !elements.markdown) {
    return;
  }

  try {
    localStorage.removeItem("md2pdf-editor");
  } catch (_) {
    // Ignore stale EasyMDE autosave state.
  }

  try {
    easyMDE = new EasyMDE({
      element: elements.markdown,
      autofocus: true,
      spellChecker: false,
      status: false,
      toolbar: false,
      sideBySideFullscreen: false,
      autoDownloadFontAwesome: false,
      forceSync: true,
      renderingConfig: {
        singleLineBreaks: false,
        codeSyntaxHighlighting: true
      },
      codemirror: {
        mode: {
          name: "gfm",
          fencedCodeBlockHighlighting: true,
          highlightFormatting: false,
          tokenTypeOverrides: { code: "atom" }
        },
        lineNumbers: false,
        lineWrapping: true,
        extraKeys: {
          "Ctrl-Enter": () => buildPdf()
        }
      },
      shortcuts: {
        toggleSideBySide: null,
        toggleFullScreen: null,
        togglePreview: null
      }
    });
  } catch (error) {
    console.error("EasyMDE init failed, falling back to textarea", error);
    easyMDE = null;
  }

  const saved = safeStorageGet(STORAGE_KEYS.markdown);
  const initialValue = saved || DEFAULT_MARKDOWN;
  setMarkdown(initialValue);

  if (easyMDE) {
    easyMDE.codemirror.on("change", persistMarkdown);
  } else {
    elements.markdown.addEventListener("input", persistMarkdown);
  }

  persistMarkdown();
}

function bindEvents() {
  elements.buildBtn.addEventListener("click", buildPdf);
  elements.resetWorkspaceBtn.addEventListener("click", resetWorkspace);
  elements.libraryFileInput.addEventListener("change", async (event) => {
    await addIncomingFiles(event.target.files);
    event.target.value = "";
  });

  bindDropzoneEvents();
  bindLibraryDragEvents();

  elements.noPageNumbers.addEventListener("change", () => {
    safeStorageSet(STORAGE_KEYS.noPageNumbers, String(elements.noPageNumbers.checked));
  });

  elements.useSourceSans.addEventListener("change", () => {
    safeStorageSet(STORAGE_KEYS.useSourceSans, String(elements.useSourceSans.checked));
  });

  elements.errorModalClose.addEventListener("click", closeErrorModal);
  elements.errorModal.addEventListener("click", (event) => {
    if (event.target === elements.errorModal) {
      closeErrorModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeErrorModal();
      return;
    }

    if (event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      buildPdf();
    }
  });

  window.addEventListener("beforeunload", cleanupObjectUrls);
}

function bindDropzoneEvents() {
  const activate = () => elements.libraryDropzone.classList.add("is-active");
  const deactivate = () => elements.libraryDropzone.classList.remove("is-active");

  elements.libraryDropzone.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.files?.length) {
      return;
    }

    event.preventDefault();
    activate();
  });

  elements.libraryDropzone.addEventListener("dragleave", deactivate);
  elements.libraryDropzone.addEventListener("drop", async (event) => {
    event.preventDefault();
    deactivate();
    await addIncomingFiles(event.dataTransfer?.files);
  });

  elements.libraryDropzone.addEventListener("paste", async (event) => {
    const files = getClipboardFiles(event.clipboardData);
    if (!files.length) {
      return;
    }

    event.preventDefault();
    await addIncomingFiles(files);
  });

  elements.libraryDropzone.addEventListener("dblclick", () => {
    elements.libraryFileInput.click();
  });
}

function bindLibraryDragEvents() {
  elements.imageLibrary.addEventListener("click", async (event) => {
    const deleteButton = event.target.closest("[data-remove-id]");
    if (!deleteButton) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const removed = await imageStore.removeEntry(deleteButton.dataset.removeId);
    if (removed) {
      setStatus("Removed file from library");
    }
  });

  elements.imageLibrary.addEventListener("dragstart", (event) => {
    if (event.target.closest(".library-delete")) {
      event.preventDefault();
      return;
    }

    const card = event.target.closest("[data-asset-id]");
    if (!card) {
      return;
    }

    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(ASSET_DRAG_TYPE, card.dataset.assetId);
    draggedAssetId = card.dataset.assetId;
    card.classList.add("is-dragging");
    elements.imageLibrary.classList.add("is-aliasing");
  });

  elements.imageLibrary.addEventListener("dragend", (event) => {
    const card = event.target.closest("[data-asset-id]");
    if (card) {
      card.classList.remove("is-dragging");
    }

    resetAliasDragState();
  });

  elements.imageLibrary.addEventListener("dragover", (event) => {
    const unresolvedCard = event.target.closest("[data-unresolved-id]");
    const types = Array.from(event.dataTransfer?.types || []);
    const hasAsset = draggedAssetId || types.includes(ASSET_DRAG_TYPE);
    const hasFiles = Boolean(event.dataTransfer?.files?.length);
    if (!unresolvedCard || (!hasAsset && !hasFiles)) {
      if (!unresolvedCard) {
        setAliasDropTarget("");
      }
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setAliasDropTarget(unresolvedCard.dataset.unresolvedId);
  });

  elements.imageLibrary.addEventListener("dragleave", (event) => {
    const unresolvedCard = event.target.closest("[data-unresolved-id]");
    if (!unresolvedCard) {
      return;
    }

    const relatedTarget = event.relatedTarget;
    if (relatedTarget && unresolvedCard.contains(relatedTarget)) {
      return;
    }

    setAliasDropTarget("");
  });

  elements.imageLibrary.addEventListener("drop", async (event) => {
    const unresolvedCard = event.target.closest("[data-unresolved-id]");
    if (!unresolvedCard) {
      resetAliasDragState();
      return;
    }

    event.preventDefault();
    const assetId = draggedAssetId || event.dataTransfer?.getData(ASSET_DRAG_TYPE);
    const fileList = Array.from(event.dataTransfer?.files || []);
    resetAliasDragState();

    if (!assetId && fileList.length) {
      const added = await addIncomingFiles(fileList);
      const uploaded = added?.assets?.[0];
      if (uploaded) {
        imageStore.assignAlias(unresolvedCard.dataset.unresolvedId, uploaded.id);
        setStatus(`Added and aliased ${unresolvedCard.dataset.aliasName}`);
      }
      return;
    }

    if (!assetId) {
      return;
    }

    imageStore.assignAlias(unresolvedCard.dataset.unresolvedId, assetId);
    setStatus(`Aliased ${unresolvedCard.dataset.aliasName} to library file`);
  });
}

async function buildPdf() {
  if (isBuilding) {
    return;
  }

  isBuilding = true;
  elements.buildBtn.disabled = true;
  closeErrorModal();

  try {
    await pdfBuilder.prepare();

    const sourceMarkdown = getMarkdown();
    const refs = replaceRefs(sourceMarkdown);
    setStatus("Resolving library files...");
    const resolved = await imageStore.resolveMarkdown(refs.txt);

    if (refs.bib) {
      resolved.mediaFiles["bib.bib"] = new Blob([refs.bib], { type: "text/plain" });
    }

    const result = await pdfBuilder.build({
      markdown: resolved.markdown,
      hidePageNumbers: elements.noPageNumbers.checked,
      useSourceSans: elements.useSourceSans.checked,
      mediaFiles: resolved.mediaFiles,
      onStage: setStatus
    });

    updatePdfPreview(result.pdfBlob);
    setStatus("Built PDF");
  } catch (error) {
    console.error(error);
    setStatus("Build failed");
    showBuildError(error);
  } finally {
    isBuilding = false;
    elements.buildBtn.disabled = false;
  }
}

function renderLibrary(snapshot) {
  const fragment = document.createDocumentFragment();

  if (!snapshot.assets.length && !snapshot.unresolved.length) {
    const empty = document.createElement("div");
    empty.className = "library-empty";
    empty.textContent = "Stored files will appear here.";
    fragment.appendChild(empty);
  }

  for (const asset of snapshot.assets) {
    const aliasText = asset.aliases.length > 1
      ? `Aliases: ${asset.aliases.slice(1).join(", ")}`
      : "Stored in browser";

    fragment.appendChild(createCard({
      badge: asset.source === "download" ? "web" : "file",
      detail: aliasText,
      draggable: true,
      id: asset.id,
      imgSrc: asset.previewUrl,
      mime: asset.blob.type,
      kind: "asset",
      subtitle: asset.generatedName,
      title: asset.originalName
    }));
  }

  for (const unresolved of snapshot.unresolved) {
    fragment.appendChild(createCard({
      badge: "missing",
      detail: unresolved.sourceUrl,
      draggable: false,
      id: unresolved.id,
      imgSrc: unresolved.previewUrl,
      mime: unresolved.blob.type,
      kind: "unresolved",
      subtitle: "CORS blocked the remote image. Add or drop the matching file here.",
      title: unresolved.aliasName
    }));
  }

  elements.imageLibrary.replaceChildren(fragment);
}

function createCard({ badge, detail, draggable, id, imgSrc, kind, mime, subtitle, title }) {
  const card = document.createElement("article");
  card.className = `library-item is-${kind}`;
  card.draggable = draggable;

  if (kind === "asset") {
    card.dataset.assetId = id;
  } else {
    card.dataset.unresolvedId = id;
    card.dataset.aliasName = title;
  }

  const thumb = document.createElement("div");
  thumb.className = "library-thumb";

  if (String(mime || "").toLowerCase().split(";")[0].trim() === "application/pdf") {
    const label = document.createElement("span");
    label.className = "library-thumb-label";
    label.textContent = "PDF";
    thumb.appendChild(label);
  } else {
    const image = document.createElement("img");
    image.src = imgSrc;
    image.alt = title;
    thumb.appendChild(image);
  }

  const body = document.createElement("div");
  body.className = "library-body";

  const header = document.createElement("div");
  header.className = "library-title-row";

  const name = document.createElement("strong");
  name.className = "library-title";
  name.textContent = title;

  const deleteButton = document.createElement("button");
  deleteButton.className = "library-delete";
  deleteButton.dataset.removeId = id;
  deleteButton.type = "button";
  deleteButton.title = "Remove file";
  deleteButton.textContent = "x";

  header.append(name, deleteButton);

  const metaRow = document.createElement("div");
  metaRow.className = "library-meta-row";

  const badgeEl = document.createElement("span");
  badgeEl.className = `library-badge badge-${kind}`;
  badgeEl.textContent = badge;
  metaRow.appendChild(badgeEl);

  const subtitleEl = document.createElement("p");
  subtitleEl.className = "library-subtitle";
  subtitleEl.textContent = subtitle;

  const detailEl = document.createElement("p");
  detailEl.className = "library-detail";
  detailEl.textContent = detail;

  body.append(header, metaRow, subtitleEl, detailEl);
  card.append(thumb, body);
  return card;
}

async function addIncomingFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) {
    return null;
  }

  const added = await imageStore.addFiles(files);
  if (added.count) {
    setStatus(`Added ${added.count} file${added.count === 1 ? "" : "s"}`);
  } else {
    setStatus("No supported files found");
  }

  return added;
}

function setAliasDropTarget(unresolvedId) {
  if (activeAliasTargetId === unresolvedId) {
    return;
  }

  if (activeAliasTargetId) {
    const current = elements.imageLibrary.querySelector(`[data-unresolved-id="${activeAliasTargetId}"]`);
    current?.classList.remove("is-drop-target");
  }

  activeAliasTargetId = unresolvedId;
  if (!unresolvedId) {
    return;
  }

  const next = elements.imageLibrary.querySelector(`[data-unresolved-id="${unresolvedId}"]`);
  next?.classList.add("is-drop-target");
}

function resetAliasDragState() {
  draggedAssetId = "";
  elements.imageLibrary.classList.remove("is-aliasing");
  setAliasDropTarget("");
}

function restorePreferences() {
  elements.noPageNumbers.checked = safeStorageGet(STORAGE_KEYS.noPageNumbers) === "true";
  elements.useSourceSans.checked = safeStorageGet(STORAGE_KEYS.useSourceSans) === "true";
}

function updatePdfPreview(blob) {
  if (currentPdfUrl) {
    URL.revokeObjectURL(currentPdfUrl);
  }

  currentPdfUrl = URL.createObjectURL(blob);
  elements.pdfFrame.src = currentPdfUrl;
  elements.downloadBtn.href = currentPdfUrl;
  elements.downloadBtn.hidden = false;
}

function clearPdfPreview() {
  if (currentPdfUrl) {
    URL.revokeObjectURL(currentPdfUrl);
    currentPdfUrl = "";
  }

  elements.pdfFrame.removeAttribute("src");
  elements.downloadBtn.removeAttribute("href");
  elements.downloadBtn.hidden = true;
}

async function resetWorkspace() {
  if (!window.confirm("Clear the stored document and image library?")) {
    return;
  }

  clearPdfPreview();
  closeErrorModal();
  setMarkdown("");
  safeStorageRemove(STORAGE_KEYS.markdown);
  safeStorageRemove(STORAGE_KEYS.noPageNumbers);
  safeStorageRemove(STORAGE_KEYS.useSourceSans);
  elements.noPageNumbers.checked = false;
  elements.useSourceSans.checked = false;
  await imageStore.reset();
  setStatus("Started fresh");
}

function cleanupObjectUrls() {
  clearPdfPreview();
  imageStore.dispose();
}

function persistMarkdown() {
  safeStorageSet(STORAGE_KEYS.markdown, getMarkdown());
}

function getMarkdown() {
  return easyMDE ? easyMDE.value() : elements.markdown.value;
}

function setMarkdown(value) {
  if (easyMDE) {
    easyMDE.value(value);
    return;
  }

  elements.markdown.value = value;
}

function setStatus(message) {
  elements.status.textContent = message;
}

function showErrorModal(text) {
  elements.errorLogs.textContent = text || "Build failed.";
  elements.errorModal.classList.add("open");
}

function showBuildError(error) {
  const text = getErrorText(error);
  if (shouldSuppressErrorModal(text)) {
    return;
  }

  showErrorModal(text);
}

function closeErrorModal() {
  elements.errorModal.classList.remove("open");
}

function getClipboardFiles(clipboardData) {
  return Array.from(clipboardData?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(isLibraryAssetFile);
}

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    // Ignore storage write failures.
  }
}

function safeStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (_) {
    // Ignore storage delete failures.
  }
}

function getErrorText(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error || "Build failed.");
}

function shouldSuppressErrorModal(text) {
  const normalized = String(text || "").trim().toLowerCase();
  return normalized.includes("networkerror when attempting to fetch resource") || normalized.includes("operation was aborted");
}
