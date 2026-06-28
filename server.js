const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json());

// CORS Desteği
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-mcp-token');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Aktif bağlantılar
const browsers = new Map(); // deviceId -> WebSocket bağlantısı
const pendingRequests = new Map(); // messageId -> { resolve, reject, timeout }

// Standart MCP Araç Şemaları
const TOOLS = [
    {
        name: "browser_navigate",
        description: "Android tarayıcısında belirtilen web adresine (URL) gider.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "Gidilecek URL (örn. https://www.google.com)" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["url"]
        }
    },
    {
        name: "browser_get_html",
        description: "Şu an açık olan sayfanın HTML içeriğini (kaynağını) alır.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_scroll",
        description: "Sayfayı yukarı veya aşağı kaydırır.",
        inputSchema: {
            type: "object",
            properties: {
                direction: { type: "string", enum: ["up", "down"], description: "Kaydırma yönü ('up' veya 'down', varsayılan 'down')" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_click",
        description: "Belirtilen CSS seçici (selector) ile eşleşen elemente tıklar.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "Tıklanacak elementin CSS seçicisi (örn. '#submit', '.btn-login')" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["selector"]
        }
    },
    {
        name: "browser_execute_js",
        description: "Sayfada özel bir JavaScript kodu çalıştırır ve sonucunu döner.",
        inputSchema: {
            type: "object",
            properties: {
                script: { type: "string", description: "Çalıştırılacak JS kod satırı" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["script"]
        }
    }
];

// Bağlı tarayıcıyı bulma fonksiyonu
function getBrowserWs(deviceId) {
    if (deviceId && browsers.has(deviceId)) {
        return browsers.get(deviceId);
    }
    if (browsers.size > 0) {
        // Cihaz ID belirtilmediyse ilk bağlı tarayıcıyı otomatik seç
        return Array.from(browsers.values())[0];
    }
    return null;
}

// Komutları Android tarayıcıya ileten fonksiyon
function routeCommandToBrowser(type, args, deviceId) {
    return new Promise((resolve, reject) => {
        const ws = getBrowserWs(deviceId);
        if (!ws) {
            return reject(new Error("Bağlı aktif bir Android tarayıcı bulunamadı. Lütfen uygulamanın açık ve köprüye bağlı olduğundan emin olun."));
        }

        const messageId = randomUUID();
        const payload = JSON.stringify({
            type,
            messageId,
            ...args
        });

        const timeout = setTimeout(() => {
            pendingRequests.delete(messageId);
            reject(new Error("Android cihazından yanıt alınamadı, zaman aşımı (15s)."));
        }, 15000);

        pendingRequests.set(messageId, { resolve, reject, timeout });
        ws.send(payload);
        console.log(`[Bridge] Komut gönderildi: '${type}' | ID: ${messageId}`);
    });
}

// Android WebSocket bağlantısını yükselt
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// WebSocket Bağlantı Dinleyicisi (Android için)
wss.on('connection', (ws) => {
    let clientDeviceId = null;
    console.log("[WS] Yeni bir cihaz bağlanmak istiyor...");

    ws.on('message', (message) => {
        try {
            const payload = JSON.parse(message.toString());
            console.log(`[WS] Gelen veri:`, payload);

            if (payload.type === 'register') {
                clientDeviceId = payload.deviceId || `device_${Math.floor(Math.random() * 10000)}`;
                browsers.set(clientDeviceId, ws);
                console.log(`[WS] Android cihazı başarıyla kaydedildi: ${clientDeviceId}`);
                
                ws.send(JSON.stringify({
                    type: "register_ack",
                    messageId: payload.messageId || "0",
                    status: "success"
                }));
            } else if (payload.type === 'response') {
                const { messageId, status, data, error } = payload;
                const pending = pendingRequests.get(messageId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    pendingRequests.delete(messageId);
                    if (status === 'success') {
                        pending.resolve(data || {});
                    } else {
                        pending.reject(new Error(error || "Bilinmeyen cihaz hatası"));
                    }
                }
            }
        } catch (err) {
            console.error("[WS] Mesaj işleme hatası:", err);
        }
    });

    ws.on('close', () => {
        if (clientDeviceId) {
            browsers.delete(clientDeviceId);
            console.log(`[WS] Android cihazının bağlantısı koptu: ${clientDeviceId}`);
        }
    });
});

// ----------------------------------------------------
// 1. STANDART MCP SSE APİ KANALLARI (Cursor ve Claude Desktop için)
// ----------------------------------------------------
const sseSessions = new Map();

app.get('/sse', (req, res) => {
    const sessionId = randomUUID();
    
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    const heartbeatInterval = setInterval(() => {
        res.write(':\n\n');
    }, 15000);

    sseSessions.set(sessionId, res);
    console.log(`[MCP] SSE oturumu oluşturuldu: ${sessionId}`);

    // AI istemcisine mesajları POST edeceği URL adresini bildiriyoruz
    res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

    req.on('close', () => {
        clearInterval(heartbeatInterval);
        sseSessions.delete(sessionId);
        console.log(`[MCP] SSE oturumu kapatıldı: ${sessionId}`);
    });
});

app.post('/message', async (req, res) => {
    const { sessionId } = req.query;
    const rpcRequest = req.body;

    console.log(`[MCP] Gelen JSON-RPC İsteği:`, JSON.stringify(rpcRequest));

    if (!rpcRequest || typeof rpcRequest !== 'object') {
        return res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }

    const { method, params, id } = rpcRequest;

    if (method === 'tools/list') {
        return res.json({
            jsonrpc: "2.0",
            result: { tools: TOOLS },
            id
        });
    }

    if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};
        const deviceId = args.deviceId;

        const cleanArgs = { ...args };
        delete cleanArgs.deviceId;

        let actionType = "";
        switch (toolName) {
            case "browser_navigate": actionType = "navigate"; break;
            case "browser_get_html": actionType = "get_html"; break;
            case "browser_scroll": actionType = "scroll"; break;
            case "browser_click": actionType = "click"; break;
            case "browser_execute_js": actionType = "execute_js"; break;
            default:
                return res.json({
                    jsonrpc: "2.0",
                    error: { code: -32601, message: `Araç bulunamadı: ${toolName}` },
                    id
                });
        }

        try {
            const responseData = await routeCommandToBrowser(actionType, cleanArgs, deviceId);
            return res.json({
                jsonrpc: "2.0",
                result: {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(responseData, null, 2)
                        }
                    ]
                },
                id
            });
        } catch (error) {
            return res.json({
                jsonrpc: "2.0",
                result: {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Hata: ${error.message}`
                        }
                    ]
                },
                id
            });
        }
    }

    return res.json({ jsonrpc: "2.0", result: {}, id });
});

// ----------------------------------------------------
// 2. DOĞRUDAN REST API BAĞLANTI NOKTALARI (404 Hatalarını Engelleme)
// ----------------------------------------------------
const directToolHandler = async (type, req, res) => {
    const args = req.method === 'POST' ? req.body : req.query;
    const deviceId = args.deviceId;
    
    const cleanArgs = { ...args };
    delete cleanArgs.deviceId;

    console.log(`[REST API] Doğrudan istek alındı '${type}':`, cleanArgs);

    try {
        const responseData = await routeCommandToBrowser(type, cleanArgs, deviceId);
        return res.json({ status: "success", data: responseData });
    } catch (error) {
        return res.status(500).json({ status: "error", error: error.message });
    }
};

const fallbackRoutes = [
    { path: '/mcp/tools/browser_navigate', type: 'navigate' },
    { path: '/tools/browser_navigate', type: 'navigate' },
    { path: '/mcp/tools/browser_get_html', type: 'get_html' },
    { path: '/tools/browser_get_html', type: 'get_html' },
    { path: '/mcp/tools/browser_scroll', type: 'scroll' },
    { path: '/tools/browser_scroll', type: 'scroll' },
    { path: '/mcp/tools/browser_click', type: 'click' },
    { path: '/tools/browser_click', type: 'click' },
    { path: '/mcp/tools/browser_execute_js', type: 'execute_js' },
    { path: '/tools/browser_execute_js', type: 'execute_js' }
];

fallbackRoutes.forEach(route => {
    app.all(route.path, (req, res) => {
        directToolHandler(route.type, req, res);
    });
});

app.get('/', (req, res) => {
    res.json({
        name: "MCP Android Browser Bridge Server",
        status: "running",
        connected_browsers: Array.from(browsers.keys()),
        mcp_sse_endpoint: "/sse",
        supported_tools: TOOLS.map(t => t.name)
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(` MCP Bridge Server port ${PORT} üzerinde çalışıyor.`);
    console.log(` SSE Bağlantısı: http://localhost:${PORT}/sse`);
    console.log(`=================================================`);
});
