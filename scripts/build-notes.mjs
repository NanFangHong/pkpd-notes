import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const notesDir = path.join(root, "notes");
const siteDir = path.join(root, "site");
const buildDir = path.join(root, "build");
const dataDir = path.join(root, "pdf2htmlex");
const zoom = process.env.PDF2HTMLEX_ZOOM || "1.860433";
const zoomNumber = Number.isFinite(Number(zoom)) ? Number(zoom) : 1.860433;
const dockerImage =
  process.env.PDF2HTMLEX_DOCKER_IMAGE ||
  "pdf2htmlex/pdf2htmlex:0.18.8.rc2-master-20200820-ubuntu-20.04-x86_64";

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = { clean: false, only: new Set(), limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--clean") parsed.clean = true;
    else if (arg === "--only") parsed.only.add(argv[(i += 1)] || "");
    else if (arg.startsWith("--only=")) parsed.only.add(arg.slice(7));
    else if (arg === "--limit") parsed.limit = Number(argv[(i += 1)] || 0);
    else if (arg.startsWith("--limit=")) parsed.limit = Number(arg.slice(8));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function sh(command) {
  return spawnSync("sh", ["-lc", command], { stdio: "ignore" }).status === 0;
}

function executableWorks(file) {
  return file && existsSync(file) && spawnSync(file, ["--version"], { stdio: "ignore" }).status === 0;
}

function findTectonic() {
  if (executableWorks(process.env.TECTONIC)) return process.env.TECTONIC;
  if (sh("command -v tectonic")) return "tectonic";
  const bundled = path.join(
    process.env.HOME || "",
    ".codex/plugins/cache/openai-bundled/latex-tectonic/0.1.0/bin",
    process.platform === "win32" ? "tectonic.exe" : "tectonic",
  );
  if (existsSync(bundled)) return bundled;
  throw new Error("Could not find Tectonic. Install it or set TECTONIC=/path/to/tectonic.");
}

function findPdf2htmlEX() {
  const candidates = [
    process.env.PDF2HTMLEX,
    "pdf2htmlEX",
    path.join(process.env.HOME || "", ".local/bin/pdf2htmlEX"),
    path.join(process.env.HOME || "", ".local/pdf2htmlEX/bin/pdf2htmlEX"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "pdf2htmlEX" && sh("command -v pdf2htmlEX")) return candidate;
    if (candidate !== "pdf2htmlEX" && executableWorks(candidate)) return candidate;
  }
  return "";
}

function findPdf2htmlPoppler() {
  const local = path.join(process.env.HOME || "", ".local/pdf2htmlEX/share/pdf2htmlEX/poppler");
  return process.env.PDF2HTMLEX_POPPLER_DATA_DIR || (existsSync(local) ? local : "");
}

function findTtfAutohint() {
  for (const candidate of [process.env.TTFAUTOHINT, "ttfautohint"].filter(Boolean)) {
    if (candidate === "ttfautohint" && sh("command -v ttfautohint")) return candidate;
    if (candidate !== "ttfautohint" && existsSync(candidate)) return candidate;
  }
  return "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripComments(tex) {
  return tex
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== "%") continue;
        let slashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) slashes += 1;
        if (slashes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

function findMatchingBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "\\" && i + 1 < source.length) {
      i += 1;
      continue;
    }
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function balancedGroup(source, cursor) {
  const open = source.indexOf("{", cursor);
  if (open < 0) return null;
  const close = findMatchingBrace(source, open);
  if (close < 0) return null;
  return { value: source.slice(open + 1, close), end: close + 1 };
}

const symbols = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  lambda: "λ",
  mu: "μ",
  pi: "π",
  phi: "φ",
  varphi: "ϕ",
  theta: "θ",
  Gamma: "Γ",
  Delta: "Δ",
  Phi: "Φ",
  ell: "ℓ",
  nabla: "∇",
  partial: "∂",
  infty: "∞",
  times: "×",
  cdot: "·",
  leq: "≤",
  geq: "≥",
  neq: "≠",
  to: "→",
  R: "ℝ",
  C: "ℂ",
  N: "ℕ",
  Z: "ℤ",
};

