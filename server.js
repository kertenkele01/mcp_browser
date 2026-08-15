import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

// Connected Android devices map: deviceId -> WebSocket
const androidDevices = new Map();
// Pending promises: messageId -> { resolve, reject, timeout }
const pendingRequests = new Map();

// --- WebSocket Handling for Android Device ---
wss.on('connection', (ws, req) => {
  let registeredDeviceId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'register') {
        const { deviceId, token } = data;
        if (AUTH_TOKEN && token !== AUTH_TOKEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
          ws.close();
          return;
        }
        registeredDeviceId = deviceId || 'android_default';
        androidDevices.set(registeredDeviceId, ws);
        console.log(`[WS] Android device registered: ${registeredDeviceId}`);
        ws.send(JSON.stringify({ type: 'registered', deviceId: registeredDeviceId }));
        return;
      }

      if (data.type === 'response' && data.messageId) {
        const pending = pendingRequests.get(data.messageId);
        if (pending) {
          pending.resolve(data);
          clearTimeout(pending.timeout);
          pendingRequests.delete(data.messageId);
        }
      }
    } catch (e) {
      console.error('[WS] Error processing message:', e);
    }
  });

  ws.on('close', () => {
    if (registeredDeviceId) {
      androidDevices.delete(registeredDeviceId);
      console.log(`[WS] Android device disconnected: ${registeredDeviceId}`);
    }
  });
});

function sendCommandToDevice(deviceId, commandType, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = androidDevices.get(deviceId || 'android_default') || androidDevices.values().next().value;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('Android cihazı bağlı değil. Lütfen uygulamayı açın ve MCP bağlantısını başlatın.'));
    }

    const messageId = 'msg_' + Math.random().toString(36).substring(2, 9);
    const timeout = setTimeout(() => {
      pendingRequests.delete(messageId);
      reject(new Error('Android cihazından 30 saniye boyunca yanıt alınamadı.'));
    }, 30000);

    pendingRequests.set(messageId, { resolve, reject, timeout });

    ws.send(JSON.stringify({
      type: commandType,
      messageId,
      ...params
    }));
  });
}

