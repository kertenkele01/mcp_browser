const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "secure_mcp_token";

// Cihaz ve bekleyen isteklerin state takibi
const connectedBrowsers = new Map(); // deviceId -> ws connection
const pendingRequests = new Map();   // messageId -> { resolve, reject, timeout }

// HTTP Sunucusu oluşturma
const server = http.createServer(app);

// 1. Android WebSocket Sunucusu kurulumu
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  let registeredDeviceId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      // Android cihaz kaydı
      if (data.type === 'register' && data.role === 'browser') {
        if (data.token !== ACCESS_TOKEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Yetkisiz erişim anahtarı!' }));
          ws.close();
          return;
        }
        registeredDeviceId = data.deviceId;
        connectedBrowsers.set(registeredDeviceId, ws);
        console.log(`📱 Android tarayıcı bağlandı: ${registeredDeviceId}`);
        ws.send(JSON.stringify({ type: 'register_ack', status: 'connected' }));
      }

      // Android cihazdan dönen yanıtları yakala ve bekleyen MCP isteğine ilet
      if (data.type === 'response') {
        const messageId = data.messageId;
        if (pendingRequests.has(messageId)) {
          const { resolve, timeout } = pendingRequests.get(messageId);
          clearTimeout(timeout);
          pendingRequests.delete(messageId);
          resolve(data);
        }
      }
    } catch (e) {
      console.error('WebSocket veri işleme hatası:', e);
    }
  });

  ws.on('close', () => {
    if (registeredDeviceId) {
      connectedBrowsers.delete(registeredDeviceId);
      console.log(`❌ Android cihaz bağlantısı koptu: ${registeredDeviceId}`);
    }
  });
});

// Render'ın uykuya dalmasını önlemek ve durum kontrolü için Ana Sayfa
app.get('/', (req, res) => {
  res.json({
    status: "online",
    message: "Android AI Browser MCP Bridge is running!",
    connected_devices: Array.from(connectedBrowsers.keys())
  });
});

// ==========================================
// 2. MCP SERVER-SENT EVENTS (SSE) ENTEGRASYONU
// ==========================================

const activeSseConnections = new Map(); // sessionId -> res

// MCP SSE Bağlantı Noktası (Yapay zekanın bağlandığı yer)
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sessionId = uuidv4();
  activeSseConnections.set(sessionId, res);

  console.log(`🔌 AI Client (MCP SSE) bağlandı. Session ID: ${sessionId}`);

  // MCP Standardına göre istemciye mesaj gönderebileceği HTTP endpoint'ini bildirin
  const endpointUrl = `/message?sessionId=${sessionId}`;
  res.write(`event: endpoint\ndata: ${encodeURIComponent(endpointUrl)}\n\n`);

  req.on('close', () => {
    activeSseConnections.delete(sessionId);
    console.log(`❌ AI Client (MCP SSE) bağlantısı kesildi. Session ID: ${sessionId}`);
  });
});

