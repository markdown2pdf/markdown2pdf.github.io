const DB_NAME = 'texlive-cache-db-v2';
const STORE_NAME = 'assets';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            
            request.onsuccess = (event) => resolve(event.target.result);
            request.onerror = (event) => {
                dbPromise = null;
                reject(event.target.error);
            }
        });
    }
    return dbPromise;
}

async function getFromDB(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(key);
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function putToDB(key, data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(data, key);
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Parse endpoint from SW registration URL params
const targetEndpointUrl = new URL(location.href);
const TEXLIVE_TARGET_HOSTNAME = targetEndpointUrl.searchParams.get('endpoint')

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Firefox specific: bugs with certain cache modes during reload
    if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
    
    if (event.request.method !== 'GET') return; // Only cache GET requests
    
    const url = new URL(event.request.url);
    const isTexlive = url.pathname.includes("/pdftex/");
    const isWasm = url.pathname.endsWith('.wasm');
    
    if (isTexlive || isWasm) {
        event.respondWith((async () => {
            // Strip out search queries to prevent cache busting on reload
            const cacheKey = url.origin + url.pathname;
            
            // 1. Check IndexedDB using the normalized cache key
            try {
                const cachedData = await getFromDB(cacheKey);
                
                if (cachedData && cachedData.blob) {
                    const headers = new Headers();
                    headers.set('Content-Type', isWasm ? 'application/wasm' : 'application/octet-stream');
                    
                    if (cachedData.headers) {
                        for (const [key, value] of Object.entries(cachedData.headers)) {
                            headers.set(key, value);
                        }
                    }
                    
                    if (isTexlive) {
                        headers.set('Access-Control-Expose-Headers', 'fileid, pkid, content-length, content-type');
                    }
                    
                    // Reconstruct directly from the extremely fast Blob
                    return new Response(cachedData.blob, {
                        status: 200,
                        statusText: 'OK',
                        headers: headers
                    });
                }
            } catch (err) {
                console.warn("DB read error:", err);
            }
            
            try {
                // 2. Fetch cleanly from network
                let fetchReq;
                if (isTexlive) {
                    fetchReq = new Request(event.request.url, {
                        method: 'GET',
                        mode: 'cors',
                        credentials: 'omit'
                    });
                } else {
                    fetchReq = event.request;
                }
                
                const response = await fetch(fetchReq);
                
                if (response.ok && response.status === 200) {
                    // 3. Fully buffer into a Blob (most efficient for IDB storage across browsers)
                    const blob = await response.blob();
                    
                    const headersObj = {};
                    const responseHeaders = new Headers();
                    response.headers.forEach((value, key) => {
                        responseHeaders.set(key, value);
                        headersObj[key] = value;
                    });
                    
                    if (isTexlive) {
                        responseHeaders.set('Access-Control-Expose-Headers', 'fileid, pkid, content-length, content-type');
                    }
                    
                    // Queue save in waitUntil so Firefox doesn't aggressively cancel the IDB worker task
                    const savePromise = putToDB(cacheKey, {
                        blob: blob,
                        headers: headersObj
                    }).catch(err => console.error("IDB write error:", err));
                    
                    event.waitUntil(savePromise);
                    
                    // 4. Return new synthetic response constructed directly from the Blob
                    return new Response(blob, {
                        status: 200,
                        statusText: 'OK',
                        headers: responseHeaders
                    });
                }
                
                return response;
            } catch (err) {
                console.error("SW fetch error:", err);
                throw err;
            }
        })());
    }
});