// --- MCP Tools Definition ---
const MCP_TOOLS = [
  // 🌐 BROWSER TOOLS
  {
    name: 'browser_navigate',
    description: 'Android WebView tarayıcısında belirtilen URL adresine gider.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Açılacak web sitesi URL adresi (örn: https://google.com)' }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_click',
    description: 'Aktif web sayfasındaki bir HTML öğesine tıklar.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Tıklanacak CSS seçici (örn: button#submit, a.login-btn)' }
      },
      required: ['selector']
    }
  },
  {
    name: 'browser_type',
    description: 'Aktif web sayfasındaki bir input kutusuna metin yazar.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS seçici (örn: input[name=q])' },
        text: { type: 'string', description: 'Yazılacak metin' }
      },
      required: ['selector', 'text']
    }
  },
  {
    name: 'browser_scroll',
    description: 'Web sayfasını yukarı veya aşağı kaydırır.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Kaydırma yönü' },
        amount: { type: 'integer', description: 'Kaydırılacak piksel miktarı (varsayılan 500)' }
      }
    }
  },
  {
    name: 'browser_get_html',
    description: 'Sayfanın optimize edilmiş Markdown veya HTML içeriğini döker.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_get_markdown',
    description: 'Sayfanın yapay zeka için temizlenmiş Markdown içeriğini döker.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_screenshot',
    description: 'Aktif tarayıcı sekmesinin Base64 ekran görüntüsünü çeker.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_execute_js',
    description: 'Web sayfasında özel JavaScript kodu çalıştırır.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Çalıştırılacak JS kodu' }
      },
      required: ['script']
    }
  },
  {
    name: 'browser_new_tab',
    description: 'Yeni bir tarayıcı sekmesi açar.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Yeni sekmede açılacak opsiyonel URL' }
      }
    }
  },
  {
    name: 'browser_switch_tab',
    description: 'Belirtilen sekmeye geçiş yapar.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Geçilecek sekme IDsi' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser_close_tab',
    description: 'Belirtilen tarayıcı sekmesini kapatır.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Kapatılacak sekme IDsi' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'browser_list_tabs',
    description: 'Açık olan tüm sekmeleri listeler.',
    inputSchema: { type: 'object', properties: {} }
  },

  // 📱 ANDROID CİHAZ & SHIZUKU TOOLS
  {
    name: 'get_device_ui',
    description: 'Açık olan Android uygulamasının (WhatsApp, Instagram, Ayarlar, Galeri vb.) ekran UI buton, metin ve tıklanabilir koordinat [X, Y] ağacını sıkıştırılmış Markdown olarak döker.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'device_action',
    description: 'Android cihazda tıklama, metin yazma, ekran kaydırma, sistem tuşuna basma veya uygulama başlatma eylemlerini yürütür.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'type', 'swipe', 'key_press', 'open_app', 'stop_app'],
          description: 'Eylem türü (click, type, swipe, key_press, open_app, stop_app)'
        },
        x: { type: 'integer', description: 'Tıklanacak X piksel koordinatı (click için)' },
        y: { type: 'integer', description: 'Tıklanacak Y piksel koordinatı (click için)' },
        text: { type: 'string', description: 'Yazılacak metin (type için)' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Kaydırma yönü (swipe için)' },
        distance: { type: 'integer', description: 'Kaydırma mesafesi piksel (swipe için, varsayılan 500)' },
        key: { type: 'string', enum: ['HOME', 'BACK', 'ENTER', 'APP_SWITCH', 'POWER', 'VOLUME_UP', 'VOLUME_DOWN'], description: 'Sistem tuşu (key_press için)' },
        app: { type: 'string', description: 'Uygulama paket adı (open_app için, örn: com.whatsapp, com.android.settings)' }
      },
      required: ['action']
    }
  },
  {
    name: 'run_shizuku_cmd',
    description: 'Shizuku / ADB yetkileriyle cihaz üzerinde doğrudan Android Shell terminal komutu koşturur.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Çalıştırılacak shell komutu (örn: pm list packages, input keyevent 3, dumpsys battery)' }
      },
      required: ['command']
    }
  }
];

// --- MCP SSE Transport Setup ---
let sseTransport = null;