function replaceCommandGroups(source, command, replacer) {
  let out = "";
  let cursor = 0;
  const token = `\\${command}`;
  while (cursor < source.length) {
    const start = source.indexOf(token, cursor);
    if (start < 0) return out + source.slice(cursor);
    out += source.slice(cursor, start);
    const group = balancedGroup(source, start + token.length);
    if (!group) {
      out += token;
      cursor = start + token.length;
      continue;
    }
    out += replacer(group.value);
    cursor = group.end;
  }
  return out;
}

function textTitle(value) {
  let title = value
    .replace(/\\protect\s+/g, "")
    .replace(/\\mathbb\s*\{\s*([A-Za-z])\s*\}/g, (_m, s) => symbols[s] || s)
    .replace(/\\(["'`^~])\s*\{?([A-Za-z])\}?/g, (_m, accent, letter) => accentLetter(accent, letter))
    .replace(/---/g, "—")
    .replace(/--|&ndash;/g, "–")
    .replace(/&auml;/g, "ä");
  for (const command of ["emph", "textbf", "textit", "texttt", "mathrm", "operatorname", "text"]) {
    title = replaceCommandGroups(title, command, (group) => group);
  }
  title = title.replace(/\\([A-Za-z]+)(?![A-Za-z])/g, (match, name) => symbols[name] || name);
  title = title.replace(/\^\s*\{([^{}]+)\}/g, "^$1").replace(/_\s*\{([^{}]+)\}/g, "_$1");
  return title
    .replace(/\\([#$%&_{}])/g, "$1")
    .replace(/[{}$]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleHtml(value) {
  return escapeHtml(textTitle(value))
    .replace(/\^([A-Za-z0-9ℝℂℕℤ]+)/g, "<sup>$1</sup>")
    .replace(/_([A-Za-z0-9]+)/g, "<sub>$1</sub>");
}

function accentLetter(accent, letter) {
  const map = {
    '"': { a: "ä", e: "ë", i: "ï", o: "ö", u: "ü", A: "Ä", O: "Ö", U: "Ü" },
    "'": { a: "á", e: "é", i: "í", o: "ó", u: "ú", A: "Á", E: "É" },
    "`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù" },
    "^": { a: "â", e: "ê", i: "î", o: "ô", u: "û" },
    "~": { n: "ñ", a: "ã", o: "õ" },
  };
  return map[accent]?.[letter] || letter;
}

function extractSections(tex) {
  const source = stripComments(tex).replace(/\\ifx\s*\\nhtml\s*\\undefined[\s\S]*?\\fi/g, "");
  const re = /\\setcounter\s*\{\s*section\s*\}\s*\{\s*(-?\d+)\s*\}|\\(section|subsection)(\*)?(?![A-Za-z])/g;
  const sections = [];
  let section = 0;
  let subsection = 0;
  let match;
  while ((match = re.exec(source))) {
    if (match[1] !== undefined) {
      section = Number(match[1]);
      subsection = 0;
      continue;
    }
    if (match[3]) continue;
    let cursor = match.index + match[0].length;
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    if (source[cursor] === "[") {
      const close = source.indexOf("]", cursor + 1);
      if (close >= 0) cursor = close + 1;
    }
    const group = balancedGroup(source, cursor);
    if (!group) continue;
    re.lastIndex = group.end;
    const level = match[2];
    let id;
    let number;
    if (level === "section") {
      section += 1;
      subsection = 0;
      id = `${section}`;
      number = `${section}`;
    } else {
      subsection += 1;
      id = `${section}_${subsection}`;
      number = `${section}.${subsection}`;
    }
    sections.push({ id, level, number, title: textTitle(group.value), titleHtml: titleHtml(group.value) });
  }
  return sections;
}

function rewriteBibPaths(tex, texDir) {
  return tex.replace(/\\bibliography\{([^}]+)\}/g, (_m, value) => {
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (path.isAbsolute(entry) ? entry : path.resolve(texDir, entry).replaceAll(path.sep, "/")));
    return `\\bibliography{${entries.join(",")}}`;
  });
}

function injectHtmlMode(tex) {
  const mode = `
% dec41-style HTML page mode, generated by scripts/build-notes.mjs.
\\makeatletter
\\usepackage[active,tightpage]{preview}
\\renewcommand{\\PreviewBorder}{0.1cm}
\\newlength\\pkpdcurrentparindent
\\setlength\\pkpdcurrentparindent\\parindent
\\newcommand\\@minipagerestore{\\setlength{\\parindent}{\\pkpdcurrentparindent}}
\\newenvironment{pkpdstretchpage}%
  {\\begin{preview}\\begin{minipage}{\\textwidth}}%
  {\\end{minipage}\\end{preview}}
\\AtBeginDocument{\\begin{pkpdstretchpage}}
\\AtEndDocument{\\end{pkpdstretchpage}}
\\newcommand{\\pkpdnewhtmlpage}{\\end{pkpdstretchpage}\\begin{pkpdstretchpage}}
\\let\\pkpdrealsection\\section
\\renewcommand{\\section}{\\@ifstar{\\pkpdrealsection*}{\\pkpdnewhtmlpage\\pkpdrealsection}}
\\let\\pkpdrealsubsection\\subsection
\\renewcommand{\\subsection}{\\@ifstar{\\pkpdrealsubsection*}{\\pkpdnewhtmlpage\\pkpdrealsubsection}}
\\makeatother
`;
  if (!/\\begin\{document\}/.test(tex)) throw new Error("Missing \\begin{document}.");
  return tex.replace(/\\begin\{document\}/, `${mode}\n\\begin{document}`);
}

function linkTree(source, target, skip = new Set()) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) linkTree(from, to);
    else if (!existsSync(to)) symlinkSync(from, to);
  }
}

function workTex(note, htmlMode) {
  const source = path.join(notesDir, note.tex);
  const work = path.join(buildDir, "work", htmlMode ? "html" : "pdf", note.slug);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  linkTree(notesDir, work, new Set([note.tex, "notes.json"]));
  const original = readFileSync(source, "utf8");
  const prepared = rewriteBibPaths(original, path.dirname(source));
  writeFileSync(path.join(work, `${note.slug}.tex`), htmlMode ? injectHtmlMode(prepared) : prepared);
  return work;
}

function compile(note, work, out, label) {
  mkdirSync(out, { recursive: true });
  const tectonic = findTectonic();
  const tex = path.join(work, `${note.slug}.tex`);
  const result = spawnSync(tectonic, ["--keep-logs", "--keep-intermediates", "--outdir", out, tex], {
    cwd: work,
    encoding: "utf8",
    stdio: "pipe",
  });
  const logDir = path.join(buildDir, "logs", note.slug);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, `${label}.stdout.log`), result.stdout || "");
  writeFileSync(path.join(logDir, `${label}.stderr.log`), result.stderr || "");
  const pdf = path.join(out, `${note.slug}.pdf`);
  if (result.status !== 0 || !existsSync(pdf)) {
    if (result.stdout) console.error(result.stdout.trim());
    if (result.stderr) console.error(result.stderr.trim());
    throw new Error(`Tectonic failed for ${note.slug}; see ${path.relative(root, logDir)}`);
  }
  return pdf;
}

