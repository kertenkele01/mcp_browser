const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json());

// CORS Support
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

// Active connections
const browsers = new Map(); // deviceId -> WebSocket connection
const pendingRequests = new Map(); // messageId -> { resolve, reject, timeout }

// Logging system
const logs = [];
function addLog(sessionId, clientName, deviceId, action, status, details) {
    const logEntry = {
        id: randomUUID().substring(0, 8),
        timestamp: new Date().toLocaleTimeString('tr-TR'),
        sessionId: sessionId ? sessionId.substring(0, 8) : 'N/A',
        clientName: clientName || 'N/A',
        deviceId: deviceId || 'Varsayılan',
        action,
        status, // 'success', 'error', 'pending', 'info'
        details: details || ''
    };
    logs.unshift(logEntry);
    if (logs.length > 100) {
        logs.pop();
    }
}

// Standard MCP Tools schema
const TOOLS = [
    {
        name: "browser_navigate",
        description: "Android tarayıcısında belirtilen web adresine (URL) gider.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "Gidilecek URL (örn. https://www.google.com)" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel, tek cihaz varsa otomatik seçilir)" }
            },
            required: ["url"]
        }
    },
    {
        name: "browser_search",
        description: "Google'da belirtilen anahtar kelimelerle arama yapar ve arama sonuçları sayfasını yükler.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Google'da aranacak kelime veya cümle (örn. 'en ucuz uçak bileti')" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["query"]
        }
    },
    {
        name: "browser_get_html",
        description: "Şu an açık olan sayfanın saf (raw) HTML içeriğini (kaynağını) alır.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_get_markdown",
        description: "Şu an açık olan sayfanın temizlenmiş, sadeleştirilmiş ve hiyerarşik Markdown içeriğini alır. AI modelleri için en uygun formattır.",
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
                script: { type: "string", description: "Çaimsal JS kod satırı" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["script"]
        }
    },
    {
        name: "browser_type",
        description: "Belirtilen input/text alanına yazı girer. Selector olarak Vimium ID sayısı (örn. '12') veya CSS seçici kullanılabilir.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "Yazı girilecek elementin CSS seçicisi veya Vimium ID sayısı (örn. '15')" },
                text: { type: "string", description: "Girilecek metin" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["selector", "text"]
        }
    },
    {
        name: "browser_toggle_overlay",
        description: "Ekrandaki interaktif elementlerin üzerine Vimium-style görsel numaralandırma etiketleri (overlay) ekler veya kaldırır.",
        inputSchema: {
            type: "object",
            properties: {
                enabled: { type: "boolean", description: "Overlay açık (true) veya kapalı (false) olsun" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["enabled"]
        }
    },
    {
        name: "browser_screenshot",
        description: "Şu an açık olan tarayıcı ekranının görüntüsünü (screenshot) alır. AI vision modelleri için son derece kullanışlıdır.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    }
];

// Helper to find connected browser
function getBrowserWs(deviceId) {
    if (deviceId && browsers.has(deviceId)) {
        return browsers.get(deviceId);
    }
    if (browsers.size > 0) {
        // Return first connected browser as default
        return Array.from(browsers.values())[0];
    }
    return null;
}

// Helper to route command to Android browser and await result
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
        console.log(`[Bridge] Sent command '${type}' to Android with ID: ${messageId}`);
    });
}

// Upgrade HTTP to WebSocket for Android app connection
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// WebSocket Server Handler (for Android App)
wss.on('connection', (ws) => {
    let clientDeviceId = null;
    console.log("[WS] New connection attempt...");

    ws.on('message', (message) => {
        try {
            const payload = JSON.parse(message.toString());
            console.log(`[WS] Received:`, payload);

            if (payload.type === 'register') {
                clientDeviceId = payload.deviceId || `device_${Math.floor(Math.random() * 10000)}`;
                browsers.set(clientDeviceId, ws);
                console.log(`[WS] Android device successfully registered: ${clientDeviceId}`);
                addLog(null, 'Android Uygulaması', clientDeviceId, 'Cihaz Bağlantısı', 'success', 'Cihaz köprüye başarıyla bağlandı ve kullanıma hazır.');
                
                // Send confirmation
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
                        pending.reject(new Error(error || "Unknown device error"));
                    }
                }
            }
        } catch (err) {
            console.error("[WS] Error parsing message:", err);
        }
    });

    ws.on('close', () => {
        if (clientDeviceId) {
            browsers.delete(clientDeviceId);
            console.log(`[WS] Android device disconnected: ${clientDeviceId}`);
            addLog(null, 'Android Uygulaması', clientDeviceId, 'Cihaz Ayrıldı', 'info', 'Cihaz bağlantıyı kapattı.');
        }
    });

    ws.on('error', (err) => {
        console.error(`[WS] Connection error:`, err);
    });
});

