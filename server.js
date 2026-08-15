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

const androidDevices = new Map();
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

// --- MCP TOOLS ---
const MCP_TOOLS = [
  // 🌐 BROWSER TOOLS
  {
    name: 'browser_navigate',
    description: 'Android WebView tarayıcısında belirtilen URL adresine gider.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Açılacak web sitesi URL adresi' } },
      required: ['url']
    }
  },
  {
    name: 'browser_click',
    description: 'Aktif web sayfasındaki bir HTML öğesine tıklar.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS seçici' } },
      required: ['selector']
    }
  },
  {
    name: 'browser_type',
    description: 'Aktif web sayfasındaki bir input kutusuna metin yazar.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS seçici' },
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
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
        amount: { type: 'integer' }
      }
    }
  },
  {
    name: 'browser_get_html',
    description: 'Sayfanın optimize edilmiş HTML içeriğini döker.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_get_markdown',
    description: 'Sayfanın temizlenmiş Markdown içeriğini döker.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_screenshot',
    description: 'Aktif tarayıcı sekmesinin Base64 ekran görüntüsünü çeker.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_execute_js',
    description: 'Web sayfasında JavaScript kodu çalıştırır.',
    inputSchema: {
      type: 'object',
      properties: { script: { type: 'string', description: 'JS kodu' } },
      required: ['script']
    }
  },
  {
    name: 'browser_new_tab',
    description: 'Yeni bir tarayıcı sekmesi açar.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } }
    }
  },
  {
    name: 'browser_switch_tab',
    description: 'Belirtilen sekmeye geçiş yapar.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId']
    }
  },
  {
    name: 'browser_close_tab',
    description: 'Belirtilen tarayıcı sekmesini kapatır.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
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
    description: 'Açık olan Android uygulamasının (WhatsApp, Ayarlar vb.) buton, metin ve koordinat ağacını sıkıştırılmış Markdown olarak döker.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'device_action',
    description: 'Android cihazda tıklama, metin yazma, kaydırma, tuşa basma veya uygulama başlatma eylemlerini yürütür.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'type', 'swipe', 'key_press', 'open_app', 'stop_app'],
          description: 'Eylem türü'
        },
        x: { type: 'integer', description: 'Tıklanacak X koordinatı' },
        y: { type: 'integer', description: 'Tıklanacak Y koordinatı' },
        text: { type: 'string', description: 'Yazılacak metin' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Kaydırma yönü' },
        distance: { type: 'integer', description: 'Kaydırma pikseli' },
        key: { type: 'string', enum: ['HOME', 'BACK', 'ENTER', 'APP_SWITCH', 'POWER'], description: 'Sistem tuşu' },
        app: { type: 'string', description: 'Uygulama paket adı (örn: com.whatsapp)' }
      },
      required: ['action']
    }
  },
  {
    name: 'run_shizuku_cmd',
    description: 'Shizuku / ADB yetkileriyle doğrudan Android Shell komutu koşturur.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Çalıştırılacak shell komutu' }
      },
      required: ['command']
    }
  }
];

// --- MCP SSE Server Transport ---
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

// --- Orijinal Temiz Web Paneli ---
app.get('/', (req, res) => {
  const activeDeviceCount = androidDevices.size;
  const deviceList = Array.from(androidDevices.keys()).join(', ') || 'Hiçbir cihaz bağlı değil';

  res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
      <meta charset="UTF-8">
      <title>Android Browser & Device MCP Server</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; background: #f8fafc; color: #1e293b; max-width: 800px; margin: 0 auto; line-height: 1.5; }
        h1 { color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.5rem; }
        .status { padding: 1rem; border-radius: 8px; margin: 1.5rem 0; background: ${activeDeviceCount > 0 ? '#dcfce7' : '#fee2e2'}; border: 1px solid ${activeDeviceCount > 0 ? '#86efac' : '#fca5a5'}; }
        .code { background: #1e293b; color: #f8fafc; padding: 1rem; border-radius: 8px; font-family: monospace; overflow-x: auto; margin: 1rem 0; }
        ul { padding-left: 1.5rem; }
        li { margin-bottom: 0.4rem; }
        .badge { background: #e0f2fe; color: #0369a1; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-family: monospace; }
        .device-badge { background: #dcfce7; color: #15803d; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-family: monospace; }
      </style>
    </head>
    <body>
      <h1>🌐 Android Browser & Device MCP Server</h1>
      <p>Bu sunucu, Android cihazınız ile Yapay Zeka (Cursor / Claude / Windsurf) arasında MCP köprüsü kurar.</p>
      
      <div class="status">
        <strong>Bağlı Cihaz Sayısı:</strong> ${activeDeviceCount}<br>
        <strong>Aktif Cihazlar:</strong> ${deviceList}
      </div>

      <h2>🔌 MCP İstemci Yapılandırması (SSE)</h2>
      <div class="code">{
  "mcpServers": {
    "android-mcp": {
      "url": "https://${req.headers.host || 'mcp-browser-1.onrender.com'}/sse"
    }
  }
}</div>

      <h2>🛠️ Desteklenen MCP Araçları (Tools)</h2>
      
      <h3>🌐 Tarayıcı Araçları (Browser)</h3>
      <ul>
        <li><span class="badge">browser_navigate</span> - Web sitesine gider.</li>
        <li><span class="badge">browser_click</span> - Sayfadaki öğeye tıklar.</li>
        <li><span class="badge">browser_type</span> - Metin kutusuna yazı yazar.</li>
        <li><span class="badge">browser_scroll</span> - Sayfayı kaydırır.</li>
        <li><span class="badge">browser_get_html</span> - Sayfanın HTML/Markdown kodunu döker.</li>
        <li><span class="badge">browser_get_markdown</span> - Sayfanın temizlenmiş Markdown içeriğini döker.</li>
        <li><span class="badge">browser_screenshot</span> - Tarayıcının ekran görüntüsünü çeker.</li>
        <li><span class="badge">browser_execute_js</span> - Özel JavaScript kodu çalıştırır.</li>
        <li><span class="badge">browser_new_tab</span> - Yeni sekme açar.</li>
        <li><span class="badge">browser_switch_tab</span> - Sekmeler arası geçiş yapar.</li>
        <li><span class="badge">browser_close_tab</span> - Sekmeyi kapatır.</li>
        <li><span class="badge">browser_list_tabs</span> - Tüm açık sekmeleri listeler.</li>
      </ul>

      <h3 style="margin-top: 1.5rem; color: #15803d;">📱 Android Cihaz & Shizuku Araçları (Device)</h3>
      <ul>
        <li><span class="device-badge">get_device_ui</span> - Açık olan Android uygulamasının ekran UI buton ve metin ağacını koordinatlarıyla döker.</li>
        <li><span class="device-badge">device_action</span> - Android cihazda tıklama, metin yazma, kaydırma, sistem tuşuna basma veya uygulama açma eylemlerini yürütür.</li>
        <li><span class="device-badge">run_shizuku_cmd</span> - Shizuku / ADB yetkileriyle doğrudan Android Shell terminal komutu koşturur.</li>
      </ul>
    </body>
    </html>
  `);
});

httpServer.listen(PORT, () => {
  console.log(`[HTTP/WS] Server listening on port ${PORT}`);
  console.log(`[MCP] SSE endpoint available at /sse`);
});
