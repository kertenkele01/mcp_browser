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
        }
    });

    ws.on('error', (err) => {
        console.error(`[WS] Connection error:`, err);
    });
});

// ----------------------------------------------------
// 1. STANDARD MCP SSE TRANSPORT ENDPOINTS
// ----------------------------------------------------
const sseSessions = new Map(); // sessionId -> response object

// Helper to send JSON-RPC response or notification to the MCP client over the active SSE stream
function sendSseJsonRpc(sessionId, jsonRpcMessage) {
    const res = sseSessions.get(sessionId);
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

    sseSessions.set(sessionId, res);
    console.log(`[MCP] SSE Session created: ${sessionId}`);

    // Construct ABSOLUTE POST URL for MCP client to avoid relative path resolution bugs in clients like Cursor/Claude Desktop
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['host'] || 'localhost:10000';
    const postUrl = `${protocol}://${host}/message?sessionId=${sessionId}`;

    console.log(`[MCP] Sending SSE endpoint redirect URL: ${postUrl}`);
    res.write(`event: endpoint\ndata: ${postUrl}\n\n`);

    req.on('close', () => {
        clearInterval(heartbeatInterval);
        sseSessions.delete(sessionId);
        console.log(`[MCP] SSE Session closed: ${sessionId}`);
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
            case "browser_get_html": actionType = "get_html"; break;
            case "browser_scroll": actionType = "scroll"; break;
            case "browser_click": actionType = "click"; break;
            case "browser_execute_js": actionType = "execute_js"; break;
            default:
                reply(null, { code: -32601, message: `Tool not found: ${toolName}` });
                return res.status(200).send("accepted");
        }

        try {
            const responseData = await routeCommandToBrowser(actionType, cleanArgs, deviceId);
            reply({
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(responseData, null, 2)
                    }
                ]
            });
        } catch (error) {
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
// This is extremely important because some custom scripts or clients 
// might hit these endpoints directly as REST APIs instead of full MCP.
// ----------------------------------------------------
const directToolHandler = async (type, req, res) => {
    const args = req.method === 'POST' ? req.body : req.query;
    const deviceId = args.deviceId;
    
    const cleanArgs = { ...args };
    delete cleanArgs.deviceId;

    console.log(`[REST API] Direct request for '${type}':`, cleanArgs);

    try {
        const responseData = await routeCommandToBrowser(type, cleanArgs, deviceId);
        return res.json({ status: "success", data: responseData });
    } catch (error) {
        return res.status(500).json({ status: "error", error: error.message });
    }
};

// Map both GET, POST, and PUT to avoid 404s no matter what the client uses!
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

// JSON API Status endpoint for Live updates
app.get('/api/status', (req, res) => {
    res.json({
        status: "running",
        connected_browsers: Array.from(browsers.keys()),
        active_sse_sessions_count: sseSessions.size,
        active_sse_sessions: Array.from(sseSessions.keys())
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
            background-color: #0b0f19;
            color: #f3f4f6;
        }
        .code-font {
            font-family: 'JetBrains Mono', monospace;
        }
        .glow-indigo {
            box-shadow: 0 0 25px rgba(99, 102, 241, 0.15);
        }
        .glow-green {
            box-shadow: 0 0 20px rgba(16, 185, 129, 0.2);
        }
    </style>
</head>
<body class="min-h-screen flex flex-col justify-between selection:bg-indigo-500 selection:text-white">

    <!-- Header / Navbar -->
    <header class="border-b border-slate-800/80 bg-slate-900/40 backdrop-blur sticky top-0 z-50 px-6 py-4">
        <div class="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                </div>
                <div>
                    <h1 class="text-lg font-bold tracking-tight text-white flex items-center gap-2">
                        Android MCP Bridge
                        <span class="px-2 py-0.5 text-[10px] font-semibold tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full uppercase">Aktif</span>
                    </h1>
                    <p class="text-xs text-slate-400">Model Context Protocol (MCP) için Android Köprüsü</p>
                </div>
            </div>
            <div class="flex items-center gap-3">
                <a href="/sse" target="_blank" class="px-4 py-2 text-xs font-semibold text-indigo-400 hover:text-white bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 hover:border-indigo-500/40 rounded-xl transition duration-200">
                    SSE Bağlantısını Test Et
                </a>
            </div>
        </div>
    </header>

    <!-- Main Content -->
    <main class="max-w-6xl mx-auto w-full px-6 py-10 flex-grow grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        <!-- Left Column: Status and Real-time connections -->
        <div class="lg:col-span-1 flex flex-col gap-6">
            
            <!-- Connection Status Panel -->
            <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 glow-indigo relative overflow-hidden">
                <div class="absolute top-0 right-0 w-32 h-32 bg-indigo-600/10 rounded-full blur-3xl"></div>
                
                <h2 class="text-sm font-bold tracking-wider uppercase text-slate-400 mb-6 flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
                    Sunucu Durumu
                </h2>
                
                <!-- Server Metrics -->
                <div class="space-y-6 relative z-10">
                    <div>
                        <div class="text-xs text-slate-500 uppercase tracking-wider mb-1">Bağlı Android Tarayıcıları</div>
                        <div class="flex items-baseline gap-2">
                            <span id="browser-count" class="text-4xl font-extrabold text-white">0</span>
                            <span class="text-xs text-slate-400">aktif cihaz</span>
                        </div>
                    </div>
                    
                    <div>
                        <div class="text-xs text-slate-500 uppercase tracking-wider mb-1">Aktif MCP SSE Oturumları</div>
                        <div class="flex items-baseline gap-2">
                            <span id="sse-count" class="text-4xl font-extrabold text-indigo-400">0</span>
                            <span class="text-xs text-slate-400">aktif istemci</span>
                        </div>
                    </div>

                    <!-- Live device list -->
                    <div class="pt-4 border-t border-slate-800">
                        <div class="text-xs font-semibold text-slate-400 mb-2">Bağlı Cihaz Kimlikleri:</div>
                        <div id="device-list" class="space-y-2">
                            <div class="text-xs text-slate-500 italic py-2">Hiçbir cihaz bağlı değil. Android uygulamasından köprüye bağlanın.</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Client Configuration Helper -->
            <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-6">
                <h2 class="text-sm font-bold tracking-wider uppercase text-slate-400 mb-4">MCP İstemci Kurulumu</h2>
                <p class="text-xs text-slate-400 mb-4 leading-relaxed">
                    Yapay zeka asistanınızı (Cursor, Claude Desktop, Windsurf) bu köprüye bağlamak için aşağıdaki SSE adresini kullanın:
                </p>
                
                <div class="bg-slate-950 border border-slate-800 rounded-xl p-3 mb-4 flex items-center justify-between gap-2 overflow-hidden">
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

        <!-- Right Column: Available tools list and API guides -->
        <div class="lg:col-span-2 flex flex-col gap-6">
            
            <!-- Welcome Info Banner -->
            <div class="bg-gradient-to-r from-slate-900 via-indigo-950/20 to-slate-900 border border-slate-800/80 rounded-2xl p-6 flex flex-col sm:flex-row gap-5 items-start">
                <div class="p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-indigo-400">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                </div>
                <div>
                    <h3 class="font-bold text-white mb-1">Android Köprüsü Nasıl Çalışır?</h3>
                    <p class="text-xs text-slate-400 leading-relaxed">
                        Bu sunucu, Android telefonunuzda açık olan tarayıcıyı (Webview) yerel bir yapay zeka aracı haline getirir. 
                        AI asistanınız sayfalara gidebilir (<b>navigate</b>), HTML kodunu okuyabilir (<b>get_html</b>), butonlara tıklayabilir (<b>click</b>), sayfayı kaydırabilir (<b>scroll</b>) ve özel JavaScript çalıştırabilir (<b>execute_js</b>). Cihazınızdan gelen tüm komutlar WebSocket üzerinden gerçek zamanlı olarak iletilir.
                    </p>
                </div>
            </div>

            <!-- List of Supported Tools -->
            <div class="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6">
                <h3 class="text-sm font-bold tracking-wider uppercase text-slate-400 mb-4">Desteklenen MCP Araçları (Tools)</h3>
                
                <div class="space-y-4">
                    ${TOOLS.map(tool => `
                        <div class="bg-slate-900/80 border border-slate-800 hover:border-slate-700 rounded-xl p-4 transition">
                            <div class="flex flex-wrap justify-between items-center gap-2 mb-2">
                                <span class="px-2.5 py-1 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg text-xs code-font font-bold">
                                    ${tool.name}
                                </span>
                                <span class="text-[10px] text-slate-500 code-font">JSON-RPC</span>
                            </div>
                            <p class="text-xs text-slate-300 leading-relaxed">${tool.description}</p>
                        </div>
                    `).join('')}
                </div>
            </div>

        </div>

    </main>

    <!-- Footer -->
    <footer class="border-t border-slate-800/60 bg-slate-950/60 px-6 py-6 text-center text-xs text-slate-500">
        <div class="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
            <p>© 2026 MCP Android Browser Bridge. Tüm hakları saklıdır.</p>
            <p>Durum güncellemeleri anlık olarak otomatik yenilenir.</p>
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
                            <span class="text-xs text-slate-300 code-font">\${deviceId}</span>
                            <span class="flex h-2 w-2 relative">
                                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                            </span>
                        </div>
                    \`).join('');
                }
            } catch (err) {
                console.error("Status update error:", err);
            }
        }

        // Poll status every 3 seconds
        updateStatus();
        setInterval(updateStatus, 3000);
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