// ----------------------------------------------------
// 1. STANDARD MCP SSE TRANSPORT ENDPOINTS
// ----------------------------------------------------
const sseSessions = new Map(); // sessionId -> { res, clientInfo }

// Helper to send JSON-RPC response or notification to the MCP client over the active SSE stream
function sendSseJsonRpc(sessionId, jsonRpcMessage) {
    const session = sseSessions.get(sessionId);
    const res = session ? session.res : null;
    if (res) {
        console.log(`[SSE] Sending JSON-RPC response to session ${sessionId}:`, JSON.stringify(jsonRpcMessage));
        res.write(`event: message\ndata: ${JSON.stringify(jsonRpcMessage)}\n\n`);
        return true;
    } else {
        console.error(`[SSE] Error: Active session not found for ${sessionId}`);
        return false;
    }
}

app.get('/sse', (req, res) => {
    const sessionId = randomUUID();
    
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    // Send initial comment/heartbeat to establish connection immediately and bypass buffers
    res.write(':\n\n');

    // Keep SSE alive with heartbeats
    const heartbeatInterval = setInterval(() => {
        res.write(':\n\n');
    }, 15000);

    sseSessions.set(sessionId, { res, clientInfo: { name: 'İstemci Doğrulanıyor' } });
    console.log(`[MCP] SSE Session created: ${sessionId}`);
    addLog(sessionId, 'Bağlanıyor', null, 'SSE Bağlantısı', 'info', 'İstemci SSE kanalı üzerinden bağlantı başlattı.');

    // Construct ABSOLUTE POST URL for MCP client to avoid relative path resolution bugs in clients like Cursor/Claude Desktop
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['host'] || 'localhost:10000';
    const postUrl = `${protocol}://${host}/message?sessionId=${sessionId}`;

    console.log(`[MCP] Sending SSE endpoint redirect URL: ${postUrl}`);
    res.write(`event: endpoint\ndata: ${postUrl}\n\n`);

    req.on('close', () => {
        clearInterval(heartbeatInterval);
        const session = sseSessions.get(sessionId);
        const clientName = session ? (session.clientInfo ? session.clientInfo.name : 'N/A') : 'N/A';
        sseSessions.delete(sessionId);
        console.log(`[MCP] SSE Session closed: ${sessionId}`);
        addLog(sessionId, clientName, null, 'Bağlantı Kesildi', 'info', 'SSE kanalı kapatıldı.');
    });
});