function pageCount(pdf) {
  const result = spawnSync("pdfinfo", [pdf], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`pdfinfo failed for ${pdf}`);
  return Number(result.stdout.match(/^Pages:\s+(\d+)/m)?.[1] || 0);
}

function runPdf2htmlEX(note, pdf, outDir, output, page) {
  mkdirSync(outDir, { recursive: true });
  const ttf = findTtfAutohint();
  const poppler = findPdf2htmlPoppler();
  const common = [
    "--first-page",
    String(page),
    "--last-page",
    String(page),
    "--data-dir",
    dataDir,
    "--zoom",
    zoom,
    "--embed",
    "CFIJO",
    "--correct-text-visibility",
    "1",
    "--process-outline",
    "0",
    "--dest-dir",
    outDir,
  ];
  if (ttf) common.push("--external-hint-tool", ttf);
  if (poppler) common.push("--poppler-data-dir", poppler);
  common.push(pdf, output);

  const exe = findPdf2htmlEX();
  const runner = exe
    ? [exe, common]
    : [
        "docker",
        [
          "run",
          "--rm",
          "--platform",
          "linux/amd64",
          "-v",
          `${root}:/work`,
          "-w",
          "/work",
          dockerImage,
          ...common.map((arg) => (path.isAbsolute(arg) && arg.startsWith(root) ? path.relative(root, arg) : arg)),
        ],
      ];
  if (!exe && !sh("command -v docker")) throw new Error("pdf2htmlEX is unavailable.");

  const result = spawnSync(runner[0], runner[1], { cwd: root, encoding: "utf8", stdio: "pipe" });
  const logDir = path.join(buildDir, "logs", note.slug);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, `pdf2htmlEX.page-${page}.stdout.log`), result.stdout || "");
  writeFileSync(path.join(logDir, `pdf2htmlEX.page-${page}.stderr.log`), result.stderr || "");
  const html = path.join(outDir, output);
  if (result.status !== 0 || !existsSync(html)) throw new Error(`pdf2htmlEX failed for ${note.slug} page ${page}`);
  return html;
}

