# PK/PD Notes

这是一个 dec41-style 的 LaTeX 笔记发布仓库：你只维护 `notes/*.tex`、`notes/notes.json` 和 `refs/pharmacology.bib`，构建脚本会生成普通 PDF、pdf2htmlEX HTML、full 版本和按章节切块的页面。

## 本地构建

```bash
npm run build
npm run serve
```

构建结果在 `site/`：

- `site/index.html`：首页，每篇笔记有独立的 `HTML` 和 `PDF` 链接。
- `site/h/<slug>/index.html`：该笔记的 HTML 目录页。
- `site/h/<slug>/full.html`：整篇 full HTML。
- `site/h/<slug>/<section>.html`：按 `\section`/`\subsection` 切出的连续长页。
- `site/notes/<slug>.pdf`：正常 A4 PDF，用于下载、引用和归档。

## 新增笔记

1. 在 `notes/` 新建一篇 `.tex`。
2. 在 `notes/notes.json` 增加 `slug`、`title`、`category`、`date`、`paper` 和 `tex`。
3. 引用统一放在 `refs/pharmacology.bib`。
4. 运行 `npm run build` 检查 PDF 与 HTML。
5. 推送到 `main` 后，GitHub Actions 会发布到 GitHub Pages。

## 工作流标准

HTML 不重新排版 LaTeX。它走完整的 PDF-faithful 路线：

```text
LaTeX -> Tectonic PDF -> pdf2htmlEX HTML -> dec41-style static site
```

full HTML 使用按页 iframe 拼接，并转发 pdf2htmlEX 内部链接，所以 PDF 里的目录链接会在 full 页面里跳到对应位置。章节页来自一份 HTML 专用 tightpage PDF：脚本在每个非星号 `\section` 和 `\subsection` 前开始新页，再用 pdf2htmlEX 转成对应的连续长页。

不要把出版社原文 PDF 放进仓库。这里适合发布你自己的笔记 PDF、复现图、BibTeX 和 DOI/PubMed/出版社链接。