// Post endpoint for standard MCP client
app.post('/message', async (req, res) => {
    const { sessionId } = req.query;
    const rpcRequest = req.body;

    console.log(`[MCP] Incoming JSON-RPC Request (Session: ${sessionId}):`, JSON.stringify(rpcRequest));

    if (!sessionId) {
        return res.status(400).json({ error: "Missing sessionId query parameter" });
    }

    if (!rpcRequest || typeof rpcRequest !== 'object') {
        const errorResponse = { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null };
        sendSseJsonRpc(sessionId, errorResponse);
        return res.status(200).send("accepted");
    }

    const { method, params, id } = rpcRequest;

    // Handle notifications (no response required in JSON-RPC, return 202 immediately)
    if (id === undefined || id === null) {
        console.log(`[MCP] Received Notification: ${method}`);
        if (method === 'notifications/initialized') {
            console.log(`[MCP] Handshake completed successfully! Session: ${sessionId}`);
            const session = sseSessions.get(sessionId);
            if (session && session.clientInfo) {
                addLog(sessionId, session.clientInfo.name, null, 'Sistem Hazır', 'success', 'MCP Handshake başarıyla tamamlandı. İstemci hazır.');
            }
        }
        return res.status(202).send("accepted");
    }

    // Helper to send JSON-RPC formatted responses
    const reply = (result, error = null) => {
        const payload = { jsonrpc: "2.0", id };
        if (error) {
            payload.error = error;
        } else {
            payload.result = result;
        }
        sendSseJsonRpc(sessionId, payload);
    };

    // 1. Handle initialize handshake (CRITICAL for clients like Cursor / Claude Desktop)
    if (method === 'initialize') {
        const clientInfo = params?.clientInfo || { name: 'Belirtilmeyen Yapay Zeka' };
        const session = sseSessions.get(sessionId);
        if (session) {
            session.clientInfo = clientInfo;
        }
        addLog(sessionId, clientInfo.name, null, 'Başlatma Handshake', 'success', `Yapay zeka asistanı bağlandı: ${clientInfo.name} (v${clientInfo.version || 'unknown'}).`);

        reply({
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: {
                tools: {} // We support tools
            },
            serverInfo: {
                name: "mcp-android-bridge",
                version: "1.0.0"
            }
        });
        return res.status(200).send("accepted");
    }

    // 2. Handle ping
    if (method === 'ping') {
        reply({});
        return res.status(200).send("accepted");
    }

    // 3. Handle tools list
    if (method === 'tools/list') {
        reply({ tools: TOOLS });
        return res.status(200).send("accepted");
    }

    // 4. Handle tools execution
    if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};
        const deviceId = args.deviceId;

        // Strip deviceId from args to avoid passing it to WebView
        const cleanArgs = { ...args };
        delete cleanArgs.deviceId;

        let actionType = "";
        switch (toolName) {
            case "browser_navigate": actionType = "navigate"; break;
            case "browser_search": actionType = "search"; break;
            case "browser_get_html": actionType = "get_html"; break;
            case "browser_get_markdown": actionType = "get_markdown"; break;
            case "browser_scroll": actionType = "scroll"; break;
            case "browser_click": actionType = "click"; break;
            case "browser_type": actionType = "type"; break;
            case "browser_toggle_overlay": actionType = "toggle_overlay"; break;
            case "browser_screenshot": actionType = "screenshot"; break;
            case "browser_execute_js": actionType = "execute_js"; break;
            default:
                reply(null, { code: -32601, message: `Tool not found: ${toolName}` });
                return res.status(200).send("accepted");
        }

        const session = sseSessions.get(sessionId);
        const clientName = session ? (session.clientInfo ? session.clientInfo.name : 'MCP İstemcisi') : 'MCP İstemcisi';

        try {
            addLog(sessionId, clientName, deviceId || 'Varsayılan Cihaz', `Araç Çağrısı: ${toolName}`, 'pending', `Komut gönderiliyor. Parametreler: ${JSON.stringify(cleanArgs)}`);
            const responseData = await routeCommandToBrowser(actionType, cleanArgs, deviceId);
            
            let details = "Komut başarıyla yürütüldü.";
            if (toolName === "browser_get_markdown" && responseData.markdown) {
                details = `Markdown verisi başarıyla alındı. (${responseData.markdown.length} karakter)`;
            } else if (toolName === "browser_get_html" && responseData.html) {
                details = `Saf HTML kaynağı başarıyla alındı. (${responseData.html.length} karakter)`;
            } else if (toolName === "browser_navigate" && responseData.url) {
                details = `Adrese yönlendirildi: ${responseData.url}`;
            } else if (toolName === "browser_search" && responseData.url) {
                details = `Google araması yapıldı, yönlendirilen URL: ${responseData.url}`;
            } else {
                details = `Yanıt: ${JSON.stringify(responseData)}`;
            }

            addLog(sessionId, clientName, deviceId || 'Varsayılan Cihaz', `Yürütme Başarılı: ${toolName}`, 'success', details);

            const content = [];
            
            if (responseData && responseData.screenshot) {
                const screenshotBase64 = responseData.screenshot;
                
                // Keep the JSON response clean by removing the massive base64 string from text output
                const cleanResponseData = { ...responseData };
                delete cleanResponseData.screenshot;
                
                content.push({
                    type: "text",
                    text: JSON.stringify(cleanResponseData, null, 2)
                });
                
                content.push({
                    type: "image",
                    data: screenshotBase64,
                    mimeType: "image/jpeg"
                });
            } else {
                content.push({
                    type: "text",
                    text: JSON.stringify(responseData, null, 2)
                });
            }

            reply({ content });
        } catch (error) {
            addLog(sessionId, clientName, deviceId || 'Varsayılan Cihaz', `Hata: ${toolName}`, 'error', error.message);
            reply({
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Hata: ${error.message}`
                    }
                ]
            });
        }
        return res.status(200).send("accepted");
    }

    // Default response for other unhandled methods
    reply({});
    return res.status(200).send("accepted");
});

// ----------------------------------------------------
// 2. DIRECT REST FALLBACK API ENDPOINTS
// ----------------------------------------------------
const directToolHandler = async (type, req, res) => {
    const args = req.method === 'POST' ? req.body : req.query;
    const deviceId = args.deviceId;
    
    const cleanArgs = { ...args };
    delete cleanArgs.deviceId;

    console.log(`[REST API] Direct request for '${type}':`, cleanArgs);

    try {
        addLog(null, 'REST Fallback API', deviceId || 'Varsayılan Cihaz', `Direct API: ${type}`, 'pending', `Parametreler: ${JSON.stringify(cleanArgs)}`);
        const responseData = await routeCommandToBrowser(type, cleanArgs, deviceId);
        addLog(null, 'REST Fallback API', deviceId || 'Varsayılan Cihaz', `Direct API Başarılı: ${type}`, 'success', `Yanıt boyutu: ${JSON.stringify(responseData).length} karakter.`);
        return res.json({ status: "success", data: responseData });
    } catch (error) {
        addLog(null, 'REST Fallback API', deviceId || 'Varsayılan Cihaz', `Direct API Hatası: ${type}`, 'error', error.message);
        return res.status(500).json({ status: "error", error: error.message });
    }
};

// Map both GET, POST, and PUT to avoid 404s no matter what the client uses!
const fallbackRoutes = [
    { path: '/mcp/tools/browser_navigate', type: 'navigate' },
    { path: '/tools/browser_navigate', type: 'navigate' },
    
    { path: '/mcp/tools/browser_search', type: 'search' },
    { path: '/tools/browser_search', type: 'search' },
    
    { path: '/mcp/tools/browser_get_html', type: 'get_html' },
    { path: '/tools/browser_get_html', type: 'get_html' },
    
    { path: '/mcp/tools/browser_get_markdown', type: 'get_markdown' },
    { path: '/tools/browser_get_markdown', type: 'get_markdown' },
    
    { path: '/mcp/tools/browser_scroll', type: 'scroll' },
    { path: '/tools/browser_scroll', type: 'scroll' },
    
    { path: '/mcp/tools/browser_click', type: 'click' },
    { path: '/tools/browser_click', type: 'click' },
    
    { path: '/mcp/tools/browser_type', type: 'type' },
    { path: '/tools/browser_type', type: 'type' },

    { path: '/mcp/tools/browser_toggle_overlay', type: 'toggle_overlay' },
    { path: '/tools/browser_toggle_overlay', type: 'toggle_overlay' },
    
    { path: '/mcp/tools/browser_screenshot', type: 'screenshot' },
    { path: '/tools/browser_screenshot', type: 'screenshot' },
    
    { path: '/mcp/tools/browser_execute_js', type: 'execute_js' },
    { path: '/tools/browser_execute_js', type: 'execute_js' }
];

fallbackRoutes.forEach(route => {
    app.all(route.path, (req, res) => {
        directToolHandler(route.type, req, res);
    });
});

// JSON API Status endpoint for Live updates
app.get('/api/status', (req, res) => {
    const sessions = Array.from(sseSessions.entries()).map(([id, session]) => ({
        id: id,
        clientName: session.clientInfo?.name || 'MCP Client'
    }));
    res.json({
        status: "running",
        connected_browsers: Array.from(browsers.keys()),
        active_sse_sessions_count: sseSessions.size,
        active_sse_sessions: sessions,
        logs: logs
    });
});

// Information root endpoint
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MCP Android Browser Bridge Server</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: #0b1120;
            color: #f3f4f6;
        }
        .code-font {
            font-family: 'JetBrains Mono', monospace;
        }
        .glow-indigo {
            box-shadow: 0 0 25px rgba(99, 102, 241, 0.15);
        }
        .glow-terminal {
            box-shadow: inset 0 0 15px rgba(0, 0, 0, 0.6);
        }
    </style>
</head>
<body class="min-h-screen flex flex-col justify-between selection:bg-indigo-500 selection:text-white">

    <!-- Header / Navbar -->
    <header class="border-b border-slate-800/80 bg-slate-900/40 backdrop-blur sticky top-0 z-50 px-6 py-4">
        <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                </div>
                <div>
                    <h1 class="text-lg font-bold tracking-tight text-white flex items-center gap-2">
                        Android MCP Bridge Console
                        <span class="px-2 py-0.5 text-[10px] font-semibold tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full uppercase">Aktif</span>
                    </h1>
                    <p class="text-xs text-slate-400">Model Context Protocol (MCP) için Gerçek Zamanlı İzleme Paneli</p>
                </div>
            </div>
            <div class="flex items-center gap-3">
                <a href="/sse" target="_blank" class="px-4 py-2 text-xs font-semibold text-indigo-400 hover:text-white bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 hover:border-indigo-500/40 rounded-xl transition duration-200">
                    SSE Bağlantısını Test Et
                </a>
            </div>
        </div>
    </header>

    <!-- Main Content Grid -->
    <main class="max-w-7xl mx-auto w-full px-6 py-8 flex-grow grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        <!-- Left Side: System Metrics & Connections (5 Columns) -->
        <div class="lg:col-span-5 flex flex-col gap-6">
            
            <!-- Connection Status Panel -->
            <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 glow-indigo relative overflow-hidden">
                <div class="absolute top-0 right-0 w-32 h-32 bg-indigo-600/10 rounded-full blur-3xl"></div>
                
                <h2 class="text-xs font-bold tracking-wider uppercase text-slate-400 mb-6 flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
                    Sistem Metrikleri
                </h2>
                
                <!-- Server Metrics -->
                <div class="grid grid-cols-2 gap-4 relative z-10">
                    <div class="bg-slate-950/40 border border-slate-800/80 rounded-xl p-4">
                        <div class="text-[10px] text-slate-500 uppercase tracking-wider mb-1 font-semibold">Bağlı Android Cihazları</div>
                        <div class="flex items-baseline gap-1.5">
                            <span id="browser-count" class="text-3xl font-extrabold text-white">0</span>
                            <span class="text-xs text-slate-400 font-medium">cihaz</span>
                        </div>
                    </div>
                    
                    <div class="bg-slate-950/40 border border-slate-800/80 rounded-xl p-4">
                        <div class="text-[10px] text-slate-500 uppercase tracking-wider mb-1 font-semibold">Aktif İşlemciler (AI)</div>
                        <div class="flex items-baseline gap-1.5">
                            <span id="sse-count" class="text-3xl font-extrabold text-indigo-400">0</span>
                            <span class="text-xs text-slate-400 font-medium">istemci</span>
                        </div>
                    </div>
                </div>

                <!-- Live device list -->
                <div class="mt-6 pt-5 border-t border-slate-800">
                    <h3 class="text-xs font-bold tracking-wider uppercase text-slate-400 mb-3 flex items-center gap-2">
                        <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                        Bağlı Aktif Cihazlar
                    </h3>
                    <div id="device-list" class="space-y-2">
                        <div class="text-xs text-slate-500 italic py-2">Hiçbir cihaz bağlı değil. Android uygulamasından köprüye bağlanın.</div>
                    </div>
                </div>

                <!-- Active AI Processors List -->
                <div class="mt-6 pt-5 border-t border-slate-800">
                    <h3 class="text-xs font-bold tracking-wider uppercase text-slate-400 mb-3 flex items-center gap-2">
                        <svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                        Aktif İşlemciler (AI İstemcileri)
                    </h3>
                    <div id="processor-list" class="space-y-2">
                        <div class="text-xs text-slate-500 italic py-2">Aktif yapay zeka oturumu bulunmuyor.</div>
                    </div>
                </div>
            </div>

            <!-- Client Configuration Helper -->
            <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-6">
                <h2 class="text-xs font-bold tracking-wider uppercase text-slate-400 mb-4">MCP İstemci Kurulumu</h2>
                <p class="text-xs text-slate-400 mb-4 leading-relaxed">
                    Yapay zeka asistanınızı (Cursor, Claude Desktop, Windsurf, vb.) bu köprüye bağlamak için aşağıdaki SSE adresini kullanın:
                </p>
                
                <div class="bg-slate-950 border border-slate-800/80 rounded-xl p-3 mb-4 flex items-center justify-between gap-2 overflow-hidden">
                    <span id="sse-url-text" class="text-xs text-indigo-300 code-font truncate select-all"></span>
                    <button onclick="copySseUrl()" class="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[10px] font-bold transition flex-shrink-0">
                        Kopyala
                    </button>
                </div>

                <div class="space-y-2.5 text-xs text-slate-400 leading-relaxed">
                    <div class="flex gap-2">
                        <span class="text-indigo-400 font-bold">1.</span>
                        <span>Cursor / Windsurf <b>Settings -> MCP</b> sayfasına gidin.</span>
                    </div>
                    <div class="flex gap-2">
                        <span class="text-indigo-400 font-bold">2.</span>
                        <span>Yeni bir MCP Server ekleyin, tipini <b>SSE</b> olarak seçin.</span>
                    </div>
                    <div class="flex gap-2">
                        <span class="text-indigo-400 font-bold">3.</span>
                        <span>URL kısmına yukarıdaki adresi yapıştırın.</span>
                    </div>
                </div>
            </div>

        </div>

        <!-- Right Side: Live Logs & Available tools (7 Columns) -->
        <div class="lg:col-span-7 flex flex-col gap-6">
            
            <!-- Live Activity Console (LOGS) -->
            <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 flex flex-col h-[400px] overflow-hidden">
                <div class="flex justify-between items-center mb-4">
                    <h2 class="text-xs font-bold tracking-wider uppercase text-slate-400 flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
                        Canlı İşlem Logları (Log Stream)
                    </h2>
                    <span class="text-[10px] code-font text-slate-500 px-2 py-0.5 bg-slate-950 rounded-md">Realtime Polling</span>
                </div>
                
                <!-- Terminal Style Log Display -->
                <div id="terminal" class="bg-slate-950 rounded-xl border border-slate-800/80 p-4 font-mono text-[11px] text-slate-300 flex-grow overflow-y-auto space-y-2.5 glow-terminal">
                    <!-- Log entries loaded dynamically -->
                    <div class="text-slate-500 italic">Sistem logları yükleniyor...</div>
                </div>
            </div>

            <!-- List of Supported Tools -->
            <div class="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6">
                <h3 class="text-xs font-bold tracking-wider uppercase text-slate-400 mb-4">Desteklenen MCP Araçları (Tools)</h3>
                
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    ${TOOLS.map(tool => `
                        <div class="bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 rounded-xl p-4 transition flex flex-col justify-between">
                            <div>
                                <div class="flex justify-between items-center mb-2">
                                    <span class="px-2 py-0.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded text-[10px] code-font font-semibold">
                                        ${tool.name}
                                    </span>
                                </div>
                                <p class="text-[11px] text-slate-300 leading-relaxed">${tool.description}</p>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>

        </div>

    </main>

    <!-- Footer -->
    <footer class="border-t border-slate-800/60 bg-slate-950/60 px-6 py-6 text-center text-xs text-slate-500">
        <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
            <p>© 2026 MCP Android Browser Bridge Server. Tüm hakları saklıdır.</p>
            <p>Durum güncellemeleri ve işlem logları anlık olarak otomatik yenilenir.</p>
        </div>
    </footer>

    <!-- Script for Live Status Polling -->
    <script>
        // Set dynamic SSE URL
        const secureProtocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
        const sseUrl = \`\${secureProtocol}//\${window.location.host}/sse\`;
        document.getElementById('sse-url-text').textContent = sseUrl;

        function copySseUrl() {
            navigator.clipboard.writeText(sseUrl);
            alert("SSE Bağlantı Adresi Başarıyla Kopyalandı!");
        }

        // Cache last logs to avoid unnecessary DOM updates
        let lastLogIdHash = "";

        async function updateStatus() {
            try {
                const response = await fetch('/api/status');
                if (!response.ok) return;
                const data = await response.json();
                
                // Update Counts
                document.getElementById('browser-count').textContent = data.connected_browsers.length;
                document.getElementById('sse-count').textContent = data.active_sse_sessions_count;
                
                // Update connected devices list
                const deviceListDiv = document.getElementById('device-list');
                if (data.connected_browsers.length === 0) {
                    deviceListDiv.innerHTML = \`<div class="text-xs text-slate-500 italic py-2">Hiçbir cihaz bağlı değil. Android uygulamasından köprüye bağlanın.</div>\`;
                } else {
                    deviceListDiv.innerHTML = data.connected_browsers.map(deviceId => \`
                        <div class="flex items-center justify-between bg-slate-950 border border-slate-800/80 px-3 py-2 rounded-xl">
                            <span class="text-xs text-slate-300 code-font font-medium">\${deviceId}</span>
                            <span class="flex h-2 w-2 relative">
                                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                            </span>
                        </div>
                    \`).join('');
                }

                // Update active processors list
                const processorListDiv = document.getElementById('processor-list');
                if (!data.active_sse_sessions || data.active_sse_sessions.length === 0) {
                    processorListDiv.innerHTML = \`<div class="text-xs text-slate-500 italic py-2">Aktif yapay zeka oturumu bulunmuyor.</div>\`;
                } else {
                    processorListDiv.innerHTML = data.active_sse_sessions.map(session => \`
                        <div class="flex items-center justify-between bg-slate-950 border border-slate-800/80 px-3 py-2 rounded-xl">
                            <div class="flex flex-col">
                                <span class="text-xs text-indigo-300 font-semibold">\${session.clientName}</span>
                                <span class="text-[9px] text-slate-500 code-font">Session: \${session.id.substring(0, 8)}</span>
                            </div>
                            <span class="flex h-1.5 w-1.5 relative">
                                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                                <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-indigo-500"></span>
                            </span>
                        </div>
                    \`).join('');
                }

                // Render Logs
                const logHash = data.logs.map(l => l.id).join(',');
                if (logHash !== lastLogIdHash) {
                    lastLogIdHash = logHash;
                    const terminal = document.getElementById('terminal');
                    if (!data.logs || data.logs.length === 0) {
                        terminal.innerHTML = \`<div class="text-slate-500 italic">Henüz bir işlem gerçekleştirilmedi.</div>\`;
                    } else {
                        terminal.innerHTML = data.logs.map(log => {
                            let statusColor = "text-slate-400";
                            let statusBadge = "[INFO]";
                            
                            if (log.status === 'success') {
                                statusColor = "text-emerald-400";
                                statusBadge = "[OK]";
                            } else if (log.status === 'error') {
                                statusColor = "text-red-400 font-bold animate-pulse";
                                statusBadge = "[FAIL]";
                            } else if (log.status === 'pending') {
                                statusColor = "text-amber-400";
                                statusBadge = "[PENDING]";
                            }
                            
                            return \`
                                <div class="pb-2 border-b border-slate-900/60 last:border-0 last:pb-0">
                                    <div class="flex items-center gap-2 text-[10px]">
                                        <span class="text-slate-500">[\${log.timestamp}]</span>
                                        <span class="\${statusColor} font-bold">\${statusBadge}</span>
                                        <span class="text-indigo-300 font-semibold">\${log.clientName}</span>
                                        <span class="text-slate-400">-></span>
                                        <span class="text-slate-400 font-medium">\${log.deviceId}</span>
                                    </div>
                                    <div class="text-white font-medium mt-0.5 text-xs">\${log.action}</div>
                                    \${log.details ? \`<div class="text-slate-400 text-[10px] mt-0.5 leading-relaxed bg-slate-950/80 p-1.5 rounded border border-slate-900/80 code-font overflow-x-auto">\${log.details}</div>\` : ''}
                                </div>
                            \`;
                        }).join('');
                    }
                }
            } catch (err) {
                console.error("Status update error:", err);
            }
        }

        // Poll status every 2 seconds
        updateStatus();
        setInterval(updateStatus, 2000);
    </script>
</body>
</html>
    `);
});

// Start listening
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(` MCP Bridge Server is running on port ${PORT}`);
    console.log(` - Root Endpoint: http://localhost:${PORT}/`);
    console.log(` - Standard MCP SSE: http://localhost:${PORT}/sse`);
    console.log(` - Connected Devices Count: ${browsers.size}`);
    console.log(`=================================================`);
});
