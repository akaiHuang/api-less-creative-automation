# API-Less Creative Automation

**Automating Midjourney Without an Official API**

A reverse-engineered proxy server that bridges the gap between your applications and Midjourney's web interface. When there is no official API, you build your own.

## About

API-Less Creative Automation 透過逆向工程建立 Midjourney 的代理層，讓既有系統能在沒有官方 API 的前提下自動化影像生成工作流。適合需要將生成式影像能力串進內部工具或管線的團隊，用於原型驗證與流程整合。

## 📋 Quick Summary

> 🎨 **API-Less Creative Automation** 是一套逆向工程的 Midjourney 代理伺服器，解決 Midjourney 不提供官方公開 API 的痛點。系統透過 🎭 Playwright 維持一個持久化的 Chromium 瀏覽器會話，自動保存登入狀態與 Cookie 🍪，然後在其上層封裝出完整的 🔌 REST API 與 WebSocket 即時通訊介面。任何外部應用——無論是 📱 行動 App、🌐 網頁前端或後端服務——都能透過標準 HTTP 請求觸發 Midjourney 的影片生成、圖片上傳、動畫製作等操作。每個生成任務分配唯一 Job ID 🆔，支援輪詢或 WebSocket 訂閱追蹤進度百分比與狀態變化。檔案上傳管線透過 📁 Multer 支援最大 50MB 的參考圖片。技術架構為 ⚡ Node.js + Express + Playwright + WebSocket，伺服器啟動於 localhost:3001，附帶內建管理儀表板 📊 可視化管理瀏覽器會話與監控任務狀態。適合需要將 Midjourney 整合進自動化工作流的創意團隊與開發者 🚀。

---

## 🤔 Why This Exists

Midjourney does not offer a public API for programmatic video and image generation. This project solves that constraint by using headless browser automation as a proxy layer, giving any application -- mobile, web, or backend -- full REST API access to Midjourney's creative engine.

## 🏗️ Architecture

```
Mobile App / Web Client
        |
        v
  Express Proxy Server (REST API + WebSocket)
        |
        v
  Playwright Browser Session (persistent login)
        |
        v
  Midjourney Web Application
```

The system maintains a persistent authenticated browser session via Playwright, then exposes a clean REST API and real-time WebSocket interface so that external applications can trigger and monitor Midjourney operations without ever touching the browser directly.

### ⚙️ How It Works

1. **Browser Session Management** -- Launches and maintains a Chromium instance with persistent cookies and login state stored in `.browser-data/`.
2. **REST API Layer** -- Express server on port 3001 exposes endpoints for video generation, image upload, animation, job status tracking, and creation retrieval.
3. **Real-Time Progress** -- WebSocket broadcasts live progress updates (percentage, status changes) to connected clients by monitoring Midjourney's DOM in real time.
4. **Job Tracking** -- Each generation request is assigned a job ID. Clients can poll or subscribe for status updates until completion.
5. **Image Upload Pipeline** -- Supports uploading reference images (up to 50MB) via Multer, which are then fed into Midjourney workflows.

### 🔌 Key API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/browser/launch` | Launch browser session |
| POST | `/browser/connect` | Connect to existing browser |
| GET | `/auth/status` | Check login state |
| POST | `/video/generate` | Trigger video generation |
| POST | `/video/animate` | Animate from reference |
| POST | `/video/upload-and-wait` | Upload image and await result |
| GET | `/job/:jobId/status` | Poll job progress |
| GET | `/job/:jobId/video` | Retrieve completed video |
| GET | `/creations` | List all creations |
| POST | `/videos/fetch` | Batch fetch video data |

## 🛠️ Tech Stack

- **Runtime**: Node.js (ES Modules)
- **Server**: Express.js with CORS
- **Browser Automation**: Playwright (Chromium)
- **Real-Time Communication**: WebSocket (ws)
- **File Handling**: Multer (up to 50MB image uploads)
- **Session Persistence**: File-based browser data directory

## 🏁 Quick Start

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Start the proxy server
npm start

# Or run in watch mode for development
npm run dev
```

The server starts on `http://localhost:3001`. Open the built-in dashboard at the root URL to manage browser sessions and monitor jobs visually.

### 🔑 First-Time Setup

1. Start the server and launch the browser via `POST /browser/launch`.
2. Log into your Midjourney account in the opened browser window.
3. The session cookies are saved automatically -- subsequent launches restore the authenticated session.

### 📱 Client Integration Example (Expo / React Native)

```typescript
const PROXY_URL = 'http://localhost:3001';

// Trigger animation
const response = await fetch(`${PROXY_URL}/video/animate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jobId: 'your-image-job-id' }),
});

// Poll for completion
const status = await fetch(`${PROXY_URL}/job/${jobId}/status`).then(r => r.json());
```

## 📁 Project Structure

```
api-less-creative-automation/
  server.js            # Main server -- Express + Playwright + WebSocket (43KB)
  package.json         # Dependencies and scripts
  public/
    index.html         # Built-in management dashboard
    threads-callback.html  # Callback handler for thread operations
```

---

Built by **Huang Akai (Kai)** -- Founder @ Universal FAW Labs | Creative Technologist | Ex-Ogilvy