app.get('/sse', async (req, res) => {
  console.log('[SSE] New MCP client connected');
  sseTransport = new SSEServerTransport('/messages', res);
  
  const mcpServer = new Server(
    { name: 'android-browser-bridge-mcp', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: MCP_TOOLS };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.log(`[MCP] Tool invoked: ${name}`, args);

    try {
      let result;
      if (name.startsWith('browser_')) {
        const cmdType = name.replace('browser_', '');
        result = await sendCommandToDevice(args?.deviceId, cmdType === 'get_html' ? 'get_html' : cmdType, args);
      } else if (name === 'get_device_ui') {
        result = await sendCommandToDevice(args?.deviceId, 'get_device_ui', {});
      } else if (name === 'device_action') {
        result = await sendCommandToDevice(args?.deviceId, 'device_action', args);
      } else if (name === 'run_shizuku_cmd') {
        result = await sendCommandToDevice(args?.deviceId, 'run_shizuku_cmd', { cmd: args?.command });
      } else {
        throw new Error(`Bilinmeyen araç: ${name}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: typeof result?.data === 'string' ? result.data : JSON.stringify(result?.data || result, null, 2)
          }
        ]
      };
    } catch (err) {
      console.error(`[MCP] Error running tool ${name}:`, err);
      return {
        isError: true,
        content: [{ type: 'text', text: `Hata: ${err.message}` }]
      };
    }
  });

  await mcpServer.connect(sseTransport);
});

app.post('/messages', async (req, res) => {
  if (sseTransport) {
    await sseTransport.handlePostMessage(req, res);
  } else {
    res.status(400).send('No active SSE connection');
  }
});

// --- Web Dashboard UI ---
app.get('/', (req, res) => {
  const activeDeviceCount = androidDevices.size;
  const deviceListHtml = Array.from(androidDevices.keys())
    .map(id => `<span class="badge online">🟢 ${id}</span>`)
    .join(' ') || '<span class="badge offline">🔴 Hiçbir Android cihaz bağlı değil</span>';

  const browserToolsHtml = MCP_TOOLS.filter(t => t.name.startsWith('browser_'))
    .map(t => `<div class="tool-item"><span class="tool-name">${t.name}</span><p class="tool-desc">${t.description}</p></div>`)
    .join('');

  const deviceToolsHtml = MCP_TOOLS.filter(t => !t.name.startsWith('browser_'))
    .map(t => `<div class="tool-item device"><span class="tool-name device-tag">${t.name}</span><p class="tool-desc">${t.description}</p></div>`)
    .join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Android & Browser MCP Relay Server</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        body { background: #0f172a; color: #f8fafc; padding: 2rem 1rem; display: flex; justify-content: center; }
        .container { max-width: 900px; width: 100%; }
        .card { background: #1e293b; border-radius: 16px; padding: 1.5rem; margin-bottom: 1.5rem; border: 1px solid #334155; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3); }
        h1 { font-size: 1.6rem; color: #38bdf8; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; }
        p.subtitle { color: #94a3b8; font-size: 0.95rem; margin-bottom: 1rem; }
        .status-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; padding: 0.75rem 0; border-top: 1px solid #334155; }
        .badge { padding: 0.35rem 0.75rem; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; }
        .badge.online { background: rgba(34, 197, 94, 0.2); color: #4ade80; border: 1px solid #22c55e; }
        .badge.offline { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid #ef4444; }
        .section-title { font-size: 1.15rem; font-weight: 700; color: #f1f5f9; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }
        .tools-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 0.75rem; }
        .tool-item { background: #0f172a; padding: 0.85rem; border-radius: 10px; border: 1px solid #334155; }
        .tool-item.device { border-color: rgba(34, 197, 94, 0.4); background: rgba(15, 23, 42, 0.8); }
        .tool-name { font-family: monospace; font-size: 0.9rem; font-weight: 700; color: #38bdf8; }
        .tool-name.device-tag { color: #4ade80; }
        .tool-desc { font-size: 0.8rem; color: #94a3b8; margin-top: 0.35rem; line-height: 1.3; }
        .config-code { background: #090d16; padding: 1rem; border-radius: 8px; font-family: monospace; font-size: 0.85rem; color: #e2e8f0; overflow-x: auto; white-space: pre; border: 1px solid #1e293b; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="card">
          <h1>🤖 Android & Browser MCP Bridge Server</h1>
          <p class="subtitle">Android WebView ve Shizuku Cihaz Otomasyonu için Canlı Model Context Protocol Sunucusu</p>
          
          <div class="status-row">
            <span>Bağlı Android Cihazları (${activeDeviceCount})</span>
            <div>${deviceListHtml}</div>
          </div>
          <div class="status-row">
            <span>MCP SSE Endpoint:</span>
            <code style="color: #38bdf8; font-weight: 600;">/sse</code>
          </div>
        </div>

        <div class="card">
          <div class="section-title">📱 Android Cihaz & Shizuku Araçları (Device Tools)</div>
          <div class="tools-grid">
            ${deviceToolsHtml}
          </div>
        </div>

        <div class="card">
          <div class="section-title">🌐 Tarayıcı Araçları (Browser Tools)</div>
          <div class="tools-grid">
            ${browserToolsHtml}
          </div>
        </div>

        <div class="card">
          <div class="section-title">⚙️ Cursor / Claude Desktop Yapılandırması</div>
          <div class="config-code">{
  "mcpServers": {
    "android-mcp": {
      "url": "https://${req.headers.host || 'mcp-browser-1.onrender.com'}/sse"
    }
  }
}</div>
        </div>
      </div>
    </body>
    </html>
  `);
});

httpServer.listen(PORT, () => {
  console.log(`[HTTP/WS] Server listening on port ${PORT}`);
  console.log(`[MCP] SSE endpoint available at /sse`);
});
