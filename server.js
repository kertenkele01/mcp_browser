const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('crypto'); // UUID simülasyonu için dahili metod

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// GÜVENLİK AYARI: Token kontrolünü tamamen pasif yapmak için boşa çekilmiştir.
// Eğer güvenlik isterseniz bu değeri "secure_mcp_token" yapabilirsiniz.
const SECURE_TOKEN = ""; 

// Bağlı olan Android Tarayıcı WebSocket bağlantılarını tutar
let activeBrowsers = new Map(); // deviceId -> socket
// Bekleyen MCP isteklerini tutar
let pendingRequests = new Map(); // messageId -> responseCallback

// Render/Heroku gibi platformların bağlantıyı kesmesini önlemek için ping mekanizması
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let registeredDevice = null;

    ws.on('message', (message) => {
        try {
            const payload = JSON.parse(message.toString());
            console.log("WebSocket Gelen Mesaj:", payload);

            // 1. Android Tarayıcı Kayıt İşlemi
            if (payload.type === 'register' && payload.role === 'browser') {
                const deviceId = payload.deviceId || "unknown_android";
                
                // Token kontrolü (SECURE_TOKEN boş ise bypass edilir)
                if (SECURE_TOKEN && payload.token !== SECURE_TOKEN) {
                    console.log(`Geçersiz token denemesi: ${deviceId}`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Yetkisiz erişim (Geçersiz Token)' }));
                    ws.close();
                    return;
                }

                registeredDevice = deviceId;
                activeBrowsers.set(deviceId, ws);
                console.log(`Android Tarayıcı Kaydedildi: ${deviceId}`);
                
                ws.send(JSON.stringify({ type: 'register_ack', status: 'connected' }));
                return;
            }

            // 2. Android Tarayıcıdan Gelen Yanıtı MCP İstemcisine İletme
            if (payload.type === 'response') {
                const messageId = payload.messageId;
                const callback = pendingRequests.get(messageId);
                if (callback) {
                    callback(payload);
                    pendingRequests.delete(messageId);
                }
            }
        } catch (err) {
            console.error("Mesaj işleme hatası:", err);
        }
    });

    ws.on('close', () => {
        if (registeredDevice) {
            activeBrowsers.delete(registeredDevice);
            console.log(`Android Tarayıcı Bağlantısı Kesildi: ${registeredDevice}`);
        }
    });
});

// ==========================================
// MCP PROTOKOLÜ VE SSE / HTTP ENTEGRASYONU
// ==========================================

// 1. MCP Araç Listesi (AI Tarafında Tanımlanacak Araçlar)
const MCP_TOOLS = [
    {
        name: "browser_navigate",
        description: "Android cihazdaki web tarayıcısını belirtilen URL adresine yönlendirir.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "Gidilecek web adresi (örn: https://google.com)" }
            },
            required: ["url"]
        }
    },
    {
        name: "browser_get_html",
        description: "Android tarayıcıda o an açık olan sayfanın tam HTML kaynak kodunu ve URL'ini çeker.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "browser_scroll",
        description: "Açık olan web sayfasını aşağı veya yukarı kaydırır.",
        inputSchema: {
            type: "object",
            properties: {
                direction: { type: "string", enum: ["down", "up"], description: "Kaydırma yönü" }
            }
        }
    },
    {
        name: "browser_click",
        description: "Web sayfasındaki belirtilen CSS seçiciye (selector) sahip elemente tıklar.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS Selector (örn: 'button.submit-btn' veya '#login-button')" }
            },
            required: ["selector"]
        }
    },
    {
        name: "browser_execute_js",
        description: "Web sayfasında özel JavaScript kodu çalıştırır ve sonucunu döndürür.",
        inputSchema: {
            type: "object",
            properties: {
                script: { type: "string", description: "Çalıştırılacak JS kodu" }
            },
            required: ["script"]
        }
    }
];

// Android'e komut gönderme yardımcı fonksiyonu
function sendCommandToAndroid(type, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        // En az bir aktif tarayıcı kontrolü
        if (activeBrowsers.size === 0) {
            return reject(new Error("Bağlı Android cihaz bulunamadı. Lütfen telefonunuzdaki uygulamadan MCP Bridge'e bağlanın."));
        }

        // İlk aktif tarayıcıyı seç
        const [deviceId, ws] = activeBrowsers.entries().next().value;
        const messageId = Math.random().toString(36).substring(2, 15);

        const payload = {
            type,
            messageId,
            ...params
        };

        const timeout = setTimeout(() => {
            if (pendingRequests.has(messageId)) {
                pendingRequests.delete(messageId);
                reject(new Error(`Cihaz yanıt vermedi (Zaman Aşımı: ${timeoutMs}ms)`));
            }
        }, timeoutMs);

        pendingRequests.set(messageId, (response) => {
            clearTimeout(timeout);
            if (response.status === 'success') {
                resolve(response.data);
            } else {
                reject(new Error(response.error || "Bilinmeyen Android hatası"));
            }
        });

        ws.send(JSON.stringify(payload));
    });
}

// 2. Standart MCP HTTP Endpointleri (SSE ile doğrudan uyumlu çalışır)
app.get('/mcp/tools', (req, res) => {
    res.json({ tools: MCP_TOOLS });
});

app.post('/mcp/tools/call', async (req, res) => {
    const { name, arguments: args } = req.body;
    console.log(`MCP Araç Çağrısı: ${name}`, args);

    try {
        let resultData;
        switch (name) {
            case 'browser_navigate':
                resultData = await sendCommandToAndroid('navigate', { url: args.url });
                res.json({
                    content: [{ type: "text", text: `Başarıyla adrese gidildi: ${args.url}` }]
                });
                break;

            case 'browser_get_html':
                resultData = await sendCommandToAndroid('get_html', {});
                res.json({
                    content: [
                        { type: "text", text: `Mevcut URL: ${resultData.url}\n\nHTML İçeriği alındı.` },
                        { type: "text", text: resultData.html }
                    ]
                });
                break;

            case 'browser_scroll':
                const dir = args.direction || 'down';
                resultData = await sendCommandToAndroid('scroll', { direction: dir });
                res.json({
                    content: [{ type: "text", text: `Sayfa ${dir === 'down' ? 'aşağı' : 'yukarı'} kaydırıldı.` }]
                });
                break;

            case 'browser_click':
                resultData = await sendCommandToAndroid('click', { selector: args.selector });
                res.json({
                    content: [{ type: "text", text: `'${args.selector}' elementine tıklandı.` }]
                });
                break;

            case 'browser_execute_js':
                resultData = await sendCommandToAndroid('execute_js', { script: args.script });
                res.json({
                    content: [{ type: "text", text: `JS Sonucu: ${JSON.stringify(resultData.result)}` }]
                });
                break;

            default:
                res.status(404).json({ error: `Bilinmeyen araç: ${name}` });
        }
    } catch (err) {
        console.error("Araç çalıştırılamadı:", err.message);
        res.status(500).json({
            content: [{ type: "text", text: `Hata: ${err.message}` }],
            isError: true
        });
    }
});

// Basit ana sayfa kontrolü
app.get('/', (req, res) => {
    res.send(`MCP Android Bridge Aktif!<br>Bağlı Cihaz Sayısı: ${activeBrowsers.size}`);
});

server.listen(PORT, () => {
    console.log(`HTTP ve WebSocket Sunucusu ${PORT} portunda çalışıyor.`);
});
