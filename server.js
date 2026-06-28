const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Port Tanımlaması
const PORT = process.env.PORT || 3000;

// Bağlantı ve İstek Yönetimi
let deviceWs = null; // Aktif Android Cihazı
const mcpSessions = new Map(); // sessionId -> { res, pendingRequests }
const pendingDeviceRequests = new Map(); // messageId -> { resolve, reject, timeout }

// HTTP Sunucusu Oluşturma
const server = http.createServer(app);

// Android Uygulaması için WebSocket Sunucusu
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  console.log('📱 Android cihazı WebSocket üzerinden bağlandı.');
  
  ws.on('message', (message) => {
    try {
      const payload = JSON.parse(message.toString());
      console.log('📥 Cihazdan gelen veri:', payload);
      
      if (payload.type === 'register') {
        deviceWs = ws;
        console.log(`✅ Cihaz başarıyla kaydedildi. Cihaz ID: ${payload.deviceId}`);
        ws.send(JSON.stringify({ type: 'registered', status: 'success' }));
      } else if (payload.type === 'response') {
        const pending = pendingDeviceRequests.get(payload.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingDeviceRequests.delete(payload.id);
          if (payload.status === 'success') {
            pending.resolve(payload.data || {});
          } else {
            pending.reject(new Error(payload.error || 'Cihaz işlem hatası'));
          }
        }
      }
    } catch (e) {
      console.error('❌ Cihaz mesajı ayrıştırılamadı:', e);
    }
  });

  ws.on('close', () => {
    console.log('❌ Cihaz bağlantısı kesildi.');
    if (deviceWs === ws) {
      deviceWs = null;
    }
  });
});

// Android Cihaza Komut Gönderip Yanıt Bekleyen Fonksiyon
function sendCommandToDevice(type, args) {
  return new Promise((resolve, reject) => {
    if (!deviceWs) {
      return reject(new Error('Android cihazı şu anda köprüye bağlı değil!'));
    }
    
    const messageId = uuidv4();
    const payload = {
      id: messageId,
      type: type,
      ...args
    };
    
    // 15 Saniyelik Zaman Aşımı (Timeout)
    const timeout = setTimeout(() => {
      pendingDeviceRequests.delete(messageId);
      reject(new Error('Android cihazından zamanında yanıt alınamadı (Zaman Aşımı)'));
    }, 15000);
    
    pendingDeviceRequests.set(messageId, { resolve, reject, timeout });
    deviceWs.send(JSON.stringify(payload));
    console.log(`🚀 Cihaza komut gönderildi: ${type} (ID: ${messageId})`);
  });
}

// =================================================================
// 🌐 MCP STANDART SSE PROTOKOLÜ ENDPOINTLERİ
// =================================================================

// 1. SSE Bağlantısını Başlatma
app.get('/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const sessionId = uuidv4();
  mcpSessions.set(sessionId, { res, pendingRequests: new Map() });
  
  console.log(`🔌 Yeni MCP SSE Oturumu Açıldı: ${sessionId}`);

  // Standart MCP gereği: İstemciye sonraki istekleri hangi URL'ye POST edeceğini bildiriyoruz
  res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

  req.on('close', () => {
    console.log(`❌ MCP SSE Oturumu Kapatıldı: ${sessionId}`);
    mcpSessions.delete(sessionId);
  });
});