// AI İstemcisinden gelen JSON-RPC komutlarını alan HTTP POST endpoint'i
app.post('/message', async (req, res) => {
  const { sessionId } = req.query;
  const rpcRequest = req.body;

  if (!sessionId || !activeSseConnections.has(sessionId)) {
    return res.status(400).json({ error: "Geçersiz veya süresi dolmuş oturum." });
  }

  console.log(`📥 AI komutu alındı:`, JSON.stringify(rpcRequest));

  // 1. JSON-RPC Başlatma Talebi (initialize)
  if (rpcRequest.method === 'initialize') {
    const initResponse = {
      jsonrpc: "2.0",
      id: rpcRequest.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "android-browser-bridge",
          version: "1.0.0"
        }
      }
    };
    sendSseMessage(sessionId, initResponse);
    return res.status(200).send('OK');
  }

  // 2. Araç Listesi Sunma (tools/list)
  if (rpcRequest.method === 'tools/list') {
    const listResponse = {
      jsonrpc: "2.0",
      id: rpcRequest.id,
      result: {
        tools: [
          {
            name: "android_navigate",
            description: "Android telefondaki tarayıcıda belirtilen web sitesine gider.",
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string", description: "Gidilecek web adresi (örn: https://google.com)" }
              },
              required: ["url"]
            }
          },
          {
            name: "android_get_html",
            description: "Şu an açık olan sayfanın tam HTML kaynak kodunu ve URL'sini okur.",
            inputSchema: { type: "object", properties: {} }
          },
          {
            name: "android_scroll",
            description: "Açık olan web sayfasını yukarı veya aşağı kaydırır.",
            inputSchema: {
              type: "object",
              properties: {
                direction: { type: "string", enum: ["up", "down"], description: "Kaydırma yönü" }
              },
              required: ["direction"]
            }
          },
          {
            name: "android_click",
            description: "Sayfa içindeki bir butona veya elemente CSS selector kullanarak tıklar.",
            inputSchema: {
              type: "object",
              properties: {
                selector: { type: "string", description: "Tıklanacak elementin CSS selector'ü (örn: '#submit-btn' veya '.login-link')" }
              },
              required: ["selector"]
            }
          },
          {
            name: "android_execute_js",
            description: "Sayfada özel bir JavaScript kodu çalıştırır ve sonucunu döner.",
            inputSchema: {
              type: "object",
              properties: {
                script: { type: "string", description: "Çalıştırılacak JS kod satırı" }
              },
              required: ["script"]
            }
          }
        ]
      }
    };
    sendSseMessage(sessionId, listResponse);
    return res.status(200).send('OK');
  }

  // 3. Araç Çalıştırma Talebi (tools/call)
  if (rpcRequest.method === 'tools/call') {
    const { name, arguments: args } = rpcRequest.params;
    
    // Aktif bir Android cihaz var mı kontrol et
    const activeDevices = Array.from(connectedBrowsers.keys());
    if (activeDevices.length === 0) {
      sendSseError(sessionId, rpcRequest.id, "Bağlı aktif bir Android cihaz bulunamadı! Lütfen telefondan uygulamayı açıp bağlanın.");
      return res.status(200).send('OK');
    }
    
    // İlk aktif cihaza yönlendir (İsteğe bağlı olarak parametreyle seçilebilir)
    const targetDeviceId = activeDevices[0];
    const ws = connectedBrowsers.get(targetDeviceId);

    const messageId = uuidv4();
    let commandType = "";

    switch (name) {
      case "android_navigate":
        commandType = "navigate";
        break;
      case "android_get_html":
        commandType = "get_html";
        break;
      case "android_scroll":
        commandType = "scroll";
        break;
      case "android_click":
        commandType = "click";
        break;
      case "android_execute_js":
        commandType = "execute_js";
        break;
      default:
        sendSseError(sessionId, rpcRequest.id, `Bilinmeyen araç: ${name}`);
        return res.status(200).send('OK');
    }

    // Telefona gönderilecek paket
    const androidPayload = {
      type: commandType,
      messageId: messageId,
      ...args
    };

    // Android cihazdan yanıt gelene kadar bekleyeceğimiz Promise'i kuruyoruz (10 Saniye Zaman Aşımı)
    const pendingPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(messageId);
        reject(new Error("Android cihazdan zaman aşımı nedeniyle yanıt alınamadı (10sn)"));
      }, 10000);

      pendingRequests.set(messageId, { resolve, reject, timeout });
    });

    try {
      // WebSocket üzerinden telefona komutu gönder
      ws.send(JSON.stringify(androidPayload));
      console.log(`📤 Komut telefona gönderildi (${targetDeviceId}):`, androidPayload);

      // Telefonun yanıt vermesini bekle
      const androidResponse = await pendingPromise;

      // MCP formatında AI istemcisine yanıt dön
      const mcpResponse = {
        jsonrpc: "2.0",
        id: rpcRequest.id,
        result: {
          content: [
            {
              type: "text",
              text: androidResponse.status === "success" 
                ? JSON.stringify(androidResponse.data, null, 2)
                : `Hata: ${androidResponse.error}`
            }
          ]
        }
      };

      sendSseMessage(sessionId, mcpResponse);
    } catch (err) {
      sendSseError(sessionId, rpcRequest.id, err.message);
    }

    return res.status(200).send('OK');
  }

  // Diğer standart MCP metodları için boş onay dön
  res.status(200).send('OK');
});

function sendSseMessage(sessionId, payload) {
  const res = activeSseConnections.get(sessionId);
  if (res) {
    res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}

function sendSseError(sessionId, rpcId, message) {
  const errorResponse = {
    jsonrpc: "2.0",
    id: rpcId,
    error: {
      code: -32603,
      message: message
    }
  };
  sendSseMessage(sessionId, errorResponse);
}

server.listen(PORT, () => {
  console.log(`🚀 MCP & WebSocket Bridge sunucu ${PORT} portunda çalışıyor.`);
});
