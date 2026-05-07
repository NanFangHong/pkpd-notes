# Dec41-Style Workflow Notes

今天确定下来的标准是：

1. 普通 PDF 和 HTML 专用 PDF 分开生成。
2. `site/notes/<slug>.pdf` 永远放正常 A4 PDF。
3. HTML 专用 PDF 使用 `preview` + `tightpage`，并把每个非星号 `\section`/`\subsection` 切成一张连续长页。
4. pdf2htmlEX 每次只转换一页，避免 full 版本裁剪累计误差。
5. full HTML 用 iframe 逐页拼接，并用 `postMessage` 转发 pdf2htmlEX 的目录跳转。
6. 首页层级仿 dec41：笔记名对应两个入口，`HTML` 和 `PDF`；HTML 入口内部再放 full 和章节切片。
7. 目录标题中的轻量 LaTeX 在构建时渲染，避免依赖运行时 CDN。
8. GitHub Pages 发布已提交的 `site/`，不在远端重新编译 LaTeX/pdf2htmlEX。

关键命令：

```bash
npm run build
node scripts/build-notes.mjs --clean --only warfarin-pkpd-reading-note
python3 -m http.server 8765 --directory site
```

发布步骤：

```bash
npm run build
git add notes refs site
git commit -m "Update notes site"
git push origin main
```

`.github/workflows/pkpd-notes-pages.yml` 只负责把仓库里的 `site/` 打包成 Pages artifact 并发布。这样最终网页内容以本地验收结果为准。
