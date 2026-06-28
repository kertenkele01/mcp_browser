const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Aktif Android Tarayıcı bağlantıları ve bekleyen istekler
const activeBrowsers = new Map(); // deviceId -> websocket
const pendingRequests = new Map(); // messageId -> { resolve, reject, timeout }
const sseClients = new Map(); // sessionId -> sse_response_object

// HTTP Ana Sayfa - Bağlantı durumunu gösteren basit web paneli
app.get('/', (req, res) => {
    const devices = Array.from(activeBrowsers.keys());
    res.send(`
        <html>
            <head>
                <title>Android AI Browser MCP Bridge</title>
                <style>
                    body { font-family: -apple-system, sans-serif; padding: 40px; background: #f4f6f9; color: #333; }
                    .card { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width: 600px; margin: 0 auto; }
                    h1 { color: #6750A4; margin-top: 0; }
                    .status { display: inline-block; padding: 6px 12px; border-radius: 20px; font-weight: bold; font-size: 14px; }
                    .online { background: #E8F5E9; color: #2E7D32; }
                    .offline { background: #FFEBEE; color: #C62828; }
                    ul { padding-left: 20px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>MCP Köprü Durumu</h1>
                    <p>Sunucu Durumu: <span class="status online">AKTİF (SSE Destekleniyor)</span></p>
                    <h3>Bağlı Android Cihazlar (${devices.length}):</h3>
                    ${devices.length === 0 ? '<p style="color: #666;">Henüz hiçbir Android cihaz bağlanmadı.</p>' : `<ul>${devices.map(d => `<li><strong>${d}</strong></li>`).join('')}</ul>`}
                    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="font-size: 12px; color: #666;">Cursor MCP SSE Adresi: <br><code>${req.protocol}://${req.get('host')}/sse</code></p>
                </div>
            </body>
        </html>
    `);
});

// ==========================================
// 1. ANDROID TARAYICI (WEBSOCKET) YÖNETİMİ
// ==========================================
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', (ws) => {
    let registeredDeviceId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // Android Cihaz Kaydı
            if (data.type === 'register') {
                registeredDeviceId = data.deviceId || 'default_android';
                activeBrowsers.set(registeredDeviceId, ws);
                console.log(`[WebSocket] Android Cihaz Kaydedildi: ${registeredDeviceId}`);
                
                ws.send(JSON.stringify({ type: 'register_ack', status: 'success' }));
                return;
            }

            // Android'den Gelen Cevap (Response)
            if (data.type === 'response') {
                const pending = pendingRequests.get(data.messageId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    pendingRequests.delete(data.messageId);
                    pending.resolve(data);
                }
                return;
            }
        } catch (err) {
            console.error('[WebSocket] Mesaj işleme hatası:', err);
        }
    });

    ws.on('close', () => {
        if (registeredDeviceId) {
            activeBrowsers.delete(registeredDeviceId);
            console.log(`[WebSocket] Bağlantı Kesildi: ${registeredDeviceId}`);
        }
    });
});

// ==========================================
// 2. CURSOR/AI İSTEMCİ (SSE - MODEL CONTEXT PROTOCOL) YÖNETİMİ
// ==========================================

// SSE Bağlantısını Başlat
app.get('/sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sessionId = uuidv4();
    const targetDevice = req.query.deviceId || null; // Özel cihaz ID'si veya varsayılan ilk cihaz
    
    console.log(`[SSE] Cursor/AI bağlantısı kuruldu. Session: ${sessionId}`);
    sseClients.set(sessionId, { res, targetDevice });

    // Bağlantı açıldığında istemciye mesaj göndermek için gerekli endpoint'i söyle (MCP SSE Standardı)
    res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

    req.on('close', () => {
        sseClients.delete(sessionId);
        console.log(`[SSE] AI bağlantısı kapandı. Session: ${sessionId}`);
    });
});

