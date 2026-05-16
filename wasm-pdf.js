const TEXLIVE_ENDPOINT = "../texlive-assets/";
const DEFAULT_RUNTIME_FILES = Array.from({ length: 11 }, (_, index) => `backgrounds/background${index + 1}.pdf`);
const SUPPORT_FILES = [
  "eisvogel.latex",
  "header.tex",
  "pdf-fixes-emoji-map.lua",
  "pdf-fixes.lua",
  "pdf-fixes-unicode-map.lua",
  "vscode-light.theme"
];

export function createPdfBuilder({
  includeHeaderFooter = false,
  extraSupportFiles = [],
  extraFilters = [],
  extraHeaders = [],
  extraVariables = {},
  implicitFigures = false,
  runtimeFiles = []
} = {}) {
  let preparePromise = null;
  let supportFilesPromise = null;
  let pandocModule = null;
  let texEngine = null;

  async function prepare() {
    if (!preparePromise) {
      preparePromise = boot().catch((error) => {
        preparePromise = null;
        throw error;
      });
    }

    return preparePromise;
  }

  async function build({ markdown, hidePageNumbers, useSourceSans, mediaFiles = {}, onStage = () => {} }) {
    await prepare();

    const normalizedMarkdown = normalizeLegacyMarkdown(markdown, mediaFiles);
    onStage("Converting markdown...");
    const supportFiles = await loadSupportFiles(extraSupportFiles);
    const options = createPandocOptions(hidePageNumbers, {
      includeHeaderFooter,
      extraFilters,
      extraHeaders,
      extraVariables,
      implicitFigures,
      useSourceSans,
      hasBibliography: Boolean(mediaFiles["bib.bib"])
    });

    if (mediaFiles["bib.bib"]) {
      options.citeproc = true;
      options.csl = "nature.csl";
      options.bibliography = "bib.bib";
      options.metadata = {
        ...(options.metadata || {}),
        "link-citations": true
      };
      options.variables["link-citations"] = true;
    }

    const result = await pandocModule.convert(options, normalizedMarkdown, {
      ...supportFiles,
      ...mediaFiles
    });

    let latexSource = sanitizeHighlightedCodeLatex(result.stdout || "");
    latexSource = sanitizeTextcompLatex(latexSource);
    if (mediaFiles["bib.bib"]) {
      latexSource = prepareCiteprocLatex(latexSource);
    }
    if (!latexSource.trim()) {
      throw new Error(formatLog(result.stderr, result.warnings));
    }

    onStage("Compiling LaTeX...");
    texEngine.flushCache();
    texEngine.setEngineMainFile("document.tex");
    writeMemFsFile(texEngine, "document.tex", latexSource);

    const bundledRuntimeFiles = Array.from(new Set([...DEFAULT_RUNTIME_FILES, ...runtimeFiles]));
    for (const runtimeFile of bundledRuntimeFiles) {
      const response = await fetch(runtimeFile);
      if (!response.ok) {
        throw new Error(`Unable to load ${runtimeFile}`);
      }

      writeMemFsFile(texEngine, runtimeFile, new Uint8Array(await response.arrayBuffer()));
    }

    for (const [name, blob] of Object.entries(mediaFiles)) {
      writeMemFsFile(texEngine, name, new Uint8Array(await blob.arrayBuffer()));
    }

    const compiled = await texEngine.compileLaTeX();
    if (compiled.status !== 0 || !compiled.pdf) {
      const failedLog = formatLog(result.stderr, result.warnings, compiled.log);
      throw new Error(failedLog || "PDF compilation failed.");
    }
    const log = formatLog(result.stderr, result.warnings, compiled.log);

    return {
      log,
      pdfBlob: new Blob([compiled.pdf], { type: "application/pdf" })
    };
  }

  async function boot() {
    await registerServiceWorker();
    [pandocModule] = await Promise.all([
      import("./pandoc.js"),
      loadPdfTeXScript()
    ]);

    const PdfTeXEngine = window.PdfTeXEngine || window.exports?.PdfTeXEngine;
    if (!PdfTeXEngine) {
      throw new Error("PdfTeXEngine failed to load.");
    }

    texEngine = new PdfTeXEngine();
    await texEngine.loadEngine();
    texEngine.setTexliveEndpoint(TEXLIVE_ENDPOINT);
  }

  function loadSupportFiles(extraFiles) {
    if (!supportFilesPromise) {
      const fileNames = Array.from(new Set([...SUPPORT_FILES, ...extraFiles]));
      supportFilesPromise = Promise.all(
        fileNames.map(async (name) => [name, await fetchText(name)])
      ).then(async (entries) => {
        const files = Object.fromEntries(entries);
        files["nature.csl"] = await fetchOptionalText("build-assets/nature.csl");
        return files;
      });
    }

    return supportFilesPromise;
  }

  return { build, prepare };
}