function injectPageBridge(html) {
  const reset = `<style id="pdf2html-page-reset">html,body{margin:0;padding:0;background:#fff;}body{width:max-content;min-width:0;}.pf{margin:0;}</style>`;
  const bridge = `<style id="pdf2html-iframe-link-cursor">a.l{cursor:pointer;}.l .d{z-index:20;pointer-events:auto;cursor:pointer;}</style>
<script id="pdf2html-iframe-jump-forwarder">
(() => {
  function currentScale(){const el=document.querySelector('.pi[data-data]');if(!el)return null;try{const d=JSON.parse(el.getAttribute('data-data'));return Number(d.ctm?.[0])||null;}catch{return null;}}
  document.addEventListener('click',(event)=>{const link=event.target.closest&&event.target.closest('a[href^="#pf"]');if(!link||window.parent===window)return;event.preventDefault();window.parent.postMessage({type:'pdf2htmlEX:jump',href:link.getAttribute('href'),detail:link.getAttribute('data-dest-detail'),scale:currentScale()},'*');},true);
})();
</script>`;
  return html.replace("</body>", `${reset}\n${bridge}\n</body>`);
}

function readPageSize(html) {
  const cls = html.match(/<div id="pf[0-9a-f]+" class="pf ([^"]+)"/)?.[1] || "";
  const w = cls.split(/\s+/).find((c) => /^w[0-9a-f]+$/i.test(c));
  const h = cls.split(/\s+/).find((c) => /^h[0-9a-f]+$/i.test(c));
  const width = w ? Number(html.match(new RegExp(`\\.${w}\\{width:([0-9.]+)px;\\}`))?.[1] || 0) : 0;
  const height = h ? Number(html.match(new RegExp(`\\.${h}\\{height:([0-9.]+)px;\\}`))?.[1] || 0) : 0;
  return { width: width || 455, height: height || 640 };
}

function convertPages(note, pdf) {
  const out = path.join(buildDir, "native-html", note.slug, "pages");
  rmSync(path.dirname(out), { recursive: true, force: true });
  const pages = [];
  for (let page = 1; page <= pageCount(pdf); page += 1) {
    const html = runPdf2htmlEX(note, pdf, out, `page-${page}.html`, page);
    const patched = injectPageBridge(readFileSync(html, "utf8"));
    writeFileSync(html, patched);
    pages.push({ page, html, ...readPageSize(patched) });
  }
  return pages;
}

function pageId(page) {
  return `pf${page.toString(16)}`;
}

