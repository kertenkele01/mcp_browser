const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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

// Logging system with sanitization & security masking
const logs = [];
function addLog(sessionId, clientName, deviceId, action, status, details) {
    let cleanDetails = typeof details === 'string' ? details : JSON.stringify(details || '');
    // Mask base64 images and sensitive tokens/passwords in logs
    cleanDetails = cleanDetails.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA]');
    cleanDetails = cleanDetails.replace(/(token|secret|password|apiKey|bearer)[:=]\s*["']?([a-zA-Z0-9_\-\.]{6,})["']?/gi, '$1: [PROTECTED]');

    const logEntry = {
        id: randomUUID().substring(0, 8),
        timestamp: new Date().toLocaleTimeString('tr-TR'),
        sessionId: sessionId ? sessionId.substring(0, 16) : 'N/A',
        clientName: clientName || 'N/A',
        deviceId: deviceId || 'Varsayılan',
        action,
        status, // 'success', 'error', 'pending', 'info'
        details: cleanDetails || ''
    };
    logs.unshift(logEntry);
    if (logs.length > 100) {
        logs.pop();
    }
}

// Standard MCP Tools schema
const TOOLS = [
    {
        name: "browser_get_tool_documentation",
        description: "Android Tarayıcı MCP Köprüsündeki tüm araçların (tools) detaylı kullanım kılavuzunu, parametrelerini, örnek çağrılarını ve en iyi ajansal iş akışlarını (Agent Best Practices / Playbooks) döner. Bir aracın nasıl çalıştığını öğrenmek veya karmaşık web otomasyon adımlarını planlamak için bu aracı çağırın.",
        inputSchema: {
            type: "object",
            properties: {
                tool_name: { 
                    type: "string", 
                    description: "Hakkında detaylı bilgi ve örnek iş akışı istenen aracın adı (örn. 'browser_get_markdown', 'browser_click', 'browser_type', 'browser_search', 'browser_navigate', 'all'). Boş bırakılırsa tüm araçların tam rehberini döner." 
                },
                category: { 
                    type: "string", 
                    enum: ["all", "navigation", "interaction", "content_extraction", "tabs_and_sessions", "meta"],
                    description: "Araç kategorisine göre filtreleme ('all', 'navigation', 'interaction', 'content_extraction', 'tabs_and_sessions', 'meta')" 
                }
            }
        }
    },
    {
        name: "browser_navigate",
        description: "Android tarayıcısında belirtilen web adresine (URL) gider. Ayrıntılı kılavuz için 'browser_get_tool_documentation' aracını inceleyin.",
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
        description: "Şu an açık olan sayfanın saf HTML kaynağını (`html`), sayfa URL'sini ve sayfa başlığını alır.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_get_local_markdown",
        description: "Şu an açık olan sayfanın yerel dahili dönüştürücüsü (Built-in Turndown JS Engine) ile dönüştürülmüş Markdown içeriğini (`markdown`) alır. Crawl4AI sunucusuna istek atmadan doğrudan yerel ve hızlı dönüşüm yapar.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_get_markdown",
        description: "Şu an açık olan sayfanın resmi Python Crawl4AI motoru ile işlenmiş fit_markdown/Markdown içeriğini (`markdown`), kullanılan motor bilgisini (`engine_used`) ve dönüştürme durumunu (`markdown_status`) alır.",
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
        description: "Belirtilen element ID sayısı (örn. '1' veya '5'), Vimium etiketi, CSS seçici veya metin ('text=Uçuş Ara') ile eşleşen öğeye tıklar.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "Tıklanacak elementin ID sayısı (örn. '1'), Vimium etiketi, CSS seçicisi veya metni (örn. 'text=Arama Yap')" },
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
    },
    {
        name: "browser_type",
        description: "Belirtilen input/text/tarih alanına yazı girer. Selector olarak element ID sayısı (örn. '2'), Vimium ID sayısı veya CSS seçici kullanılabilir.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "Yazı girilecek elementin ID sayısı (örn. '2') veya CSS seçicisi" },
                text: { type: "string", description: "Girilecek metin veya tarih (örn. 'İstanbul' veya '2026-08-15')" },
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
                tabId: { type: "string", description: "Hedef sekme ID'si (opsiyonel)" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_new_tab",
        description: "Mevcut AI oturumunda yeni bir sekme açar.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "Açılacak URL adresi (opsiyonel, varsayılan google.com)" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_close_tab",
        description: "Mevcut AI oturumunda bir sekkeyi veya aktif sekkeyi kapatır.",
        inputSchema: {
            type: "object",
            properties: {
                tabId: { type: "string", description: "Kapatılacak sekme ID'si (opsiyonel, belirtilmezse aktif sekme kapatılır)" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_list_tabs",
        description: "Bu AI oturumuna ait tüm açık sekmeleri listeler.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_switch_tab",
        description: "Belirtilen sekmeye geçiş yapar.",
        inputSchema: {
            type: "object",
            properties: {
                tabId: { type: "string", description: "Geçiş yapılacak sekme ID'si" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["tabId"]
        }
    },
    {
        name: "browser_get_session_info",
        description: "Mevcut tarayıcı oturumunun ve profilinin bilgilerini (Oturum ID, Güvenlik Token'ı, Çerez Durumu, İstemci Adı ve Sekme Sayısı) getirir.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_list_sessions",
        description: "Tüm aktif oturumları listeler. Eğer kullanıcı ayarlarında oturumlar arası erişim kapalı ise yalnızca mevcut AI oturumu döner.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_clear_session_data",
        description: "Mevcut veya belirtilen tarayıcı oturumunun çerezlerini, önbelleğini ve gezinti geçmişini temizler.",
        inputSchema: {
            type: "object",
            properties: {
                targetSessionId: { type: "string", description: "Temizlenecek oturum ID'si (opsiyonel, belirtilmezse mevcut oturum)" },
                clearCookies: { type: "boolean", description: "Çerezleri sil (Varsayılan: true)" },
                clearCache: { type: "boolean", description: "Önbelleği sil (Varsayılan: true)" },
                clearHistory: { type: "boolean", description: "Geçmişi sil (Varsayılan: true)" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    }
];

// Comprehensive Tool Documentation & Agent Playbooks Dictionary
const TOOL_DOCUMENTATION = {
    overview: {
        title: "Android Tarayıcı MCP Köprüsü - AI Ajanı Kullanım Rehberi (Agent Playbook & Skills)",
        description: "Bu sistem, gerçek bir Android cihazı üzerindeki donanım hızlandırmalı WebView ile çalışan yüksek performanslı Model Context Protocol (MCP) köprüsüdür. Yapay zeka ajanları gerçek tarayıcı ortamında arama yapabilir, sayfaları okuyabilir, form doldurabilir, butonlara tıklayabilir, sekme ve izole oturum yönetimi gerçekleştirebilir.",
        capabilities: [
            "Gerçek Android WebView ortamında tam JavaScript, DOM, CSS ve Canvas çalıştırma",
            "Multi-Profile Cookie İzolasyonu: Her AI istemcisine özel bağımsız çerez ve depolama alanı",
            "Crawl4AI & Dahili Turndown Markdown Motorları ile anında temiz içerik çıkarma",
            "Vimium-Style Numaralandırılmış Görsel Overlay ile elementleri ID sayılarıyla seçme/tıklama",
            "Çoklu Sekme (Multi-Tab) ve Çoklu Oturum (Multi-Session) yönetimi",
            "Ekran görüntüsü (Screenshot) ve DOM kaynağı alma"
        ],
        meta_tool_note: "İstediğiniz zaman 'browser_get_tool_documentation' aracını çağırarak spesifik bir araç veya kategori hakkında detaylı kılavuz alabilirsiniz."
    },
    categories: {
        navigation: {
            name: "Sayfa Gezinme & Arama",
            tools: ["browser_navigate", "browser_search", "browser_scroll"]
        },
        interaction: {
            name: "Etkileşim, Tıklama & Form Doldurma",
            tools: ["browser_click", "browser_type", "browser_toggle_overlay", "browser_execute_js"]
        },
        content_extraction: {
            name: "İçerik Okuma & Görsel Alma",
            tools: ["browser_get_markdown", "browser_get_local_markdown", "browser_get_html", "browser_screenshot"]
        },
        tabs_and_sessions: {
            name: "Sekme & Profil/Oturum Yönetimi",
            tools: ["browser_new_tab", "browser_close_tab", "browser_list_tabs", "browser_switch_tab", "browser_get_session_info", "browser_clear_session_data"]
        },
        meta: {
            name: "Rehber & Dokümantasyon",
            tools: ["browser_get_tool_documentation"]
        }
    },
    tools: {
        browser_get_tool_documentation: {
            name: "browser_get_tool_documentation",
            category: "meta",
            summary: "Tüm MCP araçlarının parametrelerini, kullanım şekillerini, örneklerini ve en iyi iş akışlarını döner.",
            parameters: {
                tool_name: "(Opsiyonel, String) Hakkında bilgi istenen aracın adı (örn. 'browser_click', 'browser_get_markdown', 'browser_type', 'all'). Boş bırakılırsa tüm araçların rehberi döner.",
                category: "(Opsiyonel, String) Kategori filtresi ('navigation', 'interaction', 'content_extraction', 'tabs_and_sessions', 'meta', 'all')."
            },
            best_practice: "Yeni bir göreve başlarken hangi araçları nasıl kombine edeceğinizi planlamak veya parametre isimlerini doğrulamak için ilk olarak bu aracı çağırın."
        },
        browser_navigate: {
            name: "browser_navigate",
            category: "navigation",
            summary: "Belirtilen web adresine (URL) gider ve sayfanın yüklenmesini başlatır.",
            parameters: {
                url: "(Zorunlu, String) Gidilecek tam web adresi (örn. 'https://en.wikipedia.org' veya 'https://news.ycombinator.com'). Her zaman protokolü (https://) ekleyin.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            example_call: { url: "https://www.google.com" },
            best_practice: "Gezinti sonrası içerik okumak için 'browser_get_local_markdown' veya 'browser_get_markdown' aracını çağırın."
        },
        browser_search: {
            name: "browser_search",
            category: "navigation",
            summary: "Google'da belirtilen anahtar kelimelerle doğrudan arama yapar.",
            parameters: {
                query: "(Zorunlu, String) Aranacak kelime veya cümle (örn. '2026 en iyi yapay zeka modelleri')",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            example_call: { query: "İstanbul hava durumu" },
            best_practice: "Google aramasından sonra arama sonuçlarındaki linkleri ve başlıkları okumak için 'browser_get_local_markdown' çağırın."
        },
        browser_get_local_markdown: {
            name: "browser_get_local_markdown",
            category: "content_extraction",
            summary: "Açık olan sayfanın yerel dahili Turndown motoruyla anında dönüştürülmüş Markdown içeriğini döner.",
            parameters: {
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "En hızlı, en hafif ve sıfır gecikmeli içerik okuma aracıdır. Makale okumak, arama sonuçlarını taramak veya sayfa yapısını anlamak için ilk tercihiniz olmalıdır."
        },
        browser_get_markdown: {
            name: "browser_get_markdown",
            category: "content_extraction",
            summary: "Sayfanın resmi Crawl4AI Python motoru ile işlenmiş fit_markdown içeriğini döner.",
            parameters: {
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Crawl4AI sunucusu aktif olduğunda gereksiz gürültüden arındırılmış temiz metin çıktısı sağlar."
        },
        browser_get_html: {
            name: "browser_get_html",
            category: "content_extraction",
            summary: "Sayfanın ham outerHTML kaynağını döner.",
            parameters: {
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Spesifik DOM elementlerini, form input id/name etiketlerini veya karmaşık CSS seçicilerini bulmak gerektiğinde kullanın."
        },
        browser_screenshot: {
            name: "browser_screenshot",
            category: "content_extraction",
            summary: "Ekranın anlık JPEG görüntüsünü (screenshot) alır.",
            parameters: {
                tabId: "(Opsiyonel, String) Hedef sekme ID'si.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Görsel doğrulama yapmak, captcha/grafik incelemek veya kullanıcı arayüzü düzenini görmek için idealdir."
        },
        browser_toggle_overlay: {
            name: "browser_toggle_overlay",
            category: "interaction",
            summary: "Ekrandaki tüm interaktif elementlerin üzerine Vimium-style görsel numaralandırma etiketleri ekler/kaldırır.",
            parameters: {
                enabled: "(Zorunlu, Boolean) true (etiketleri aç) veya false (kapat)"
            },
            best_practice: "Form doldururken veya karmaşık bir sayfada tıklama yaparken önce overlay'i açın, screenshot alın veya element ID sayılarını tespit edip doğrudan ID numarasıyla ('1', '2' vb.) tıklayın."
        },
        browser_click: {
            name: "browser_click",
            category: "interaction",
            summary: "Belirtilen element ID numarasına ('1', '5'), CSS seçicisine veya metne ('text=Giriş Yap') tıklar.",
            parameters: {
                selector: "(Zorunlu, String) Element ID sayısı (örn. '3'), CSS seçici (örn. '#btn-submit', 'button.primary') veya metin (örn. 'text=Uçuş Ara')"
            },
            example_call: { selector: "text=Arama Yap" },
            best_practice: "Metinle tıklama ('text=...') veya element numarası ile tıklama ('1') genellikle CSS class isimlerinden çok daha dayanıklıdır."
        },
        browser_type: {
            name: "browser_type",
            category: "interaction",
            summary: "Input veya metin alanına yazı yazar ve gerçek klavye/input olaylarını tetikler.",
            parameters: {
                selector: "(Zorunlu, String) Element ID sayısı (örn. '2'), CSS seçici (örn. 'input[name=\"q\"]') veya 'input'",
                text: "(Zorunlu, String) Girilecek metin (örn. 'Ali Veli' veya '2026-08-15')"
            },
            example_call: { selector: "input[type='search']", text: "Antalya Otelleri" },
            best_practice: "Yazı yazdıktan sonra formu göndermek için ilgili butona 'browser_click' yapın veya 'browser_execute_js' ile form.submit() tetikleyin."
        },
        browser_scroll: {
            name: "browser_scroll",
            category: "navigation",
            summary: "Sayfayı aşağı ('down') veya yukarı ('up') kaydırır.",
            parameters: {
                direction: "(Opsiyonel, String) 'down' veya 'up' (Varsayılan: 'down')"
            },
            best_practice: "Sonsuz kaydırmalı sayfalarda (Twitter, feed'ler) veya ekranın altında kalan butonları görünür yapmak için kullanın."
        },
        browser_execute_js: {
            name: "browser_execute_js",
            category: "interaction",
            summary: "Sayfa bağlamında özel JavaScript kodu çalıştırır ve sonucunu döner.",
            parameters: {
                script: "(Zorunlu, String) Çalıştırılacak JS kodu (örn. 'document.title' veya 'window.location.href')"
            },
            best_practice: "Özel DOM sorguları, çerez okuma, sayfa içi hesaplamalar veya karmaşık tetikleyiciler için kullanın."
        },
        browser_new_tab: {
            name: "browser_new_tab",
            category: "tabs_and_sessions",
            summary: "Mevcut AI oturumunda yeni bir tarayıcı sekmesi açar.",
            parameters: {
                url: "(Opsiyonel, String) Açılacak URL adresi (Varsayılan: google.com)"
            },
            best_practice: "Mevcut sayfadaki çalışmanızı kaybetmeden yan bir araştırma veya işlem yapmak istediğinizde yeni sekme açın."
        },
        browser_close_tab: {
            name: "browser_close_tab",
            category: "tabs_and_sessions",
            summary: "Belirtilen veya aktif olan sekmeyi kapatır.",
            parameters: {
                tabId: "(Opsiyonel, String) Kapatılacak sekme ID'si."
            }
        },
        browser_list_tabs: {
            name: "browser_list_tabs",
            category: "tabs_and_sessions",
            summary: "Bu AI oturumuna ait açık tüm sekmeleri başlıkları ve URL'leri ile listeler.",
            parameters: {}
        },
        browser_switch_tab: {
            name: "browser_switch_tab",
            category: "tabs_and_sessions",
            summary: "Belirtilen sekmeye geçiş yapar ve aktif sekme haline getirir.",
            parameters: {
                tabId: "(Zorunlu, String) Hedef sekme ID'si."
            }
        },
        browser_get_session_info: {
            name: "browser_get_session_info",
            category: "tabs_and_sessions",
            summary: "Mevcut oturumun ID'sini, güvenlik token'ını, çerez durumunu, oturumlar arası erişim politikasını ve açık sekme sayısını döner.",
            parameters: {},
            best_practice: "Kendi AI istemci bilgilerinizi ve cihazdaki oturum erişim izin durumunu kontrol etmek için çağırın."
        },
        browser_list_sessions: {
            name: "browser_list_sessions",
            category: "tabs_and_sessions",
            summary: "Kullanılabilir oturumları listeler. Oturumlar arası geçiş izni kapalıysa yalnızca kendi oturumunuz döner.",
            parameters: {},
            best_practice: "Mevcut oturumları incelemek için kullanın. Eğer kullanıcı oturumlar arası geçişi kısıtlamışsa yalnızca kendi oturumunuz listelenir."
        },
        browser_clear_session_data: {
            name: "browser_clear_session_data",
            category: "tabs_and_sessions",
            summary: "Belirtilen oturumun çerezlerini, önbelleğini ve gezinti geçmişini temizler.",
            parameters: {
                targetSessionId: "(Opsiyonel, String) Hedef oturum ID'si.",
                clearCookies: "(Opsiyonel, Boolean) Varsayılan: true",
                clearCache: "(Opsiyonel, Boolean) Varsayılan: true",
                clearHistory: "(Opsiyonel, Boolean) Varsayılan: true"
            }
        }
    },
    playbooks: [
        {
            title: "İş Akışı 1: Web Araması ve Bilgi Toplama (Research & Extract)",
            steps: [
                "1. 'browser_search(query: \"...\")' çağırarak arama yapın.",
                "2. 'browser_get_local_markdown()' çağırarak arama sonuçlarını ve linkleri okuyun.",
                "3. İlgili bir sonuca gitmek için 'browser_navigate(url: \"...\")' veya 'browser_click(selector: \"text=...\")' çağırın.",
                "4. Hedef sayfadaki tam içeriği 'browser_get_local_markdown()' ile çekip kullanıcıya özetleyin."
            ]
        },
        {
            title: "İş Akışı 2: Form Doldurma ve Buton Tıklama (Form Filling & Automation)",
            steps: [
                "1. 'browser_navigate(url: \"...\")' ile sayfayı açın.",
                "2. 'browser_type(selector: \"input[name='username']\", text: \"...\")' ile inputları doldurun.",
                "3. Butona tıklamak için 'browser_click(selector: \"text=Giriş Yap\")' veya CSS seçici kullanın.",
                "4. İşlemin sonucunu doğrulamak için 'browser_get_local_markdown()' veya 'browser_screenshot()' çağırın."
            ]
        },
        {
            title: "İş Akışı 3: Görsel Destekli Hassas Tıklama (Vision-Assisted Clicking)",
            steps: [
                "1. 'browser_toggle_overlay(enabled: true)' ile interaktif elementlerin üzerine numaralandırma etiketlerini yerleştirin.",
                "2. 'browser_screenshot()' alarak etiket numaralarını görsel olarak inceleyin.",
                "3. Hedef elementin numarasını (örn. '5') 'browser_click(selector: \"5\")' ile doğrudan tıklayın.",
                "4. İşi bitirince 'browser_toggle_overlay(enabled: false)' ile overlay'i kapatın."
            ]
        },
        {
            title: "İş Akışı 4: Paralel Görevler & Sekme İzolasyonu (Multi-Tab Management)",
            steps: [
                "1. Mevcut sayfayı bozmamak için 'browser_new_tab(url: \"https://...\")' çağırın.",
                "2. Yeni sekmede işlemlerinizi yürütün.",
                "3. İşiniz bittiğinde 'browser_close_tab()' ile kapatın veya 'browser_switch_tab(tabId: \"...\")' ile önceki sekmeye dönün."
            ]
        }
    ]
};

function generateDocumentationResponse(toolName = 'all', category = 'all') {
    const cleanTool = (toolName || 'all').trim().toLowerCase();
    const cleanCat = (category || 'all').trim().toLowerCase();

    if (cleanTool !== 'all' && TOOL_DOCUMENTATION.tools[cleanTool]) {
        const doc = TOOL_DOCUMENTATION.tools[cleanTool];
        return {
            status: "success",
            requested_tool: cleanTool,
            documentation: doc,
            meta_info: "Tüm araçların ve iş akışlarının tam listesini görmek için tool_name: 'all' parametresi ile çağırabilirsiniz.",
            formatted_text: `### 🛠️ Araç Rehberi: ${doc.name}\n- **Kategori:** ${doc.category}\n- **Özet:** ${doc.summary}\n- **Parametreler:**\n${Object.entries(doc.parameters).map(([k, v]) => `  - \`${k}\`: ${v}`).join('\n')}\n- **En İyi Kullanım (Best Practice):** ${doc.best_practice}\n${doc.example_call ? `- **Örnek Çağrı:** \`${JSON.stringify(doc.example_call)}\`\n` : ''}`
        };
    }

    let filteredTools = Object.values(TOOL_DOCUMENTATION.tools);
    if (cleanCat !== 'all') {
        filteredTools = filteredTools.filter(t => t.category === cleanCat);
    }

    return {
        status: "success",
        overview: TOOL_DOCUMENTATION.overview,
        category_filter: cleanCat,
        total_tools: filteredTools.length,
        tools: filteredTools,
        playbooks: TOOL_DOCUMENTATION.playbooks,
        quick_tip: "Herhangi bir aracın spesifik detayını almak için: browser_get_tool_documentation(tool_name: 'araç_adı') çağırabilirsiniz."
    };
}

// Helper to find connected browser with sticky session-to-device binding
const sessionDeviceBindings = new Map(); // sessionId -> { boundDeviceId, lastToolCallTime }

function getBrowserWsForSession(sessionId = 'default_session', requestedDeviceId = null) {
    const now = Date.now();
    const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 dakikalık inaktivite zaman aşımı

    let binding = sessionDeviceBindings.get(sessionId);

    // İnaktivite süresi dolduysa eşleşmeyi temizle
    if (binding && (now - binding.lastToolCallTime > INACTIVITY_TIMEOUT_MS)) {
        console.log(`[MCP] Oturum '${sessionId}' için cihaz eşleşmesi ('${binding.boundDeviceId}') 30 dk inaktivite sonrası sıfırlandı.`);
        sessionDeviceBindings.delete(sessionId);
        binding = null;
    }

    // 1. AI açıkça online olan geçerli bir deviceId talep ettiyse onu kullan ve eşleştir
    if (requestedDeviceId && browsers.has(requestedDeviceId)) {
        const ws = browsers.get(requestedDeviceId);
        if (ws && ws.readyState === 1) { // 1 = OPEN
            sessionDeviceBindings.set(sessionId, { boundDeviceId: requestedDeviceId, lastToolCallTime: now });
            return { ws, deviceId: requestedDeviceId };
        }
        browsers.delete(requestedDeviceId);
    }

    // 2. Bu oturumun aktif ve hâlâ online olan sabit (sticky) bir bağlı cihazı var mı kontrol et
    if (binding && binding.boundDeviceId && browsers.has(binding.boundDeviceId)) {
        const boundWs = browsers.get(binding.boundDeviceId);
        if (boundWs && boundWs.readyState === 1) {
            binding.lastToolCallTime = now;
            return { ws: boundWs, deviceId: binding.boundDeviceId };
        }
        console.log(`[MCP] Bağlı cihaz '${binding.boundDeviceId}' koptu. '${sessionId}' oturumuna yeni cihaz atanacak.`);
        sessionDeviceBindings.delete(sessionId);
    }

    // 3. AI eski/offline bir deviceId istedi veya oturum henüz bir cihaza bağlı değil:
    // Bağlı ilk aktif Android cihazını seç ve bu oturuma sabitle!
    for (const [id, ws] of browsers.entries()) {
        if (ws && ws.readyState === 1) {
            sessionDeviceBindings.set(sessionId, { boundDeviceId: id, lastToolCallTime: now });
            console.log(`[MCP] Oturum '${sessionId}' için aktif Android cihazı eşleştirildi: '${id}'`);
            return { ws, deviceId: id };
        } else {
            browsers.delete(id);
        }
    }

    return { ws: null, deviceId: null };
}

// Helper to route command to Android browser and await result
function routeCommandToBrowser(type, args, targetDeviceId, sessionId = 'default_session', clientName = 'Yapay Zeka', token = '') {
    return new Promise((resolve, reject) => {
        const { ws, deviceId } = getBrowserWsForSession(sessionId, targetDeviceId);
        if (!ws) {
            return reject(new Error("Bağlı aktif bir Android tarayıcı bulunamadı. Lütfen uygulamanın açık ve köprüye bağlı olduğundan emin olun."));
        }

        const messageId = randomUUID();
        const payload = JSON.stringify({
            type,
            messageId,
            sessionId,
            clientName,
            token,
            ...args
        });

        const timeout = setTimeout(() => {
            pendingRequests.delete(messageId);
            reject(new Error(`Android cihazından (${deviceId}) yanıt alınamadı, zaman aşımı (15s).`));
        }, 15000);

        pendingRequests.set(messageId, { 
            resolve: (val) => {
                // Attach assigned deviceId to response object
                if (val && typeof val === 'object' && !Array.isArray(val)) {
                    val.deviceId = deviceId;
                }
                resolve(val);
            }, 
            reject, 
            timeout 
        });
        ws.send(payload);
        console.log(`[Bridge] Sent command '${type}' (Session: ${sessionId}, Client: ${clientName}, TargetDevice: ${deviceId}) with ID: ${messageId}`);
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
                const existingWs = browsers.get(clientDeviceId);
                if (existingWs && existingWs !== ws) {
                    console.log(`[WS] Replacing existing connection for device: ${clientDeviceId}`);
                    try { existingWs.close(1000, "Replaced by new connection"); } catch (e) {}
                }
                browsers.set(clientDeviceId, ws);
                console.log(`[WS] Android device successfully registered: ${clientDeviceId}`);
                addLog(null, 'Android Uygulaması', clientDeviceId, 'Cihaz Bağlantısı', 'success', 'Cihaz köprüye başarıyla bağlandı ve kullanıma hazır.');
                
                // Send confirmation
                ws.send(JSON.stringify({
                    type: "register_ack",
                    messageId: payload.messageId || "0",
                    deviceId: clientDeviceId,
                    status: "success"
                }));
            } else if (payload.type === 'ping') {
                if (payload.deviceId) {
                    clientDeviceId = payload.deviceId;
                    if (browsers.get(clientDeviceId) !== ws) {
                        browsers.set(clientDeviceId, ws);
                        console.log(`[WS] Re-bound active socket for device: ${clientDeviceId}`);
                    }
                }
                ws.send(JSON.stringify({
                    type: "pong",
                    deviceId: clientDeviceId,
                    timestamp: Date.now()
                }));
            } else if (payload.type === 'response') {
                const { messageId, status, success, data, error } = payload;
                const pending = pendingRequests.get(messageId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    pendingRequests.delete(messageId);
                    if (status === 'success' || success === true) {
                        pending.resolve(data || {});
                    } else {
                        pending.reject(new Error(error || "Cihaz işlem hatası"));
                    }
                }
            }
        } catch (err) {
            console.error("[WS] Error parsing message:", err);
        }
    });

    ws.on('close', () => {
        if (clientDeviceId) {
            // ONLY delete from browsers map if THIS exact socket is still the registered active socket!
            if (browsers.get(clientDeviceId) === ws) {
                browsers.delete(clientDeviceId);
                console.log(`[WS] Android device disconnected: ${clientDeviceId}`);
                addLog(null, 'Android Uygulaması', clientDeviceId, 'Cihaz Ayrıldı', 'info', 'Cihaz bağlantıyı kapattı.');
            } else {
                console.log(`[WS] Stale closed socket cleaned up for device: ${clientDeviceId} (active socket preserved)`);
            }
        }
    });

    ws.on('error', (err) => {
        console.error(`[WS] Connection error for ${clientDeviceId || 'unknown'}:`, err);
    });
});

// Server-side keepalive ping every 15s to keep proxy connections active
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.readyState === 1) { // 1 = OPEN
            try {
                ws.ping();
            } catch (e) {}
        }
    });
}, 15000);

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

function extractBearerToken(req) {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    if (authHeader) {
        if (authHeader.toLowerCase().startsWith('bearer ')) {
            return authHeader.substring(7).trim();
        }
        return authHeader.trim();
    }
    return req.query.token || req.query.profileId || req.query.bearer || req.headers['x-mcp-token'] || req.headers['x-api-key'] || '';
}

app.get('/sse', (req, res) => {
    const reqToken = extractBearerToken(req);
    const reqClientName = req.query.clientName || req.query.name || req.query.agentName || '';

    let sessionId = req.query.sessionId;
    if (!sessionId) {
        if (reqToken) {
            const cleanToken = reqToken.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
            sessionId = `token_${cleanToken}`;
        } else if (reqClientName) {
            sessionId = `client_${reqClientName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
        } else {
            sessionId = `ai_session_${randomUUID().substring(0, 8)}`;
        }
    }
    
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

    sseSessions.set(sessionId, { res, clientInfo: { name: reqClientName || 'İstemci Doğrulanıyor' }, token: reqToken, clientName: reqClientName });
    console.log(`[MCP] SSE Session created: ${sessionId} (Client: ${reqClientName || 'N/A'}, Token: ${reqToken ? reqToken.substring(0, 10) + '...' : 'NONE'})`);
    addLog(sessionId, reqClientName || 'Bağlanıyor', null, 'SSE Bağlantısı', 'info', `İstemci SSE kanalı üzerinden bağlantı başlattı. Token: ${reqToken || 'Yok'}`);

    // Construct ABSOLUTE POST URL for MCP client to avoid relative path resolution bugs in clients like Cursor/Claude Desktop
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['host'] || 'localhost:10000';
    const postUrl = `${protocol}://${host}/message?sessionId=${sessionId}`;

    console.log(`[MCP] Sending SSE endpoint redirect URL: ${postUrl}`);
    res.write(`event: endpoint\ndata: ${postUrl}\n\n`);

    req.on('close', () => {
        clearInterval(heartbeatInterval);
        const session = sseSessions.get(sessionId);
        const clientName = session ? (session.clientName || (session.clientInfo ? session.clientInfo.name : 'N/A')) : 'N/A';
        sseSessions.delete(sessionId);
        console.log(`[MCP] SSE Session closed: ${sessionId}`);
        addLog(sessionId, clientName, null, 'Bağlantı Kesildi', 'info', 'SSE kanalı kapatıldı.');
    });
});

// Post endpoint for standard MCP client
app.post('/message', async (req, res) => {
    let { sessionId } = req.query;
    const reqToken = extractBearerToken(req);

    if (!sessionId && reqToken) {
        const cleanToken = reqToken.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
        sessionId = `token_${cleanToken}`;
    }

    const rpcRequest = req.body;

    console.log(`[MCP] Incoming JSON-RPC Request (Session: ${sessionId}, Token: ${reqToken || 'N/A'}):`, JSON.stringify(rpcRequest));

    if (!sessionId) {
        return res.status(400).json({ error: "Missing sessionId or Authorization token" });
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
                addLog(sessionId, session.clientName || session.clientInfo.name, null, 'Sistem Hazır', 'success', 'MCP Handshake başarıyla tamamlandı. İstemci hazır.');
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
            if (clientInfo.name && clientInfo.name !== 'Belirtilmeyen Yapay Zeka') {
                session.clientName = clientInfo.name;
            }
        }
        addLog(sessionId, clientInfo.name, null, 'Başlatma Handshake', 'success', `Yapay zeka asistanı bağlandı: ${clientInfo.name} (v${clientInfo.version || 'unknown'}).`);

        reply({
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: {
                tools: {} // We support tools
            },
            serverInfo: {
                name: "mcp-android-bridge",
                version: "1.1.0",
                description: "Android Real Browser MCP Bridge. To view full guide, parameters, and recommended agent workflows, call 'browser_get_tool_documentation'."
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

        // Direct handling for Documentation / Skill Guide Tool (Zero-latency server response)
        if (toolName === "browser_get_tool_documentation" || toolName === "get_tool_documentation" || toolName === "browser_get_skills" || toolName === "get_skills") {
            const toolDocResponse = generateDocumentationResponse(cleanArgs.tool_name || cleanArgs.name, cleanArgs.category);
            const session = sseSessions.get(sessionId);
            const clientName = (session && session.clientName) ? session.clientName : 'Yapay Zeka';
            addLog(sessionId, clientName, 'MCP Sunucusu', `Dokümantasyon Çağrısı: ${toolName}`, 'success', `Hedef Araç: ${cleanArgs.tool_name || 'all'} (Kategori: ${cleanArgs.category || 'all'})`);
            
            const content = [
                {
                    type: "text",
                    text: JSON.stringify(toolDocResponse, null, 2)
                }
            ];
            reply({ content });
            return res.status(200).send("accepted");
        }

        let actionType = "";
        switch (toolName) {
            case "browser_navigate": actionType = "navigate"; break;
            case "browser_search": actionType = "search"; break;
            case "browser_get_html": actionType = "get_html"; break;
            case "browser_get_local_markdown": actionType = "get_local_markdown"; break;
            case "browser_get_markdown": 
            case "browser_get_crawl4ai_markdown": actionType = "get_markdown"; break;
            case "browser_scroll": actionType = "scroll"; break;
            case "browser_click": actionType = "click"; break;
            case "browser_type": actionType = "type"; break;
            case "browser_toggle_overlay": actionType = "toggle_overlay"; break;
            case "browser_screenshot": actionType = "screenshot"; break;
            case "browser_execute_js": actionType = "execute_js"; break;
            case "browser_new_tab": actionType = "new_tab"; break;
            case "browser_close_tab": actionType = "close_tab"; break;
            case "browser_list_tabs": actionType = "list_tabs"; break;
            case "browser_switch_tab": actionType = "switch_tab"; break;
            case "browser_get_session_info": actionType = "get_session_info"; break;
            case "browser_list_sessions": actionType = "list_sessions"; break;
            case "browser_switch_session": actionType = "switch_session_mcp"; break;
            case "browser_clear_session_data": actionType = "clear_session_data"; break;
            default:
                reply(null, { code: -32601, message: `Tool not found: ${toolName}` });
                return res.status(200).send("accepted");
        }

        const session = sseSessions.get(sessionId);
        const clientName = (session && session.clientName) ? session.clientName : 
                           (session && session.clientInfo && session.clientInfo.name) ? session.clientInfo.name : 
                           req.query.clientName || 'Yapay Zeka';
        const token = (session && session.token) ? session.token : 
                      req.query.token || req.query.profileId || '';

        try {
            const { deviceId: resolvedDeviceId } = getBrowserWsForSession(sessionId, deviceId);
            addLog(sessionId, clientName, resolvedDeviceId || deviceId || 'Varsayılan Cihaz', `Araç Çağrısı: ${toolName}`, 'pending', `Komut gönderiliyor. Parametreler: ${JSON.stringify(cleanArgs)}`);
            let responseData = await routeCommandToBrowser(actionType, cleanArgs, deviceId, sessionId, clientName, token);
            responseData = await processCrawl4AIEngine(toolName, responseData, req.headers, sessionId, clientName, deviceId);

            let details = "Komut başarıyla yürütüldü.";
            if ((toolName === "browser_get_markdown" || toolName === "browser_get_crawl4ai_markdown" || toolName === "get_markdown") && responseData.markdown) {
                details = `[Motor: ${responseData.engine_used}] Crawl4AI Markdown verisi alındı (${responseData.markdown.length} karakter).`;
            } else if ((toolName === "browser_get_local_markdown" || toolName === "get_local_markdown") && responseData.markdown) {
                details = `[Motor: ${responseData.engine_used}] Yerel Markdown verisi alındı (${responseData.markdown.length} karakter).`;
            } else if ((toolName === "browser_get_html" || toolName === "get_html") && responseData.html) {
                details = `HTML kaynağı alındı (${responseData.html.length} karakter).`;
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

function extractMarkdownFromCrawlResponse(obj) {
    if (!obj) return null;
    
    if (typeof obj === 'string') {
        const trimmed = obj.trim();
        if (trimmed && trimmed !== "None" && !trimmed.startsWith('<!DOCTYPE') && !trimmed.startsWith('<html')) {
            return trimmed;
        }
        return null;
    }

    if (typeof obj !== 'object') return null;

    // 1. Direct priority keys
    const priorityKeys = ['fit_markdown', 'markdown', 'raw_markdown', 'citations_markdown', 'content_markdown'];
    for (const key of priorityKeys) {
        if (obj[key]) {
            const sub = extractMarkdownFromCrawlResponse(obj[key]);
            if (sub) return sub;
        }
    }

    // 2. Look inside 'results', 'result', 'data', 'items' arrays or objects
    const containers = ['results', 'result', 'data', 'items'];
    for (const containerKey of containers) {
        const val = obj[containerKey];
        if (Array.isArray(val) && val.length > 0) {
            for (const item of val) {
                const sub = extractMarkdownFromCrawlResponse(item);
                if (sub) return sub;
            }
        } else if (val && typeof val === 'object') {
            const sub = extractMarkdownFromCrawlResponse(val);
            if (sub) return sub;
        } else if (typeof val === 'string') {
            const sub = extractMarkdownFromCrawlResponse(val);
            if (sub) return sub;
        }
    }

    // 3. Look at generic string keys
    const textKeys = ['content', 'text', 'cleaned_html', 'md'];
    for (const key of textKeys) {
        if (obj[key]) {
            const sub = extractMarkdownFromCrawlResponse(obj[key]);
            if (sub) return sub;
        }
    }

    return null;
}

async function processCrawl4AIEngine(toolName, responseData, reqHeaders = {}, sessionId = null, clientName = null, deviceId = null) {
    if (!responseData) return responseData;

    // Capture initial fallback markdown from Android local JS engine
    const fallbackMarkdown = responseData.markdown || responseData.turndown_markdown || responseData.custom_markdown || "";

    // 1. LOCAL MARKDOWN TOOL (browser_get_local_markdown)
    if (toolName === "browser_get_local_markdown" || toolName === "get_local_markdown") {
        responseData.markdown = fallbackMarkdown;
        responseData.engine_used = "Built-in Turndown JS Engine (Local)";
        responseData.markdown_status = "SUCCESS (Built-in Turndown JS Engine)";

        delete responseData.turndown_markdown;
        delete responseData.custom_markdown;
        delete responseData.crawl4ai_markdown;
        delete responseData.fit_markdown;
        delete responseData.raw_markdown;
        delete responseData.html;
        delete responseData.raw_html;

        return responseData;
    }

    // 2. HTML TOOL (browser_get_html)
    if (toolName === "browser_get_html" || toolName === "get_html") {
        responseData.markdown = fallbackMarkdown;
        responseData.engine_used = "Built-in Turndown JS Engine (Local)";
        delete responseData.turndown_markdown;
        delete responseData.custom_markdown;
        delete responseData.crawl4ai_markdown;
        delete responseData.fit_markdown;
        delete responseData.raw_markdown;
        delete responseData.raw_html;

        return responseData;
    }

    // 3. CRAWL4AI MARKDOWN TOOL (browser_get_markdown / browser_get_crawl4ai_markdown)
    const isCrawlTool = (toolName === "browser_get_markdown" || toolName === "browser_get_crawl4ai_markdown" || toolName === "get_markdown");

    let crawlError = null;
    let convertedMarkdown = null;

    const targetUrl = (process.env.CRAWL4AI_API_URL || '').trim();

    if (isCrawlTool) {
        if (!targetUrl) {
            console.log(`[Crawl4AI] CRAWL4AI_API_URL is NOT configured in environment. Using local Turndown JS fallback engine.`);
        } else if (responseData.html || responseData.raw_html || responseData.url) {
            try {
                const fullRawHtml = responseData.raw_html || responseData.html || '';
                
                // Look for token across environment variables or incoming MCP headers
                const incomingAuth = reqHeaders ? (reqHeaders['authorization'] || reqHeaders['Authorization'] || reqHeaders['x-crawl4ai-token'] || reqHeaders['x-api-key']) : null;
                const rawToken = process.env.CRAWL4AI_API_TOKEN || process.env.CRAWL4AI_TOKEN || incomingAuth;
                
                let cleanToken = "";
                if (rawToken) {
                    cleanToken = String(rawToken).trim().replace(/^Bearer\s+/i, '');
                }

                const maskedToken = cleanToken ? `${cleanToken.substring(0, 4)}***` : 'NONE';
                console.log(`[Crawl4AI] Initiating Crawl4AI Engine Request:
  -> URL: ${targetUrl}
  -> Page HTML Length: ${fullRawHtml.length} chars
  -> Page URL: ${responseData.url || 'N/A'}
  -> Auth Token: ${maskedToken}`);

                addLog(sessionId, clientName, deviceId, 'Crawl4AI İsteği', 'info', `Crawl4AI sunucusuna (${targetUrl}) ${fullRawHtml.length} karakter HTML gönderiliyor... (Token: ${maskedToken})`);

                const crawlHeaders = { 
                    'Content-Type': 'application/json',
                    'Bypass-Tunnel-Reminder': 'true',
                    'User-Agent': 'MCP-Server/1.0'
                };

                if (cleanToken) {
                    crawlHeaders['Authorization'] = `Bearer ${cleanToken}`;
                    crawlHeaders['X-API-Key'] = cleanToken;
                }

                const pageUrl = (responseData.url && typeof responseData.url === 'string' && responseData.url.trim().length > 0)
                    ? responseData.url.trim()
                    : 'https://browser.page';

                const requestBody = {
                    urls: [pageUrl],
                    url: pageUrl,
                    html: fullRawHtml,
                    raw_html: fullRawHtml,
                    word_count_threshold: 10,
                    api_key: cleanToken,
                    token: cleanToken
                };

                const crawlRes = await fetch(targetUrl, {
                    method: 'POST',
                    headers: crawlHeaders,
                    signal: AbortSignal.timeout(20000), // 20 seconds timeout
                    body: JSON.stringify(requestBody)
                });

                console.log(`[Crawl4AI] HTTP Response Received: Status ${crawlRes.status} ${crawlRes.statusText}`);

                if (crawlRes.ok) {
                    const crawlJson = await crawlRes.json();
                    const authenticMarkdown = extractMarkdownFromCrawlResponse(crawlJson);
                    
                    if (authenticMarkdown && authenticMarkdown.length > 0) {
                        console.log(`[Crawl4AI] SUCCESS: Received official Crawl4AI markdown (${authenticMarkdown.length} chars)!`);
                        convertedMarkdown = authenticMarkdown;
                        responseData.engine_used = "Official Crawl4AI Python Engine";
                        responseData.markdown_status = "SUCCESS (Official Crawl4AI Python Engine)";
                        addLog(sessionId, clientName, deviceId, 'Crawl4AI Başarılı', 'success', `Official Crawl4AI Python Engine ile ${authenticMarkdown.length} karakter markdown üretildi.`);
                    } else {
                        const jsonSnippet = JSON.stringify(crawlJson).substring(0, 200);
                        console.warn(`[Crawl4AI] WARNING: Could not parse markdown from Crawl4AI response: ${jsonSnippet}`);
                        crawlError = `Crawl4AI response body format not recognized: ${jsonSnippet}`;
                        addLog(sessionId, clientName, deviceId, 'Crawl4AI Yanıt Format Hatası', 'error', `Yanıt 200 OK döndü ancak Markdown çıkarılamadı: ${jsonSnippet}`);
                    }
                } else {
                    const errText = await crawlRes.text().catch(() => '');
                    console.error(`[Crawl4AI] ERROR: Service returned HTTP ${crawlRes.status}: ${errText}`);
                    crawlError = `HTTP ${crawlRes.status}: ${errText}`;
                    addLog(sessionId, clientName, deviceId, 'Crawl4AI Hatası', 'error', `HTTP ${crawlRes.status} Hatası: ${errText}`);
                }
            } catch (c4err) {
                console.error(`[Crawl4AI] EXCEPTION during Crawl4AI request: ${c4err.message}`);
                crawlError = `Exception: ${c4err.message}`;
                addLog(sessionId, clientName, deviceId, 'Crawl4AI Bağlantı Hatası', 'error', `İstek başarısız: ${c4err.message}`);
            }
        }
    }

    // Set single primary markdown field & status information
    if (convertedMarkdown) {
        responseData.markdown = convertedMarkdown;
    } else {
        if (isCrawlTool) {
            /* 
            // YEDEK/FALLBACK MEKANİZMASI (Pasife alındı)
            responseData.markdown = fallbackMarkdown;
            responseData.engine_used = "Built-in Turndown JS Engine (Local Fallback)";
            if (crawlError) {
                responseData.markdown_status = `FALLBACK: Built-in Turndown JS Engine (Crawl4AI Error: ${crawlError})`;
            } else if (!targetUrl) {
                responseData.markdown_status = "FALLBACK: Built-in Turndown JS Engine (CRAWL4AI_API_URL not set in Render environment)";
            } else {
                responseData.markdown_status = "FALLBACK: Built-in Turndown JS Engine (Crawl4AI returned empty response)";
            }
            */
            responseData.markdown = `Crawl4AI bağlantı başarısız oldu veya dönüşüm yapılamadı.\n\nHata detayı: ${crawlError || 'CRAWL4AI_API_URL eksik veya geçersiz.'}\n\nLütfen yerel çevirimi kullanmak için 'browser_get_local_markdown' aracını çağırın.`;
            responseData.engine_used = "Crawl4AI Python Engine (FAILED)";
            responseData.markdown_status = "FAILED";
        } else {
            responseData.markdown = fallbackMarkdown;
        }
    }

    // CLEANUP: Remove duplicate and redundant fields to avoid confusion for AI client
    delete responseData.turndown_markdown;
    delete responseData.custom_markdown;
    delete responseData.crawl4ai_markdown;
    delete responseData.fit_markdown;
    delete responseData.raw_markdown;
    delete responseData.raw_html;

    if (isCrawlTool) {
        delete responseData.html;
    }

    return responseData;
}

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
        let responseData = await routeCommandToBrowser(type, cleanArgs, deviceId);
        responseData = await processCrawl4AIEngine(type, responseData, req.headers, null, 'REST API', deviceId);
        addLog(null, 'REST Fallback API', deviceId || 'Varsayılan Cihaz', `Direct API Başarılı: ${type}`, 'success', `Yanıt boyutu: ${JSON.stringify(responseData).length} karakter. Motor: ${responseData.engine_used || 'varsayılan'}`);
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
    
    { path: '/mcp/tools/browser_get_local_markdown', type: 'get_local_markdown' },
    { path: '/tools/browser_get_local_markdown', type: 'get_local_markdown' },
    
    { path: '/mcp/tools/browser_get_markdown', type: 'get_markdown' },
    { path: '/tools/browser_get_markdown', type: 'get_markdown' },
    { path: '/mcp/tools/browser_get_crawl4ai_markdown', type: 'get_markdown' },
    { path: '/tools/browser_get_crawl4ai_markdown', type: 'get_markdown' },
    
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

// REST Documentation / Skills Endpoint
app.all(['/mcp/tools/browser_get_tool_documentation', '/tools/browser_get_tool_documentation', '/api/docs', '/api/skills'], (req, res) => {
    const args = req.method === 'POST' ? req.body : req.query;
    const toolDocResponse = generateDocumentationResponse(args.tool_name || args.name, args.category);
    return res.json(toolDocResponse);
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

// OAuth 2.0 & Claude Web Connector Auto-Registration Support
app.get(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/.well-known/mcp-configuration'], (req, res) => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['host'] || 'mcp-browser-1.onrender.com';
    const baseUrl = `${protocol}://${host}`;

    res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256", "plain"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"]
    });
});

app.post(['/oauth/register', '/register'], (req, res) => {
    res.json({
        client_id: "mcp_auto_client_id",
        client_secret: "mcp_auto_client_secret",
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        redirect_uris: req.body?.redirect_uris || ["https://claude.ai/oauth/callback"]
    });
});

app.get(['/oauth/authorize', '/authorize'], (req, res) => {
    const redirectUri = req.query.redirect_uri || req.query.redirect_url || 'https://claude.ai/oauth/callback';
    const state = req.query.state || '';
    const code = 'mcp_auto_code_' + randomUUID().substring(0, 8);
    
    const targetUrl = new URL(redirectUri);
    targetUrl.searchParams.set('code', code);
    if (state) targetUrl.searchParams.set('state', state);

    console.log(`[OAuth] Auto-approving OAuth authorize request for Claude Web -> Redirecting to ${targetUrl.toString()}`);
    return res.redirect(targetUrl.toString());
});

app.post(['/oauth/token', '/token'], (req, res) => {
    res.json({
        access_token: "mcp_auto_access_token",
        token_type: "Bearer",
        expires_in: 31536000,
        scope: "mcp"
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