function createPandocOptions(hidePageNumbers, {
  includeHeaderFooter,
  extraFilters,
  extraHeaders,
  extraVariables,
  implicitFigures,
  useSourceSans,
  hasBibliography
}) {
  const variables = {
    "code-block-font-size": "\\footnotesize",
    colorlinks: true,
    geometry: [
      "left=2.5cm",
      "right=2.5cm",
      "top=2.2cm",
      "bottom=2.1cm",
      "footskip=1.0cm"
    ],
    urlcolor: "linktextblue",
    linkcolor: "linktextblue",
    citecolor: "linktextblue",
    filecolor: "linktextblue",
    "listings-no-page-break": true,
    paragraphs: true,
    ...extraVariables
  };

  if (!includeHeaderFooter) {
    variables["disable-header-and-footer"] = true;
  }

  if (hidePageNumbers) {
    variables.pagestyle = "empty";
  }

  if (useSourceSans) {
    variables.sourcesans = true;
  }

  return {
    filters: [ ...extraFilters,"pdf-fixes.lua"],
    from: createInputFormat({ implicitFigures, hasBibliography }),
    "highlight-style": "vscode-light.theme",
    "include-in-header": ["header.tex", ...extraHeaders],
    "resource-path": [".", "media"],
    standalone: true,
    template: "eisvogel.latex",
    to: "latex",
    variables
  };
}

function createInputFormat({ implicitFigures, hasBibliography }) {
  const base = hasBibliography
    ? "markdown+emoji+autolink_bare_uris+fenced_divs+hard_line_breaks+pipe_tables+strikeout+task_lists+tex_math_dollars+yaml_metadata_block"
    : "gfm+emoji+hard_line_breaks+fenced_divs+tex_math_dollars+yaml_metadata_block";
  return implicitFigures ? base : `${base}-implicit_figures`;
}

function normalizeLegacyMarkdown(markdown, mediaFiles) {
  let normalized = String(markdown || "");

  normalized = escapePlainAngleBracketNotes(normalized);

  if (mediaFiles["bib.bib"]) {
    normalized = normalized
      .replace(/\\n(?=\s*(?:!\[|[#>*-]|\d+\.))/g, "\n")
      .replace(/(^|\n)[ \t]*\\n[ \t]*/g, "$1");
  }

  return normalized;
}

function sanitizeHighlightedCodeLatex(latexSource) {
  return String(latexSource).replace(
    /(\\begin\{Highlighting\}(?:\[[^\]]*\])?\n?)([\s\S]*?)(\\end\{Highlighting\})/g,
    (_, start, content, end) => `${start}${content.replace(/\$/g, "\\textdollar{}")}${end}`
  );
}

function escapePlainAngleBracketNotes(markdown) {
  return String(markdown).replace(
    /(^|\n)([ \t]*)<([A-Za-z0-9][^>\n]*\s[^>\n]*)>[ \t]*(?=\n|$)/g,
    (match, prefix, indent, body) => {
      if (/[=/"']/.test(body)) {
        return match;
      }

      return `${prefix}${indent}&lt;${body}&gt;`;
    }
  );
}

function sanitizeTextcompLatex(latexSource) {
  return String(latexSource).replace(/\\textquotesingle(?:\{\})?\s*/g, "'");
}

async function fetchText(name) {
  const response = await fetch(name);
  if (!response.ok) {
    throw new Error(`Unable to load ${name}`);
  }

  return response.text();
}

async function fetchOptionalText(name) {
  const response = await fetch(name);
  if (!response.ok) {
    throw new Error(`Unable to load ${name}`);
  }

  return response.text();
}

function loadPdfTeXScript() {
  if (window.PdfTeXEngine || window.exports?.PdfTeXEngine) {
    return Promise.resolve();
  }

  const existing = document.querySelector('script[data-pdftex="true"]');
  if (existing) {
    if (existing.dataset.loaded === "true") {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", reject, { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.dataset.pdftex = "true";
    script.src = "./swiftlatex/PdfTeXEngine.js";
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () => reject(new Error("Unable to load PdfTeXEngine.js"));
    document.head.appendChild(script);
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register(`./texlive-sw.js?endpoint=${encodeURIComponent(TEXLIVE_ENDPOINT)}`, {
      scope: "./"
    });
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}

function writeMemFsFile(texEngine, path, value) {
  const bytes = typeof value === "string" ? value : value;
  ensureMemFsFolders(texEngine, path);
  texEngine.writeMemFSFile(`/work/${path}`, bytes);
}

function ensureMemFsFolders(texEngine, path) {
  const parts = path.split("/").slice(0, -1);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      texEngine.makeMemFSFolder(current);
    } catch (_) {
      // Folder may already exist.
    }
  }
}

function formatLog(...chunks) {
  const text = chunks
    .flatMap((chunk) => Array.isArray(chunk) ? chunk : [chunk])
    .map((value) => formatChunk(value))
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return text || "Build failed.";
}

function formatChunk(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  return JSON.stringify(value, null, 2);
}

function prepareCiteprocLatex(latexSource) {
  if (latexSource.includes("\\usepackage{xparse}")) {
    return overrideCiteprocCommands(latexSource);
  }

  return overrideCiteprocCommands(
    latexSource.replace("\\usepackage{xcolor}", "\\usepackage{xparse}\n\\usepackage{xcolor}")
  );
}

function overrideCiteprocCommands(latexSource) {
  const marker = "\\newcommand{\\CSLIndent}[1]{\\hspace{\\cslhangindent}#1}";
  const override = `${marker}\n\\RenewDocumentCommand\\citeproc{mm}{\\hyperlink{#1}{#2}}`;
  let updated = latexSource;

  if (!updated.includes("\\RenewDocumentCommand\\citeproc{mm}{\\hyperlink{#1}{#2}}") && updated.includes(marker)) {
    updated = updated.replace(marker, override);
  }

  updated = updated.replace(/(^|\n)(\\bibitem(?:\[[^\]]*\])?\{([^}]+)\})/g, (match, prefix, bibitem, key) => {
    return `${prefix}\\hypertarget{${key}}{}\n${bibitem}`;
  });

  return updated;
}
