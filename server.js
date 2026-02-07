/**
 * Midjourney Proxy Server
 * 
 * 使用 Playwright 保持瀏覽器開啟，作為中繼站
 * 提供 REST API 讓 App 可以觸發 Midjourney 操作
 */

import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3001;

// Session 存儲路徑（登入後會自動保存 cookies）
const USER_DATA_DIR = join(__dirname, '.browser-data');
const REMOTE_DEBUGGING_PORT = 9222;
const UPLOAD_DIR = join(__dirname, 'uploads');

// 確保上傳目錄存在
if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer 設定
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = file.originalname.split('.').pop();
    cb(null, `image-${uniqueSuffix}.${ext}`);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('只接受圖片檔案'));
    }
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// HTTP Server for WebSocket
const server = createServer(app);
const wss = new WebSocketServer({ server });

// WebSocket clients
const wsClients = new Set();

wss.on('connection', (ws) => {
  console.log('🔌 WebSocket 客戶端已連線');
  wsClients.add(ws);
  
  // 發送當前狀態
  ws.send(JSON.stringify({
    type: 'status',
    server: true,
    browser: !!page,
    login: isLoggedIn
  }));
  
  ws.on('close', () => {
    wsClients.delete(ws);
    console.log('🔌 WebSocket 客戶端已斷線');
  });
});

// 廣播訊息給所有 WebSocket 客戶端
function broadcast(data) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

// 發送日誌到前端
function wsLog(level, message) {
  broadcast({ type: 'log', level, message });
}

// 全域變數
let browser = null;
let page = null;
let isLoggedIn = false;
let currentJobs = new Map(); // 追蹤進行中的任務
let connectionMode = 'standalone'; // 'standalone' 或 'connect'
let progressMonitorInterval = null; // 進度監控 interval

// ==================== 進度監控 ====================

/**
 * 開始監控所有任務的進度
 */