function fullHtml(note, pages) {
  const width = Math.max(...pages.map((page) => page.width));
  const bodies = pages
    .map((page) => {
      const w = Math.ceil(page.width);
      const h = Math.ceil(page.height);
      return `<section id="${pageId(page.page)}" class="pdf-page" style="width:${page.width}px;height:${page.height}px"><iframe title="Page ${page.page}" src="pages/page-${page.page}.html" width="${w}" height="${h}" loading="lazy" scrolling="no"></iframe></section>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(note.title)}</title><style>html,body{margin:0;padding:0;background:#fff;color:#111}body{min-width:${Math.ceil(width)}px}#page-container{width:${width}px;margin:0 auto;background:#fff}.pdf-page{position:relative;margin:0 auto;padding:0;overflow:hidden;background:#fff}.pdf-page iframe{display:block;border:0;margin:0;padding:0;width:100%;height:100%;background:#fff}@media print{.pdf-page{break-after:page}}</style></head>
<body><div id="page-container">${bodies}</div>
<script id="pdf2html-iframe-jump-bridge">
(() => {
  const DEFAULT_SCALE=${JSON.stringify(zoomNumber)};
  function pageId(n){return 'pf'+Number(n).toString(16);}
  function detail(v){try{return v?JSON.parse(v):null;}catch{return null;}}
  function target(href){if(!href||!href.startsWith('#pf'))return null;const direct=href.slice(1);if(document.getElementById(direct))return direct;const n=Number.parseInt(direct.slice(2),16);const id=Number.isFinite(n)?pageId(n):null;return id&&document.getElementById(id)?id:null;}
  function jump(href,detailText,scaleValue){const d=detail(detailText);const id=d&&Number.isFinite(Number(d[0]))?pageId(d[0]):target(href);const el=id&&document.getElementById(id);if(!el)return;const r=el.getBoundingClientRect();let top=window.scrollY+r.top;const pdfY=d&&typeof d[3]==='number'?d[3]:null;const scale=Number.isFinite(Number(scaleValue))?Number(scaleValue):DEFAULT_SCALE;if(pdfY!==null)top+=Math.max(0,Math.min(r.height-1,r.height-pdfY*scale));window.scrollTo({top,left:0,behavior:'auto'});history.replaceState(null,'','#'+id);}
  window.addEventListener('message',(event)=>{const data=event.data||{};if(data.type==='pdf2htmlEX:jump')jump(data.href,data.detail,data.scale);});
  window.addEventListener('hashchange',()=>jump(window.location.hash,null,DEFAULT_SCALE));
  if(window.location.hash)requestAnimationFrame(()=>jump(window.location.hash,null,DEFAULT_SCALE));
})();
</script></body></html>`;
}

function parentSection(sections, index) {
  for (let i = index; i >= 0; i -= 1) if (sections[i].level === "section") return sections[i];
  return sections[index];
}

function nav(section, rel, dir) {
  if (!section || section.missing) return "&nbsp;";
  const left = dir === "prev" ? "&lt; " : "";
  const right = dir === "next" ? " &gt;" : "";
  return `<a rel="${rel}" href="${section.html}" title="${escapeHtml(section.number + " " + section.title)}">${left}${escapeHtml(section.number)}${right}</a>`;
}

function sectionHtml(note, sections, index, pageHtml, pageSize) {
  const section = sections[index];
  const parent = parentSection(sections, index);
  const width = Math.ceil(pageSize.width);
  const heading = `${escapeHtml(parent.number)}<span style="padding-left:10pt;"></span>${parent.titleHtml}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${note.title} - ${section.number} ${section.title}`)}</title>
<style>html,body{margin:0;padding:0;background:#fff;color:#111}body{font-family:Arial,Helvetica,sans-serif}#main{width:${width}px;margin:26px auto 28px;background:#fff}.disp-header{display:flex;justify-content:space-between;align-items:flex-end;gap:1rem;font-size:16px;font-weight:600;font-style:italic}.disp-header p{margin:0}.disp-header-right{text-align:right}hr{border:0;border-top:1px solid #999;margin:.55rem 0 1rem}.disp-nav{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin:1.35rem 0 0;font-size:15px}.disp-nav p{margin:0}.disp-nav-left,.disp-nav-right{width:30%}.disp-nav-center{flex:1;text-align:center}.disp-nav-right{text-align:right}a{color:#064f83;text-decoration:none}a:hover{text-decoration:underline}</style></head>
<body><div id="main"><div class="disp-header"><p>${heading}</p><p class="disp-header-right">${escapeHtml(note.title)}</p></div><hr><br>${pageHtml}
<style id="pdf2html-section-reset-override">body{width:auto;min-width:0}.pf{margin:0}</style>
<nav class="disp-nav"><p class="disp-nav-left">${nav(sections[index - 1], "prev", "prev")}</p><p class="disp-nav-center"><a href="index.html">Table of Contents</a></p><p class="disp-nav-right">${nav(sections[index + 1], "next", "next")}</p></nav></div></body></html>`;
}

function noteIndex(note, sections) {
  const items = sections
    .map((section) => {
      const cls = section.level === "subsection" ? ' class="subsection"' : "";
      const label = `${escapeHtml(section.number)} ${section.titleHtml}`;
      return `<li${cls}><a href="${section.html}">${label}</a></li>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(note.title)}</title><style>html,body{margin:0;padding:0;background:#f7f7f5;color:#141414}body{font-family:Georgia,"Times New Roman",serif;line-height:1.48}#main{max-width:900px;margin:0 auto;padding:48px 28px 72px;background:#fff;min-height:100vh;box-sizing:border-box}a{color:#064f83;text-decoration:none}a:hover{text-decoration:underline}h1{font-weight:normal;border-bottom:1px solid #d6d6d2;padding-bottom:.35rem;margin-top:0}.toc-note{color:#4d4d4d;max-width:680px}.disp-toc{padding-left:1.15rem}.disp-toc li{margin:.18rem 0}.subsection{margin-left:1.45rem}.math-title{white-space:nowrap}</style></head>
<body><div id="main"><h1>${note.titleHtml}</h1><p>${escapeHtml(note.additional || "")}</p><p class="toc-note">This is an HTML version of the notes generated with pdf2htmlEX. You can either view all sections in a single page, or access individual sections below.</p><h2>Contents</h2><ul class="disp-toc"><li><a href="full.html">V Full version</a></li>${items}</ul></div></body></html>`;
}

function writeNoteSite(note, pages, sections, pdf) {
  const dir = path.join(siteDir, "h", note.slug);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "pages"), { recursive: true });
  for (const page of pages) copyFileSync(page.html, path.join(dir, "pages", `page-${page.page}.html`));
  mkdirSync(path.join(siteDir, "notes"), { recursive: true });
  copyFileSync(pdf, path.join(siteDir, "notes", `${note.slug}.pdf`));
  const full = fullHtml(note, pages);
  writeFileSync(path.join(dir, "full.html"), full);
  writeFileSync(path.join(dir, "full"), full);

  const routed = sections.map((section, i) => ({ ...section, page: i + 2, html: `${section.id}.html` }));
  for (const [index, section] of routed.entries()) {
    const page = pages.find((candidate) => candidate.page === section.page);
    if (!page) {
      section.missing = true;
      continue;
    }
    const html = sectionHtml(note, routed, index, readFileSync(page.html, "utf8"), page);
    writeFileSync(path.join(dir, section.html), html);
    writeFileSync(path.join(dir, section.id), html);
  }
  writeFileSync(path.join(dir, "index.html"), noteIndex(note, routed));
  return routed;
}

function topIndex(results) {
  const byCategory = new Map();
  for (const result of results) {
    const category = result.note.category || "Notes";
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(result);
  }
  const groups = [...byCategory.entries()]
    .map(([category, items]) => {
      const body = items
        .sort((a, b) => String(b.note.date || "").localeCompare(String(a.note.date || "")))
        .map((item) => {
          const extra = item.note.additional ? ` <span class="note-additional">(${escapeHtml(item.note.additional)})</span>` : "";
          const links = item.ok
            ? `<a href="h/${item.note.slug}/index.html">HTML</a><a href="notes/${item.note.slug}.pdf" type="application/pdf">PDF</a>`
            : `<span class="unavailable">HTML</span><span class="unavailable">PDF</span><span class="build-error">${escapeHtml(item.error)}</span>`;
          return `<section class="course-entry"><h3 class="course">${item.note.titleHtml}${extra}</h3><div class="extras">${links}</div></section>`;
        })
        .join("\n");
      return `<section class="part-block"><h1>${escapeHtml(category)}</h1>${body}</section>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PK/PD Notes</title>
<style>html,body{margin:0;padding:0;background:#f5f6f7;color:#151515}body{font-family:Georgia,"Times New Roman",serif;line-height:1.45}.site-shell{max-width:980px;margin:0 auto;padding:52px 34px 80px;box-sizing:border-box}.site-header{border-bottom:1px solid #d4d8dd;margin-bottom:34px;padding-bottom:20px}.site-header h1{font-size:2.35rem;line-height:1.08;margin:0 0 .55rem;font-weight:normal}.site-header p{max-width:720px;color:#4b5158;margin:.35rem 0 0}a{color:#064f83;text-decoration:none}a:hover{text-decoration:underline}.part-block{margin-top:34px}.part-block>h1{font-size:1.85rem;font-weight:normal;margin:0 0 16px;border-bottom:1px solid #dde1e5;padding-bottom:8px}.course-entry{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:18px;align-items:baseline;padding:8px 0;border-bottom:1px solid #eceff1}.course{font-size:1rem;font-weight:normal;margin:0}.note-additional{color:#444}.extras{display:flex;justify-content:flex-end;align-items:center;gap:12px}.extras a,.unavailable{display:inline-block;min-width:72px;padding:.16em .4em;text-align:center;box-sizing:border-box}.unavailable{color:#888}.build-error{color:#8a1f11;margin-left:.75rem}@media(max-width:700px){.site-shell{padding:32px 20px 56px}.course-entry{grid-template-columns:1fr;gap:6px}.extras{justify-content:flex-start}.site-header h1{font-size:2rem}}</style></head>
<body><main class="site-shell"><header class="site-header"><h1>PK/PD Notes</h1><p>LaTeX reading notes rendered with Tectonic, true pdf2htmlEX HTML, and ordinary linked PDFs.</p></header>${groups}</main></body></html>`;
}

function normalizeNote(note) {
  return {
    ...note,
    slug: note.slug || path.basename(note.tex, ".tex"),
    titleHtml: titleHtml(note.title || note.slug || note.tex),
    additional: note.additional || [note.year, note.paper].filter(Boolean).join(", "),
  };
}

function build(note) {
  const tex = readFileSync(path.join(notesDir, note.tex), "utf8");
  const sections = extractSections(tex);
  const htmlPdf = compile(note, workTex(note, true), path.join(buildDir, "html-pdf", note.slug), "tectonic.html");
  const pages = convertPages(note, htmlPdf);
  const pdf = compile(note, workTex(note, false), path.join(buildDir, "pdf", note.slug), "tectonic.pdf");
  const routed = writeNoteSite(note, pages, sections, pdf);
  return {
    note,
    ok: true,
    htmlPdf: path.relative(root, htmlPdf),
    pdf: path.relative(root, pdf),
    pages: pages.map((page) => ({ page: page.page, width: page.width, height: page.height })),
    sections: routed,
  };
}

if (args.clean) {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(siteDir, { recursive: true, force: true });
}
mkdirSync(buildDir, { recursive: true });
mkdirSync(siteDir, { recursive: true });

let notes = JSON.parse(readFileSync(path.join(notesDir, "notes.json"), "utf8")).map(normalizeNote);
if (args.only.size) notes = notes.filter((note) => args.only.has(note.slug) || args.only.has(note.tex));
if (args.limit > 0) notes = notes.slice(0, args.limit);

const results = [];
for (const [index, note] of notes.entries()) {
  console.log(`[${index + 1}/${notes.length}] ${note.slug}`);
  try {
    results.push(build(note));
  } catch (error) {
    console.error(`  failed: ${error.message}`);
    results.push({ note, ok: false, error: error.message, sections: [] });
  }
  writeFileSync(path.join(buildDir, "manifest.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(path.join(siteDir, "index.html"), topIndex(results));
}

writeFileSync(path.join(siteDir, ".nojekyll"), "");
console.log(`Built ${results.filter((result) => result.ok).length}/${results.length} notes into site`);
if (results.some((result) => !result.ok)) process.exitCode = 1;
