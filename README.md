# videoparse

基于浏览器的 **MP4 全帧解析 Demo**：在 Web Worker 中用 [mp4box.js](https://github.com/gpac/mp4box.js) 解封装，用 [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) `VideoDecoder` 解码，并将每一帧以 `ImageBitmap`（Transferable）传回主线程展示。

## 功能

- 支持本地上传 MP4，或粘贴可被 CORS 读取的远程 MP4 URL
- 展示视频预览、基本信息（编码、帧率、分辨率等）与 mp4box / 解码器元数据
- 按时间戳展示全部解码帧缩略图，并显示帧数与解析耗时
- 支持中途停止解析

## 技术栈

| 部分 | 说明 |
| --- | --- |
| 主线程 | `index.html` + `index.css`，负责 UI、预览与帧展示 |
| Worker | `worker.js`（ES Module），负责解封装与解码 |
| 依赖 | mp4box@2.3.0（CDN ESM 加载） |

## 目录结构

```
videoparse/
├── index.html   # 页面与主线程逻辑
├── index.css    # 样式
├── worker.js    # Module Worker：mp4box + WebCodecs
├── package.json
└── README.md
```

## 快速开始

需要通过 **localhost 或 HTTPS** 提供静态资源（Module Worker / WebCodecs 要求安全上下文）。

```bash
pnpm install   # 可选；当前仅用到 npx serve
pnpm dev
```

浏览器打开终端提示的本地地址（通常为 `http://localhost:3000`）。

## 运行环境

- 支持 WebCodecs 的 **Chromium** 系浏览器（Chrome / Edge 等）
- 远程视频 URL 需允许跨域读取（CORS）
- 长视频全帧解码会占用大量内存，请谨慎使用

## License

ISC