function startProgressMonitor() {
  if (progressMonitorInterval) return; // 已經在監控
  
  console.log('📊 開始進度監控...');
  let lastProgress = 0;
  let stableCount = 0; // 進度穩定的次數
  let highProgressCount = 0; // 高進度計數
  
  progressMonitorInterval = setInterval(async () => {
    if (!page || currentJobs.size === 0) {
      return;
    }
    
    try {
      // 從頁面抓取進度資訊 - 專門針對 Midjourney 的 UI
      const progressData = await page.evaluate(() => {
        const results = [];
        const debugInfo = [];
        
        // ========== 檢查 "Complete" 文字 ==========
        const pageText = document.body.innerText || '';
        if (pageText.includes('Complete') && !pageText.includes('Dreaming') && !pageText.includes('Imagining')) {
          results.push({ type: 'complete-text', progress: 100, priority: 25 });
        }
        
        // ========== 檢查是否有完成的影片（新生成的）==========
        const videos = document.querySelectorAll('video');
        let hasPlayableVideo = false;
        videos.forEach(v => {
          // 檢查影片是否可播放
          if (v.src && (v.src.includes('.mp4') || v.src.includes('cdn.midjourney.com/video'))) {
            hasPlayableVideo = true;
          }
        });
        
        // 檢查新的影片縮圖
        const newThumbs = document.querySelectorAll('img[src*="cdn.midjourney.com/video"]');
        if (newThumbs.length > 0) {
          results.push({ type: 'video-thumb', progress: 100, priority: 22 });
        }
        
        // 如果有可播放的影片，可能已完成
        if (hasPlayableVideo) {
          results.push({ type: 'video-ready', progress: 100, priority: 20 });
        }
        
        // ========== 方法1: 直接找頁面上所有包含百分比的文字 ==========
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          // 只檢查葉子節點的文字
          if (el.children.length === 0 || el.tagName === 'SPAN' || el.tagName === 'DIV') {
            const text = el.textContent?.trim() || '';
            // 匹配 "XX%" 格式，但排除太長的文字
            if (text.length < 50) {
              const match = text.match(/(\d{1,3})%/);
              if (match && !text.includes('zoom') && !text.includes('scale')) {
                const num = parseInt(match[1]);
                if (num > 0 && num <= 100) {
                  results.push({ type: 'text-node', progress: num, priority: 12, text: text.slice(0, 30) });
                }
              }
            }
          }
        }
        
        // ========== 方法2: 找 "Dreaming" 或 "Imagining" 狀態文字 ==========
        const dreamingMatch = pageText.match(/(?:Dreaming|Imagining|Rendering|Processing)[^\d]*(\d{1,3})%/i);
        if (dreamingMatch) {
          results.push({ type: 'dreaming', progress: parseInt(dreamingMatch[1]), priority: 15 });
        }
        
        // ========== 方法3: 找進度條 ==========
        const progressBars = document.querySelectorAll('[class*="progress"], [class*="Progress"], [role="progressbar"]');
        progressBars.forEach(bar => {
          const style = window.getComputedStyle(bar);
          const width = style.width;
          const parentWidth = bar.parentElement ? window.getComputedStyle(bar.parentElement).width : null;
          
          if (width && parentWidth) {
            const barW = parseFloat(width);
            const parentW = parseFloat(parentWidth);
            if (parentW > 0) {
              const percent = Math.round((barW / parentW) * 100);
              if (percent > 0 && percent <= 100) {
                results.push({ type: 'bar-calc', progress: percent, priority: 8 });
              }
            }
          }
        });
        
        // ========== 方法4: 檢查是否沒有進行中的任務（可能已完成）==========
        const hasProcessingText = pageText.includes('Dreaming') || pageText.includes('Imagining') || 
                                  pageText.includes('Processing') || pageText.includes('Rendering');
        if (!hasProcessingText && (videos.length > 0 || newThumbs.length > 0)) {
          // 沒有處理中的文字，但有影片 = 可能完成
          results.push({ type: 'no-processing', progress: 100, priority: 18 });
        }
        
        return { results, debug: debugInfo };
      });
      
      // 找出最可靠的進度值（優先級最高的）
      let bestProgress = -1;
      let bestPriority = -1;
      let bestSource = null;
      
      for (const data of progressData.results) {
        if (data.progress >= 0 && data.progress <= 100) {
          if (data.priority > bestPriority) {
            bestPriority = data.priority;
            bestProgress = data.progress;
            bestSource = data.type;
          }
        }
      }
      
      // 如果偵測到 100%，立即完成
      if (bestProgress === 100 && bestPriority >= 18) {
        console.log(`📊 偵測到完成信號: ${bestSource}`);
        bestProgress = 100;
      }
      
      // 檢查進度是否停滯（連續相同的高進度值）
      if (bestProgress >= 85 && bestProgress === lastProgress) {
        stableCount++;
        highProgressCount++;
        console.log(`📊 高進度穩定: ${bestProgress}% (連續 ${stableCount} 次)`);
        
        // 如果進度 >= 85% 且連續穩定 5 次（10秒），認為完成
        if (stableCount >= 5) {
          bestProgress = 100;
          bestSource = 'stable-timeout';
          console.log('📊 進度穩定超過 10 秒，視為完成');
        }
      } else if (bestProgress >= 90) {
        // 高進度但還在變化
        highProgressCount++;
        stableCount = 0;
        
        // 如果長時間維持在高進度（超過 15 次 = 30秒），視為完成
        if (highProgressCount >= 15) {
          bestProgress = 100;
          bestSource = 'high-progress-timeout';
          console.log('📊 長時間高進度，視為完成');
        }
      } else {
        stableCount = 0;
        if (bestProgress < 85) highProgressCount = 0;
      }
      lastProgress = bestProgress;
      
      // 如果找到進度，更新並廣播
      if (bestProgress >= 0) {
        console.log(`📊 偵測到進度: ${bestProgress}% (來源: ${bestSource})`);
        
        for (const [jobId, job] of currentJobs) {
          if (job.status !== 'complete') {
            const oldProgress = job.progress || 0;
            
            // 更新進度
            if (bestProgress !== oldProgress || bestProgress === 100) {
              job.progress = bestProgress;
              job.status = bestProgress === 100 ? 'complete' : 'processing';
              
              // 廣播進度更新
              broadcast({
                type: 'progress',
                jobId,
                progress: bestProgress,
                status: job.status,
                source: bestSource
              });
              
              if (bestProgress < 100) {
                wsLog('info', `進度: ${bestProgress}%`);
              }
              
              if (bestProgress === 100 && job.status === 'complete') {
                wsLog('success', '影片生成完成！');
                broadcast({
                  type: 'video_complete',
                  jobId,
                  message: '影片生成完成！'
                });
                // 自動抓取影片
                setTimeout(() => fetchAndBroadcastVideos(), 3000);
                // 停止監控這個任務
                currentJobs.delete(jobId);
              }
            }
          }
        }
      }
    } catch (e) {
      console.log('⚠️ 進度監控錯誤:', e.message);
    }
  }, 2000); // 每 2 秒檢查一次
}

/**
 * 自動抓取並廣播影片
 */
