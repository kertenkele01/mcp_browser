const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "secure_mcp_token"; // Güvenlik Anahtarı

// Aktif Android Tarayıcı bağlantılarını tutar
const devices = new Map(); // deviceId -> { ws, token }
// Askıda bekleyen AI isteklerini tutar (callback'ler)
const pendingRequests = new Map(); // messageId -> { resolve, reject, timeout }

// HTTP Sunucu Durum Sayfası
app.get('/', (req, res) => {
    res.json({
        status: "online",
        message: "Android AI Browser MCP Bridge is running!",
        connected_devices: Array.from(devices.keys())
    });
});

// WebSocket Bağlantı Noktası (Android Cihazlar İçin)
wss.on('connection', (ws) => {
    console.log('Yeni bir ham WebSocket bağlantısı kuruldu.');
    let registeredDeviceId = null;

    ws.on('message', (messageStr) => {
        try {
            const message = JSON.parse(messageStr);
            
            // 1. Android Cihaz Kaydı
            if (message.type === 'register' && message.role === 'browser') {
                if (message.token !== ACCESS_TOKEN) {
                    console.log(`Hatalı Token Denemesi: ${message.deviceId}`);
                    ws.send(JSON.stringify({ type: "error", message: "Yetkisiz erişim: Hatalı Token" }));
                    ws.close();
                    return;
                }

                registeredDeviceId = message.deviceId;
                devices.set(registeredDeviceId, { ws, token: message.token });
                console.log(`Android cihazı başarıyla eşlendi: ${registeredDeviceId}`);
                ws.send(JSON.stringify({ type: "register_ack", status: "success" }));
                return;
            }

            // 2. Android Cihazından Gelen Komut Yanıtları
            if (message.type === 'response') {
                const messageId = message.messageId;
                if (pendingRequests.has(messageId)) {
                    const { resolve, timeout } = pendingRequests.get(messageId);
                    clearTimeout(timeout);
                    pendingRequests.delete(messageId);
                    resolve(message);
                }
                return;
            }

        } catch (err) {
            console.error('Mesaj işlenirken hata oluştu:', err);
        }
    });

    ws.on('close', () => {
        if (registeredDeviceId) {
            devices.delete(registeredDeviceId);
            console.log(`Cihaz bağlantısı koptu: ${registeredDeviceId}`);
        }
    });
});

// AI İÇİN MCP HTTP REST API (Komut Gönderme Arabirimi)
// AI buraya POST isteği atarak telefona komut gönderir ve telefonun cevabını bekler.
app.post('/api/mcp/command', (req, res) => {
    const { deviceId, token, command, ...params } = req.body;

    // Güvenlik Kontrolleri
    if (token !== ACCESS_TOKEN) {
        return res.status(401).json({ status: "error", error: "Yetkisiz erişim: Geçersiz Token" });
    }

    const device = devices.get(deviceId);
    if (!device) {
        return res.status(404).json({ status: "error", error: `Eşleşen cihaz bulunamadı. Aktif cihazlar: ${Array.from(devices.keys()).join(', ')}` });
    }

    const messageId = uuidv4();
    const payload = {
        type: command, // navigate, get_html, scroll, click, execute_js
        messageId,
        ...params
    };

    // Promise yapısı ile telefondan gelecek WebSocket cevabını bekliyoruz (Senkron köprüleme)
    const responsePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingRequests.delete(messageId);
            reject(new Error("Cihazdan yanıt gelmedi, zaman aşımı (Timeout)"));
        }, 15000); // 15 Saniye limit

        pendingRequests.set(messageId, { resolve, reject, timeout });
    });

    // Komutu WebSocket üzerinden Android telefona gönder
    device.ws.send(JSON.stringify(payload));
    console.log(`Cihaza (${deviceId}) komut gönderildi: [${command}] - ID: ${messageId}`);

    // Telefondan gelen cevabı bekleyip HTTP yanıtı olarak AI istemcisine dön
    responsePromise
        .then(result => {
            res.json(result);
        })
        .catch(err => {
            res.status(504).json({ status: "error", error: err.message });
        });
});

server.listen(PORT, () => {
    console.log(`MCP Android Bridge ${PORT} portunda yayında.`);
});
