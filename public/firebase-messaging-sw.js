importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyCaF27qAZr06JUfVfMzuMtzstv8dD4G3cI",
    authDomain: "pulse-chat-e74e4.firebaseapp.com",
    projectId: "pulse-chat-e74e4",
    storageBucket: "pulse-chat-e74e4.firebasestorage.app",
    messagingSenderId: "861770164749",
    appId: "1:861770164749:web:58f3342896bf6e27dd4344"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};
    const isCall = data.type === 'call';

    self.registration.showNotification(
        payload.notification?.title || 'Pulse',
        {
            body: payload.notification?.body || '',
            icon: '/favicon.ico',
            tag: isCall ? 'incoming-call' : 'message-' + Date.now(),
            renotify: true,
            requireInteraction: isCall,
            vibrate: isCall ? [500, 300, 500, 300, 500] : [200],
            data: data,
            actions: isCall
                ? [{ action: 'accept', title: '✅ Accept' }, { action: 'reject', title: '❌ Reject' }]
                : [{ action: 'open', title: '💬 Open' }]
        }
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const data = event.notification.data || {};
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            if (event.action === 'reject') {
                // Pass callPeer so frontend can send call_reject to the correct user
                clients.forEach(c => c.postMessage({ type: 'REJECT_CALL', callPeer: data.user || '' }));
                return;
            }
            const app = clients.find(c => c.url.includes(self.location.origin));
            if (app) { app.focus(); app.postMessage({ type: 'NOTIFICATION_CLICK', data: data }); }
            else self.clients.openWindow('/');
        })
    );
});