async function fetchAndBroadcastVideos() {
  if (!page) return;
  
  try {
    wsLog('info', '自動抓取生成的影片...');
    
    const videos = await page.evaluate(() => {
      const results = [];
      
      // 找所有 video 元素
      document.querySelectorAll('video').forEach(video => {
        const src = video.src || video.querySelector('source')?.src;
        if (src && (src.includes('.mp4') || src.includes('video'))) {
          results.push({ url: src, type: 'video' });
        }
      });
      
      // 找頁面中的 mp4 連結
      const html = document.body.innerHTML;
      const mp4Matches = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/g);
      if (mp4Matches) {
        mp4Matches.forEach(url => {
          const cleanUrl = url.replace(/[\\'"]/g, '');
          if (!results.some(r => r.url === cleanUrl)) {
            results.push({ url: cleanUrl, type: 'regex' });
          }
        });
      }
      
      return results;
    });
    
    const uniqueVideos = [...new Map(videos.map(v => [v.url, v])).values()].slice(0, 4);
    
    if (uniqueVideos.length > 0) {
      wsLog('success', `找到 ${uniqueVideos.length} 部影片`);
      broadcast({
        type: 'videos_found',
        videos: uniqueVideos
      });
    }
  } catch (e) {
    console.log('抓取影片錯誤:', e.message);
  }
}

/**
 * 停止進度監控
 */
function stopProgressMonitor() {
  if (progressMonitorInterval) {
    clearInterval(progressMonitorInterval);
    progressMonitorInterval = null;
  }
}

// ==================== 瀏覽器管理 ====================

/**
 * 連接到用戶自己開啟的 Chrome 瀏覽器
 */
async function connectToUserBrowser() {
  console.log('🔌 嘗試連接到你的 Chrome 瀏覽器...');
  console.log(`📍 連接端口: ${REMOTE_DEBUGGING_PORT}`);
  
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${REMOTE_DEBUGGING_PORT}`);
    const contexts = browser.contexts();
    
    if (contexts.length > 0) {
      const context = contexts[0];
      const pages = context.pages();
      page = pages.find(p => p.url().includes('midjourney.com')) || pages[0];
      
      if (!page) {
        page = await context.newPage();
      }
    } else {
      throw new Error('沒有找到瀏覽器 context');
    }
    
    connectionMode = 'connect';
    console.log('✅ 已連接到你的 Chrome 瀏覽器！');
    console.log(`📄 當前頁面: ${page.url()}`);
    
    // 自動檢查登入狀態
    const url = page.url();
    isLoggedIn = url.includes('midjourney.com') && !url.includes('/auth/');
    console.log(`🔐 登入狀態: ${isLoggedIn ? '已登入' : '未登入'}`);
    
    return true;
  } catch (error) {
    console.log('❌ 無法連接，請確認 Chrome 已用以下指令開啟:');
    console.log(`\n/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${REMOTE_DEBUGGING_PORT}\n`);
    throw error;
  }
}

/**
 * 啟動獨立的 Playwright 瀏覽器
 */
async function launchStandaloneBrowser() {
  // 如果瀏覽器已開啟但 page 無效，重新創建 page
  if (browser) {
    try {
      // 測試 page 是否還有效
      await page.title();
      console.log('瀏覽器已經開啟');
      return;
    } catch (e) {
      // page 已失效，重新創建
      console.log('🔄 重新創建頁面...');
      page = await browser.newPage();
      return;
    }
  }

  // 確保資料目錄存在
  if (!existsSync(USER_DATA_DIR)) {
    mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  console.log('🚀 啟動瀏覽器...');
  console.log(`📁 Session 存儲於: ${USER_DATA_DIR}`);
  
  // 使用 persistent context 保存 cookies 和 localStorage
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, // 顯示瀏覽器 UI
    slowMo: 50,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  browser = context; // persistent context 本身就是 browser + context
  page = context.pages()[0] || await context.newPage();
  
  // 監聽頁面關閉事件
  page.on('close', () => {
    console.log('⚠️ 頁面被關閉');
  });
  
  // 監聽網絡請求（用於捕捉 API 響應）
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/imagine-update') || url.includes('/api/imagine?')) {
      try {
        const data = await response.json();
        handleImagineUpdate(data);
      } catch (e) {
        // 忽略非 JSON 響應
      }
    }
  });

  console.log('✅ 瀏覽器已啟動（登入狀態會自動保存）');
}

/**
 * 主要的啟動函數 - 優先連接用戶瀏覽器，失敗則啟動獨立瀏覽器
 */
async function launchBrowser(mode = 'auto') {
  if (mode === 'connect' || mode === 'auto') {
    try {
      await connectToUserBrowser();
      return;
    } catch (e) {
      if (mode === 'connect') {
        throw e;
      }
      console.log('⚠️ 無法連接用戶瀏覽器，啟動獨立瀏覽器...');
    }
  }
  
  await launchStandaloneBrowser();
}

/**
 * 處理 imagine-update 響應
 */
function handleImagineUpdate(data) {
  if (data?.jobs) {
    for (const job of data.jobs) {
      if (currentJobs.has(job.id)) {
        currentJobs.set(job.id, {
          ...currentJobs.get(job.id),
          status: job.status,
          progress: job.progress,
          result: job,
        });
      }
    }
  }
}

/**
 * 導航到 Midjourney
 */
async function navigateToMidjourney() {
  if (!page) {
    throw new Error('瀏覽器未啟動');
  }

  await page.goto('https://www.midjourney.com/imagine', { 
    timeout: 60000,
    waitUntil: 'domcontentloaded' 
  });
  
  // 等待頁面穩定
  await page.waitForTimeout(3000);
  
  // 檢查是否已登入
  const url = page.url();
  isLoggedIn = !url.includes('/auth/');
  
  return isLoggedIn;
}

/**
 * 檢查登入狀態
 */
async function checkLoginStatus() {
  if (!page) return false;
  
  const url = page.url();
  isLoggedIn = url.includes('midjourney.com') && !url.includes('/auth/');
  return isLoggedIn;
}

// ==================== Midjourney 操作 ====================

/**
 * 從圖片生成影片
 * @param {string} imageUrl - 圖片 URL 或 job ID
 * @param {object} options - 選項 { duration, motion }
 */
async function generateVideoFromImage(imageUrl, options = {}) {
  if (!page || !isLoggedIn) {
    throw new Error('請先登入 Midjourney');
  }

  const { duration = 5, motion = 'auto' } = options;

  // 方法 1: 如果是 Midjourney 圖片，使用 Animate 按鈕
  if (imageUrl.includes('cdn.midjourney.com') || imageUrl.startsWith('job:')) {
    return await animateExistingImage(imageUrl);
  }

  // 方法 2: 上傳外部圖片
  return await uploadAndAnimate(imageUrl, options);
}

/**
 * 上傳本地圖片並生成影片
 * @param {string} localPath - 本地圖片路徑
 * @param {object} options - 選項 { duration, loop }
 */
async function uploadLocalImageAndAnimate(localPath, options = {}) {
  if (!page || !isLoggedIn) {
    throw new Error('請先登入 Midjourney');
  }

  const absolutePath = resolve(localPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`找不到檔案: ${absolutePath}`);
  }

  const { loop = true } = options;
  console.log(`📤 上傳圖片: ${absolutePath}`);
  console.log(`🔄 Loop: ${loop}`);

  // 確保在 imagine 頁面
  const currentUrl = page.url();
  if (!currentUrl.includes('/imagine')) {
    console.log('🌐 導航到 /imagine...');
    await page.goto('https://www.midjourney.com/imagine', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }

  // === 步驟 1: 點擊 "Add Images" 按鈕 ===
  console.log('1️⃣ 點擊 Add Images 按鈕...');
  const addImagesClicked = await page.evaluate(() => {
    // 找包含 "Add Images" 或 "Add First Frame" 文字的按鈕
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase() || '';
      if (text.includes('add images') || text.includes('add first frame') || text.includes('add')) {
        btn.click();
        return { success: true, text: btn.textContent };
      }
    }
    // 也嘗試找有圖片圖標的按鈕
    const imgButtons = document.querySelectorAll('button svg, button img');
    for (const icon of imgButtons) {
      const btn = icon.closest('button');
      if (btn) {
        btn.click();
        return { success: true, text: 'icon button' };
      }
    }
    return { success: false };
  });
  console.log(`   結果: ${JSON.stringify(addImagesClicked)}`);
  await page.waitForTimeout(1000);

  // === 步驟 2: 點擊 "Upload a file or drop it here" 觸發 file chooser ===
  console.log('2️⃣ 點擊上傳按鈕，等待 file chooser...');
  
  // 設置 file chooser 監聽，然後點擊上傳按鈕
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null),
    page.evaluate(() => {
      // 找 "Upload a file" 或 "drop it here" 的元素
      const elements = document.querySelectorAll('*');
      for (const el of elements) {
        const text = el.textContent?.toLowerCase() || '';
        if ((text.includes('upload a file') || text.includes('drop it here')) && 
            el.offsetParent !== null && 
            el.tagName !== 'BODY' && 
            el.tagName !== 'HTML') {
          // 找到最近的可點擊祖先
          const clickable = el.closest('button, [role="button"], .cursor-pointer') || el;
          clickable.click();
          return { clicked: true, text: el.textContent?.slice(0, 50) };
        }
      }
      // 備用：找 input[type="file"]
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        fileInput.click();
        return { clicked: true, text: 'file input' };
      }
      return { clicked: false };
    })
  ]);

  // === 步驟 3: 上傳圖片 ===
  if (fileChooser) {
    console.log('3️⃣ 上傳檔案...');
    await fileChooser.setFiles(absolutePath);
    console.log('   ✅ 檔案已選擇');
  } else {
    // 如果 file chooser 沒觸發，嘗試直接用 input
    console.log('   ⚠️ file chooser 未觸發，嘗試直接設置 input...');
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles(absolutePath);
      console.log('   ✅ 通過 input 上傳');
    } else {
      throw new Error('無法找到上傳方式');
    }
  }

  // === 步驟 4: 等待圖片上傳完成（出現在 Starting Frame） ===
  console.log('4️⃣ 等待圖片上傳完成...');
  await page.waitForTimeout(3000);

  // 確認圖片已上傳（檢查是否有 Starting Frame 或縮圖）
  const uploadConfirmed = await page.evaluate(() => {
    // 檢查是否有圖片縮圖
    const thumbnails = document.querySelectorAll('img[src*="blob:"], img[src*="midjourney"], img[src*="data:"]');
    for (const img of thumbnails) {
      if (img.offsetParent !== null && img.width > 30) {
        return { hasImage: true, src: img.src?.slice(0, 50) };
      }
    }
    // 檢查是否有 Video/Starting Frame 相關 UI
    const videoUI = document.body.textContent?.includes('Starting Frame') || 
                    document.body.textContent?.includes('Ending Frame');
    return { hasImage: false, videoUI };
  });
  console.log(`   上傳確認: ${JSON.stringify(uploadConfirmed)}`);

  // === 步驟 5: 如果需要 Loop，勾選 Loop checkbox ===
  if (loop) {
    console.log('5️⃣ 勾選 Loop...');
    const loopClicked = await page.evaluate(() => {
      // 找 Loop checkbox 或相關元素
      const labels = document.querySelectorAll('label, span, div');
      for (const el of labels) {
        if (el.textContent?.trim().toLowerCase() === 'loop' && el.offsetParent !== null) {
          // 點擊 label 或其中的 checkbox
          const checkbox = el.querySelector('input[type="checkbox"]') || 
                          el.closest('label')?.querySelector('input[type="checkbox"]');
          if (checkbox && !checkbox.checked) {
            checkbox.click();
            return { clicked: true, wasChecked: false };
          } else if (checkbox?.checked) {
            return { clicked: false, wasChecked: true };
          }
          // 直接點擊元素
          el.click();
          return { clicked: true, element: 'label' };
        }
      }
      return { clicked: false, notFound: true };
    });
    console.log(`   Loop: ${JSON.stringify(loopClicked)}`);
    await page.waitForTimeout(500);
  }

  // === 步驟 6: 按 Enter 提交生成！（不要按 Escape！）===
  console.log('6️⃣ 按 Enter 提交生成...');
  await page.keyboard.press('Enter');
  console.log('   ✅ 已按 Enter');

  // 等待任務開始
  await page.waitForTimeout(3000);
  
  // 獲取最新的 job ID
  const jobId = await getLatestJobId();
  
  if (jobId) {
    currentJobs.set(jobId, {
      id: jobId,
      status: 'starting',
      progress: 0,
      createdAt: new Date(),
      localPath: absolutePath,
    });
    
    // 啟動進度監控
    startProgressMonitor();
    
    // 廣播任務開始
    broadcast({
      type: 'job_started',
      jobId,
      message: '影片生成任務已開始'
    });
    
    return { success: true, jobId, message: '影片生成任務已開始' };
  }

  // 即使沒有 jobId，也生成一個臨時 ID 來追蹤進度
  const tempJobId = `temp-${Date.now()}`;
  currentJobs.set(tempJobId, {
    id: tempJobId,
    status: 'starting',
    progress: 0,
    createdAt: new Date(),
    localPath: absolutePath,
  });
  
  // 啟動進度監控
  startProgressMonitor();
  
  broadcast({
    type: 'job_started',
    jobId: tempJobId,
    message: '任務已提交，開始追蹤進度'
  });
  
  return { 
    success: true, 
    jobId: tempJobId, 
    message: '任務已提交，正在追蹤進度' 
  };
}

/**
 * 等待影片完成並返回 URL
 */
async function waitForVideoComplete(jobId, maxWaitMs = 180000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    // 刷新頁面狀態
    await page.waitForTimeout(5000);
    
    // 檢查影片是否完成
    const videoResult = await getVideoUrl(jobId, 0);
    if (videoResult.success) {
      return {
        success: true,
        jobId,
        videos: [
          await getVideoUrl(jobId, 0),
          await getVideoUrl(jobId, 1),
          await getVideoUrl(jobId, 2),
          await getVideoUrl(jobId, 3),
        ].filter(v => v.success),
      };
    }
    
    // 從頁面獲取進度
    const progress = await page.evaluate((id) => {
      const jobLinks = document.querySelectorAll(`a[href*="/jobs/${id}"]`);
      for (const link of jobLinks) {
        const parent = link.closest('[class*="group"]');
        const progressText = parent?.textContent;
        if (progressText?.includes('%')) {
          const match = progressText.match(/(\d+)%/);
          return match ? parseInt(match[1]) : 0;
        }
        if (progressText?.includes('Complete')) {
          return 100;
        }
      }
      return -1;
    }, jobId);
    
    if (progress >= 0) {
      console.log(`⏳ 進度: ${progress}%`);
      if (currentJobs.has(jobId)) {
        currentJobs.get(jobId).progress = progress;
      }
    }
  }
  
  return { success: false, message: '等待超時' };
}

/**
 * 動畫化現有的 Midjourney 圖片
 */
async function animateExistingImage(jobIdOrUrl) {
  // 找到 Animate 按鈕並點擊
  const animateButtons = await page.$$('button:has-text("Animate")');
  
  if (animateButtons.length > 0) {
    await animateButtons[0].click();
    
    // 等待任務開始
    await page.waitForTimeout(2000);
    
    // 獲取新創建的 job ID
    const jobId = await getLatestJobId();
    
    if (jobId) {
      currentJobs.set(jobId, {
        id: jobId,
        status: 'starting',
        progress: 0,
        createdAt: new Date(),
      });
      
      return { success: true, jobId };
    }
  }

  throw new Error('找不到 Animate 按鈕');
}

/**
 * 上傳圖片並動畫化
 */
async function uploadAndAnimate(imageUrl, options) {
  // 點擊 Add First Frame 按鈕
  const addFrameBtn = await page.$('button:has-text("Add First Frame")');
  if (addFrameBtn) {
    await addFrameBtn.click();
    await page.waitForTimeout(500);
  }

  // 點擊 Start 區域
  const startArea = await page.$('text=Start >> xpath=ancestor::div[contains(@class, "cursor-pointer")]');
  if (startArea) {
    await startArea.click();
    await page.waitForTimeout(500);
  }

  // 輸入圖片 URL 到 prompt
  const textbox = await page.$('textarea, input[placeholder*="imagine"]');
  if (textbox) {
    await textbox.fill(imageUrl);
  }

  // 點擊提交按鈕
  const submitBtn = await page.$('button[type="submit"], button:has(img[src*="arrow"])');
  if (submitBtn) {
    await submitBtn.click();
  }

  // 等待任務開始
  await page.waitForTimeout(3000);
  
  const jobId = await getLatestJobId();
  
  if (jobId) {
    currentJobs.set(jobId, {
      id: jobId,
      status: 'starting',
      progress: 0,
      createdAt: new Date(),
    });
    
    return { success: true, jobId };
  }

  throw new Error('無法創建任務');
}

/**
 * 獲取最新的 job ID
 */
async function getLatestJobId() {
  // 從頁面 URL 或 DOM 獲取最新 job ID
  const links = await page.$$('a[href*="/jobs/"]');
  
  for (const link of links) {
    const href = await link.getAttribute('href');
    const match = href.match(/\/jobs\/([a-f0-9-]+)/);
    if (match) {
      return match[1];
    }
  }
  
  return null;
}

/**
 * 獲取任務狀態
 */
async function getJobStatus(jobId) {
  if (currentJobs.has(jobId)) {
    return currentJobs.get(jobId);
  }

  // 從頁面獲取狀態
  const jobInfo = await page.evaluate((id) => {
    const links = document.querySelectorAll(`a[href*="/jobs/${id}"]`);
    if (links.length > 0) {
      const parent = links[0].closest('[class*="cursor-pointer"]');
      const progress = parent?.querySelector('[class*="Complete"]');
      return {
        found: true,
        progress: progress?.textContent || 'unknown',
      };
    }
    return { found: false };
  }, jobId);

  return jobInfo;
}

/**
 * 獲取影片 URL
 */
async function getVideoUrl(jobId, index = 0) {
  // Midjourney 影片 CDN 格式
  const videoUrl = `https://cdn.midjourney.com/video/${jobId}/${index}_640_N.webp`;
  
  // 驗證影片是否存在
  try {
    const response = await fetch(videoUrl, { method: 'HEAD' });
    if (response.ok) {
      return {
        success: true,
        videoUrl,
        thumbnailUrl: `https://cdn.midjourney.com/video/${jobId}/${index}_640_N.webp?frame=last`,
      };
    }
  } catch (e) {
    // 影片可能還在生成中
  }

  return { success: false, message: '影片尚未準備好' };
}

/**
 * 獲取用戶的所有創作
 */
async function getUserCreations() {
  if (!page || !isLoggedIn) {
    throw new Error('請先登入 Midjourney');
  }

  // 從頁面獲取創作列表
  const creations = await page.evaluate(() => {
    const items = [];
    const links = document.querySelectorAll('a[href*="/jobs/"]');
    
    links.forEach(link => {
      const href = link.getAttribute('href');
      const img = link.querySelector('img');
      const match = href.match(/\/jobs\/([a-f0-9-]+)\?index=(\d+)/);
      
      if (match && img) {
        items.push({
          jobId: match[1],
          index: parseInt(match[2]),
          thumbnailUrl: img.src,
          isVideo: img.src.includes('/video/'),
        });
      }
    });
    
    return items;
  });

  return creations;
}

// ==================== REST API 端點 ====================

/**
 * 圖片上傳
 */
app.post('/upload', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '沒有上傳檔案' });
    }
    
    const filePath = join(UPLOAD_DIR, req.file.filename);
    wsLog('success', `圖片已儲存: ${req.file.filename}`);
    
    res.json({
      success: true,
      filePath: filePath,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size
    });
  } catch (error) {
    wsLog('error', `上傳失敗: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 健康檢查
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    browserReady: !!browser,
    isLoggedIn,
    activeJobs: currentJobs.size,
  });
});

/**
 * Debug - 獲取當前頁面資訊
 */
app.get('/debug/page', async (req, res) => {
  try {
    if (!page) {
      return res.json({ success: false, error: '沒有頁面' });
    }
    
    const url = page.url();
    const title = await page.title();
    
    // 截圖
    const screenshot = await page.screenshot({ encoding: 'base64' });
    
    res.json({ 
      success: true, 
      url, 
      title,
      screenshotBase64: screenshot.substring(0, 100) + '...(truncated)',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Debug - 截圖並保存到本地
 */
app.post('/debug/screenshot', async (req, res) => {
  try {
    if (!page) {
      return res.json({ success: false, error: '沒有頁面' });
    }
    
    const filePath = '/tmp/midjourney-debug.png';
    await page.screenshot({ path: filePath });
    
    res.json({ 
      success: true, 
      message: `截圖已保存到 ${filePath}`,
      filePath,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 啟動瀏覽器
 */
app.post('/browser/launch', async (req, res) => {
  try {
    const mode = req.body?.mode || 'auto'; // 'auto', 'connect', 'standalone'
    await launchBrowser(mode);
    res.json({ success: true, message: '瀏覽器已啟動', mode: connectionMode });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 連接到用戶的 Chrome 瀏覽器
 */
app.post('/browser/connect', async (req, res) => {
  try {
    await connectToUserBrowser();
    res.json({ success: true, message: '已連接到你的 Chrome 瀏覽器' });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      hint: '請用以下指令開啟 Chrome:\n/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222'
    });
  }
});

/**
 * 導航到 Midjourney
 */
app.post('/browser/navigate', async (req, res) => {
  try {
    const loggedIn = await navigateToMidjourney();
    res.json({ 
      success: true, 
      isLoggedIn: loggedIn,
      message: loggedIn ? '已登入' : '請在瀏覽器中手動登入',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 檢查登入狀態
 */
app.get('/auth/status', async (req, res) => {
  try {
    const loggedIn = await checkLoginStatus();
    res.json({ success: true, isLoggedIn: loggedIn });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 生成影片
 */
app.post('/video/generate', async (req, res) => {
  try {
    const { imageUrl, options } = req.body;
    
    if (!imageUrl) {
      return res.status(400).json({ success: false, error: '缺少 imageUrl' });
    }

    const result = await generateVideoFromImage(imageUrl, options);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 從現有圖片動畫化
 */
app.post('/video/animate', async (req, res) => {
  try {
    const result = await animateExistingImage(req.body.jobId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 上傳本地圖片並生成影片
 */
app.post('/video/upload', async (req, res) => {
  try {
    const { imagePath, options } = req.body;
    
    if (!imagePath) {
      return res.status(400).json({ success: false, error: '缺少 imagePath' });
    }

    const result = await uploadLocalImageAndAnimate(imagePath, options);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 上傳圖片並等待影片完成
 */
app.post('/video/upload-and-wait', async (req, res) => {
  try {
    const { imagePath, options } = req.body;
    
    if (!imagePath) {
      return res.status(400).json({ success: false, error: '缺少 imagePath' });
    }

    // 上傳並開始生成
    const uploadResult = await uploadLocalImageAndAnimate(imagePath, options);
    
    if (!uploadResult.success) {
      return res.json(uploadResult);
    }

    // 等待完成
    const videoResult = await waitForVideoComplete(uploadResult.jobId);
    res.json(videoResult);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 獲取任務狀態
 */
app.get('/job/:jobId/status', async (req, res) => {
  try {
    const status = await getJobStatus(req.params.jobId);
    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 獲取影片 URL
 */
app.get('/job/:jobId/video', async (req, res) => {
  try {
    const index = parseInt(req.query.index) || 0;
    const result = await getVideoUrl(req.params.jobId, index);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 獲取用戶創作列表
 */
app.get('/creations', async (req, res) => {
  try {
    const creations = await getUserCreations();
    res.json({ success: true, creations });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 從頁面抓取最新生成的影片
 */
app.post('/videos/fetch', async (req, res) => {
  try {
    if (!page) {
      return res.status(400).json({ success: false, error: '瀏覽器未連線' });
    }
    
    // 可選：指定要抓取的 Job ID
    const targetJobId = req.body?.jobId;
    
    wsLog('info', '正在從 Midjourney 頁面抓取影片...');
    
    const videos = await page.evaluate(() => {
      const results = [];
      const debug = [];
      const jobsMap = new Map(); // 用 Map 按 Job ID 分組
      
      // ========== 從 jobs 連結提取 Job ID ==========
      const jobLinks = document.querySelectorAll('a[href*="/jobs/"]');
      debug.push(`找到 ${jobLinks.length} 個 jobs 連結`);
      
      // 按出現順序記錄 Job ID（頁面上最先出現的是最新的）
      const jobOrder = [];
      
      jobLinks.forEach(link => {
        const href = link.getAttribute('href');
        const match = href?.match(/\/jobs\/([a-f0-9-]+)\?index=(\d+)/);
        if (match) {
          const jobId = match[1];
          const index = parseInt(match[2]);
          
          // 記錄 Job 出現順序
          if (!jobOrder.includes(jobId)) {
            jobOrder.push(jobId);
          }
          
          // 按 Job ID 分組
          if (!jobsMap.has(jobId)) {
            jobsMap.set(jobId, []);
          }
          
          const videoUrl = `https://cdn.midjourney.com/video/${jobId}/${index}.mp4`;
          const thumbUrl = `https://cdn.midjourney.com/video/${jobId}/${index}_640_N.webp?frame=last`;
          
          // 避免重複
          const existing = jobsMap.get(jobId);
          if (!existing.some(v => v.index === index)) {
            existing.push({
              url: videoUrl,
              thumbnail: thumbUrl,
              jobId: jobId,
              index: index,
              type: 'job-link'
            });
          }
        }
      });
      
      debug.push(`提取到 ${jobsMap.size} 個不同的 Job ID`);
      debug.push(`Job 順序: ${jobOrder.slice(0, 3).join(', ')}...`);
      
      return { jobsMap: Object.fromEntries(jobsMap), jobOrder, debug };
    });
    
    // 輸出調試資訊
    console.log('🔍 影片抓取調試:');
    videos.debug.forEach(d => console.log(`   ${d}`));
    
    // 取最新的 Job（頁面上第一個出現的）
    const latestJobId = targetJobId || videos.jobOrder[0];
    
    if (!latestJobId) {
      wsLog('warning', '未找到任何影片');
      return res.json({ success: true, videos: [] });
    }
    
    console.log(`📹 選擇最新 Job: ${latestJobId}`);
    
    // 取該 Job 的所有影片並按 index 排序
    const jobVideos = videos.jobsMap[latestJobId] || [];
    const sortedVideos = jobVideos.sort((a, b) => a.index - b.index);
    
    console.log('📹 該 Job 的影片:');
    sortedVideos.forEach((v, i) => console.log(`   [${i + 1}] index=${v.index}: ${v.url}`));
    
    wsLog('success', `找到 ${sortedVideos.length} 部影片 (Job: ${latestJobId.slice(0, 8)}...)`);
    
    // 廣播到前端
    broadcast({
      type: 'videos_found',
      videos: sortedVideos,
      jobId: latestJobId
    });
    
    res.json({ success: true, videos: sortedVideos, jobId: latestJobId });
  } catch (error) {
    wsLog('error', `抓取影片失敗: ${error.message}`);
    console.error('抓取影片錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 關閉瀏覽器
 */
app.post('/browser/close', async (req, res) => {
  try {
    if (browser) {
      await browser.close();
      browser = null;
      page = null;
      isLoggedIn = false;
    }
    res.json({ success: true, message: '瀏覽器已關閉' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 健康檢查 ====================

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'ok' });
});

// ==================== 啟動 Chrome ====================

app.post('/browser/launch', async (req, res) => {
  try {
    // 檢查 Chrome 是否已經開啟
    const checkPort = await fetch(`http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/version`).catch(() => null);
    
    if (checkPort) {
      wsLog('info', 'Chrome 已經在運行中');
      return res.json({ success: true, message: 'Chrome 已開啟' });
    }
    
    // 啟動 Chrome
    wsLog('info', '🚀 正在啟動 Chrome...');
    
    const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      `--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`,
      '--user-data-dir=/tmp/chrome-mj-debug',
      '--no-first-run',
      '--no-default-browser-check'
    ], {
      detached: true,
      stdio: 'ignore'
    });
    
    chrome.unref();
    
    // 等待 Chrome 啟動
    await new Promise(r => setTimeout(r, 2000));
    
    wsLog('success', '✅ Chrome 已啟動');
    res.json({ success: true, message: 'Chrome 已啟動' });
  } catch (error) {
    wsLog('error', `❌ ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 啟動服務器 ====================

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🎬 Midjourney Proxy Server                               ║
║                                                            ║
║   🌐 控制面板: http://localhost:${PORT}                      ║
║   📡 WebSocket: ws://localhost:${PORT}                       ║
║                                                            ║
║   直接在瀏覽器開啟 http://localhost:${PORT} 即可使用          ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
});

// 優雅關閉
process.on('SIGINT', async () => {
  console.log('\n正在關閉服務...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});