// AI'dan Gelen Komutları İşleme (POST)
app.post('/message', async (req, res) => {
    const { sessionId } = req.query;
    const clientInfo = sseClients.get(sessionId);

    if (!sessionId || !clientInfo) {
        return res.status(400).json({ error: "Geçersiz veya süresi dolmuş oturum (Session)" });
    }

    const mcpRequest = req.body;
    const { method, params, id } = mcpRequest;

    console.log(`[MCP] İstek Alındı: ${method} (ID: ${id})`);

    // 1. MCP Başlatma/İletişim Kurulumu
    if (method === 'initialize') {
        return res.json({
            jsonrpc: "2.0",
            id: id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "android-browser-mcp-bridge", version: "1.0.0" }
            }
        });
    }

    // 2. AI'a Sunulan Araçların Listesi
    if (method === 'tools/list') {
        return res.json({
            jsonrpc: "2.0",
            id: id,
            result: {
                tools: [
                    {
                        name: "navigate",
                        description: "Android tarayıcısını belirtilen web sitesine yönlendirir.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                url: { type: "string", description: "Yönlendirilecek tam URL adresi (örn: https://google.com)" }
                            },
                            required: ["url"]
                        }
                    },
                    {
                        name: "get_html",
                        description: "Tarayıcıda o an açık olan sayfanın URL'sini ve tam HTML kaynak kodunu alır.",
                        inputSchema: { type: "object", properties: {} }
                    },
                    {
                        name: "scroll",
                        description: "Sayfayı aşağı veya yukarı kaydırır.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                direction: { type: "string", enum: ["up", "down"], description: "Kaydırma yönü ('up' veya 'down'). Varsayılan 'down'" }
                            }
                        }
                    },
                    {
                        name: "click",
                        description: "Sayfa üzerinde belirtilen CSS seçici (selector) ile eşleşen elemente tıklar.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                selector: { type: "string", description: "Tıklanacak elementin CSS seçicisi (örn: 'button.login', 'a#help')" }
                            },
                            required: ["selector"]
                        }
                    },
                    {
                        name: "execute_js",
                        description: "Sayfada özel JavaScript kodu çalıştırır ve sonucunu döndürür.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                script: { type: "string", description: "Çalıştırılacak JavaScript kod bloğu" }
                            },
                            required: ["script"]
                        }
                    }
                ]
            }
        });
    }

    // 3. Araçları Çağırma ve Android'e İletme
    if (method === 'tools/call') {
        const toolName = params.name;
        const toolArgs = params.arguments || {};

        // Doğru Android cihazını seç (Belirtilen veya ilk aktif olan)
        let targetDeviceId = clientInfo.targetDevice;
        if (!targetDeviceId && activeBrowsers.size > 0) {
            targetDeviceId = activeBrowsers.keys().next().value; // İlk bağlı cihazı al
        }

        const ws = activeBrowsers.get(targetDeviceId);
        if (!ws) {
            return res.json({
                jsonrpc: "2.0",
                id: id,
                result: {
                    content: [{ type: "text", text: "Hata: Bağlı aktif bir Android cihaz bulunamadı. Lütfen telefondan bağlantıyı kurun." }],
                    isError: true
                }
            });
        }

        // Android'e gönderilecek WebSocket paketini hazırla
        const messageId = uuidv4();
        const wsPayload = {
            type: toolName,
            messageId: messageId,
            ...toolArgs
        };

        // Android'den cevap bekleyen Promise oluştur
        const responsePromise = new Promise((resolve) => {
            const timeout = setTimeout(() => {
                pendingRequests.delete(messageId);
                resolve({ status: 'error', error: 'Android cihaz yanıt vermedi (Zaman aşımı).' });
            }, 15000); // 15 saniye zaman aşımı

            pendingRequests.set(messageId, { resolve, timeout });
        });

        // Paketi Android'e yolla
        ws.send(JSON.stringify(wsPayload));
        console.log(`[MCP] Komut Android'e iletildi (${toolName}): DeviceID: ${targetDeviceId}`);

        // Cevabı bekle ve AI'a dön
        const result = await responsePromise;

        if (result.status === 'success') {
            let replyText = `İşlem Başarılı!`;
            if (toolName === 'get_html') {
                replyText = `Aktif Adres: ${result.data.url}\n\nSayfa Kaynağı:\n${result.data.html}`;
            } else if (toolName === 'navigate') {
                replyText = `Tarayıcı başarıyla yönlendirildi: ${result.data.url}`;
            } else if (toolName === 'execute_js') {
                replyText = `JS Çalıştırıldı. Sonuç: ${result.data.result}`;
            } else if (toolName === 'click') {
                replyText = `Element tıklandı.`;
            } else if (toolName === 'scroll') {
                replyText = `Sayfa ${result.data.direction} yönüne kaydırıldı.`;
            }

            return res.json({
                jsonrpc: "2.0",
                id: id,
                result: {
                    content: [{ type: "text", text: replyText }]
                }
            });
        } else {
            return res.json({
                jsonrpc: "2.0",
                id: id,
                result: {
                    content: [{ type: "text", text: `Başarısız: ${result.error || 'Bilinmeyen bir hata oluştu.'}` }],
                    isError: true
                }
            });
        }
    }

    // Desteklenmeyen diğer metodlar için boş cevap dön
    return res.json({ jsonrpc: "2.0", id: id, result: {} });
});

// Port Dinleme
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[McpBridge] Sunucu ${PORT} portunda çalışıyor.`);
});