// 2. JSON-RPC Mesajlarını Karşılama (Cursor/Claude buradan konuşur)
app.post('/message', async (req, res) => {
  const { sessionId } = req.query;
  const jsonRpcRequest = req.body;

  console.log(`📩 Gelen JSON-RPC İsteği (Oturum: ${sessionId}):`, JSON.stringify(jsonRpcRequest));

  if (!jsonRpcRequest || jsonRpcRequest.jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
  }

  const { method, params, id } = jsonRpcRequest;

  // Standart MCP Başlatma (Handshake)
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'android-browser-mcp-bridge', version: '1.0.0' }
      }
    });
  }

  // Kullanılabilir Tool'ları AI'a Listeleme
  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'browser_navigate',
            description: 'Android tarayıcısını belirtilen URL adresine yönlendirir.',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'Yönlendirilecek tam URL (örn: https://google.com)' }
              },
              required: ['url']
            }
          },
          {
            name: 'browser_get_html',
            description: 'Android tarayıcısının o anki web sayfasının HTML kaynak kodunu alır.',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'browser_scroll',
            description: 'Web sayfasını dikey veya yatay olarak kaydırır.',
            inputSchema: {
              type: 'object',
              properties: {
                x: { type: 'integer', description: 'Yatay kaydırma pikseli' },
                y: { type: 'integer', description: 'Dikey kaydırma pikseli' }
              },
              required: ['x', 'y']
            }
          },
          {
            name: 'browser_click',
            description: 'CSS seçici (selector) veya koordinatlar yardımıyla sayfada bir yere tıklar.',
            inputSchema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'Tıklanacak elementin CSS seçicisi' },
                x: { type: 'integer', description: 'Alternatif X koordinatı' },
                y: { type: 'integer', description: 'Alternatif Y koordinatı' }
              }
            }
          },
          {
            name: 'browser_input_text',
            description: 'Belirtilen CSS seçici alanına metin yazar.',
            inputSchema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'Metin girilecek alanın CSS seçicisi' },
                text: { type: 'string', description: 'Yazılacak metin' }
              },
              required: ['selector', 'text']
            }
          },
          {
            name: 'browser_execute_js',
            description: 'Tarayıcı içinde özel JavaScript kodu çalıştırır.',
            inputSchema: {
              type: 'object',
              properties: {
                code: { type: 'string', description: 'Çalıştırılacak JS kodu' }
              },
              required: ['code']
            }
          }
        ]
      }
    });
  }

  // Tool Çağrısı (AI bir aracı tetiklediğinde)
  if (method === 'tools/call') {
    const toolName = params.name;
    const toolArgs = params.arguments || {};

    let deviceType = null;
    let deviceArgs = {};

    // MCP Tool Adını Android'in WebSocket yapısıyla eşleme
    if (toolName === 'browser_navigate') {
      deviceType = 'navigate';
      deviceArgs = { url: toolArgs.url };
    } else if (toolName === 'browser_get_html') {
      deviceType = 'get_html';
    } else if (toolName === 'browser_scroll') {
      deviceType = 'scroll';
      deviceArgs = { x: parseInt(toolArgs.x), y: parseInt(toolArgs.y) };
    } else if (toolName === 'browser_click') {
      deviceType = 'click';
      deviceArgs = { selector: toolArgs.selector, x: toolArgs.x, y: toolArgs.y };
    } else if (toolName === 'browser_input_text') {
      deviceType = 'input_text';
      deviceArgs = { selector: toolArgs.selector, text: toolArgs.text };
    } else if (toolName === 'browser_execute_js') {
      deviceType = 'execute_js';
      deviceArgs = { code: toolArgs.code };
    }

    if (!deviceType) {
      return res.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Araç (${toolName}) bulunamadı.` }
      });
    }

    try {
      // Android Cihaza komutu ilet ve yanıtı bekle
      const deviceResult = await sendCommandToDevice(deviceType, deviceArgs);
      
      // Standart MCP JSON-RPC formatında yanıt dön
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: typeof deviceResult === 'string' ? deviceResult : JSON.stringify(deviceResult, null, 2)
            }
          ]
        }
      });
    } catch (error) {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Hata Oluştu: ${error.message}`
            }
          ]
        }
      });
    }
  }

  return res.json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method bulunamadı.' }
  });
});

// Durum Ekranı
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    deviceConnected: !!deviceWs,
    activeMcpSessions: mcpSessions.size
  });
});

server.listen(PORT, () => {
  console.log(`🚀 MCP Köprü Sunucusu ${PORT} portunda çalışıyor.`);
});
