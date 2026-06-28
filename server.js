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

app.get('/sse', (req, res) => {
    const sessionId = randomUUID();
    
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
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

    if (!rpcRequest || typeof rpcRequest !== 'object') {
        return res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }

    const { method, params, id } = rpcRequest;

    // Handle notifications (no response required in JSON-RPC)
    if (id === undefined || id === null) {
        console.log(`[MCP] Received Notification: ${method}`);
        return res.status(202).send();
    }

    // 1. Handle initialize handshake (CRITICAL for clients like Cursor / Claude Desktop)
    if (method === 'initialize') {
        return res.json({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: params?.protocolVersion || "2024-11-05",
                capabilities: {
                    tools: {} // We support tools
                },
                serverInfo: {
                    name: "mcp-android-bridge",
                    version: "1.0.0"
                }
            }
        });
    }

    // 2. Handle ping
    if (method === 'ping') {
        return res.json({
            jsonrpc: "2.0",
            result: {},
            id
        });
    }

    // 3. Handle tools list
    if (method === 'tools/list') {
        return res.json({
            jsonrpc: "2.0",
            result: { tools: TOOLS },
            id
        });
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
                return res.json({
                    jsonrpc: "2.0",
                    error: { code: -32601, message: `Tool not found: ${toolName}` },
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

    // Default response for other unhandled methods
    return res.json({
        jsonrpc: "2.0",
        result: {},
        id
    });
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

// Information root endpoint
app.get('/', (req, res) => {
    res.json({
        name: "MCP Android Browser Bridge Server",
        status: "running",
        connected_browsers: Array.from(browsers.keys()),
        mcp_sse_endpoint: "/sse",
        supported_tools: TOOLS.map(t => t.name)
    });
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
