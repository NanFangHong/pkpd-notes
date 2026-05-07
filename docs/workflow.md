# Dec41-Style Workflow Notes

今天确定下来的标准是：

1. 普通 PDF 和 HTML 专用 PDF 分开生成。
2. `site/notes/<slug>.pdf` 永远放正常 A4 PDF。
3. 每篇笔记固定使用 `notes/header.tex` 里的 dec41-style 模板：元信息宏、`\maketitle`、开头说明、`\tableofcontents`、section 新页和页眉风格。
4. HTML 专用 PDF 使用 `preview` + `tightpage`，并把每个非星号 `\section`/`\subsection` 切成一张连续长页。
5. HTML 切块时会绕开模板中 PDF 专用的 `\section -> \newpage\stdsection`，避免 PDF 分页和 tightpage 切块叠加。
6. HTML 专用 PDF 会关闭 `fancyhdr` 的 page style/headrule，避免页眉横线被 tightpage 截进 full HTML。
7. 每个 pdf2htmlEX 页面片段都会在真实页底覆盖一条很窄的白色 seam，消除 tightpage 位图层偶发的横线残留；full HTML 还会在 iframe 拼接处再做一次父层遮罩。
8. pdf2htmlEX 每次只转换一页，避免 full 版本裁剪累计误差。
9. 每个 pdf2htmlEX 页面片段都在末尾追加本地覆盖样式，解除 `.pf/.pc` 的右下裁剪，并给外层 HTML 容器保留少量安全余量。
10. full HTML 用 iframe 逐页拼接，并用 `postMessage` 转发 pdf2htmlEX 的目录跳转。
11. 首页层级仿 dec41：笔记名对应两个入口，`HTML` 和 `PDF`；HTML 入口内部再放 full 和章节切片。
12. 目录标题中的轻量 LaTeX 在构建时渲染，避免依赖运行时 CDN。
13. GitHub Pages 发布已提交的 `site/`，不在远端重新编译 LaTeX/pdf2htmlEX。

关键命令：

```bash
npm run build
node scripts/build-notes.mjs --clean --only warfarin-pkpd-reading-note
python3 -m http.server 8765 --directory site
```

右下裁剪保护默认是 `8px`。如果某篇笔记含有特别贴边的图形，可以临时调大再构建：

```bash
PDF2HTMLEX_CROP_PAD=12 node scripts/build-notes.mjs --clean --only warfarin-pkpd-reading-note
```

full HTML 拼接缝遮罩默认是 `3px`。如果某个主题的页底残留更明显，可以临时调大：

```bash
PDF2HTMLEX_SEAM_COVER=4 node scripts/build-notes.mjs --clean --only warfarin-pkpd-reading-note
```

发布步骤：

```bash
npm run build
git add notes refs site
git commit -m "Update notes site"
git push origin main
```

`.github/workflows/pkpd-notes-pages.yml` 只负责把仓库里的 `site/` 打包成 Pages artifact 并发布。这样最终网页内容以本地验收结果为准。
