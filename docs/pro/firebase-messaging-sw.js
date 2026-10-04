/**
 * Firebase Cloud Messaging Service Worker
 * ======================================
 * Handles background push notifications and click events.
 * 
 * This service worker must be registered by your main app with:
 *   navigator.serviceWorkerContainer.register('/pro/firebase-messaging-sw.js', {
 *     scope: '/pro/'
 *   });
 */

// Import Firebase scripts (compatibility version for service workers)
importScripts('/assets/vendor/firebase/12.19.0/firebase-app-compat.js');
importScripts('/assets/vendor/firebase/12.19.0/firebase-messaging-compat.js');

// Firebase Configuration (same as in main app)
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  projectId: "nobigdeal-pro",
  storageBucket: "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId: "1:717435841570:web:c2338e11052c96fde02e7b"
};

// Initialize Firebase in the service worker
firebase.initializeApp(FIREBASE_CONFIG);

// Get the messaging instance
const messaging = firebase.messaging();

/**
 * Handle background messages when the app is closed or in the background
 * Customize notification display and appearance
 */
messaging.onBackgroundMessage((payload) => {
  console.log('[FCM-SW] Background message received:', payload);
  
  const { notification, data } = payload;
  const title = notification?.title || 'NBD Pro';
  const body = notification?.body || 'New notification';
  
  // Default notification options
  const notificationOptions = {
    body: body,
    // Audit #22: prior path /pro/images/icon-192x192.png 404'd — real icons
    // live under /pro/img/ with a different naming scheme. A missing icon
    // causes the OS to render a blank/generic bell on Android/iOS PWA.
    icon: '/pro/img/nbd-icon-192.png',
    badge: '/pro/img/nbd-icon-192.png',
    tag: data?.notificationId || 'nbd-notification',
    requireInteraction: data?.requireInteraction === 'true' || false,
    actions: getNotificationActions(data?.type),
    data: {
      ...data,
      clickUrl: getClickUrl(data),
      type: data?.type || 'default'
    },
    dir: 'auto'
  };
  
  // Different styles based on notification type
  switch (data?.type) {
    case 'newLead':
      notificationOptions.tag = 'new-lead';
      break;
    case 'appointmentReminder':
      notificationOptions.tag = 'appointment-reminder';
      notificationOptions.requireInteraction = true;
      break;
    case 'followUpDue':
      notificationOptions.tag = 'follow-up-due';
      break;
    case 'yardSignPickup':
      // Stays until tapped — the homeowner only texts if Jo is late.
      notificationOptions.tag = 'yard-sign-pickup';
      notificationOptions.requireInteraction = true;
      break;
    case 'claimUpdate':
      notificationOptions.tag = 'claim-update';
      break;
    case 'teamActivity':
      notificationOptions.tag = 'team-activity';
      break;
    case 'd2dStreak':
      notificationOptions.tag = 'd2d-streak';
      break;
  }
  
  // Show the notification
  self.registration.showNotification(title, notificationOptions);
});

/**
 * Decide what a click means. PURE — no clients, no network, no event — so
 * tests/push-notification-actions.test.js can drive every branch without a
 * service-worker runtime.
 *
 * @param {string} action  event.action ('' when the body itself was tapped)
 * @param {object} data    event.notification.data
 * @returns {{kind:'close'|'call'|'snooze'|'navigate', url?:string, phone?:string, leadId?:string}}
 */
function resolveNotificationAction(action, data) {
  const d = data || {};
  const url = d.clickUrl || '/pro/dashboard.html';
  switch (action) {
    case 'dismiss':
      // Closing already happened; doing anything else here is the bug this
      // whole switch exists to fix — before it, "Dismiss" navigated.
      return { kind: 'close' };
    case 'call': {
      const digits = String(d.phone || '').replace(/[^\d+]/g, '');
      // No number on the payload is not a reason to do nothing — fall back to
      // opening the lead so the rep can still act.
      return digits ? { kind: 'call', phone: digits, url } : { kind: 'navigate', url };
    }
    case 'snooze':
      return { kind: 'snooze', leadId: String(d.leadId || ''), url };
    default:
      return { kind: 'navigate', url };
  }
}

/**
 * Handle notification clicks.
 *
 * TWO BUGS FIXED HERE (2026-09-05):
 *
 * 1. This handler never looked at `event.action`, so the "Dismiss" button
 *    that getNotificationActions has always declared navigated exactly like
 *    tapping the notification body.
 *
 * 2. It called `client.navigate(clickUrl)`. This service worker is registered
 *    at scope '/pro/firebase-cloud-messaging-push-scope' — deliberately NOT
 *    '/pro/', which sw.js owns (push-registration.js:11,46). A worker can only
 *    navigate clients its own registration controls, so that call ALWAYS
 *    rejected: with the app already open, clicking a push did nothing at all,
 *    and the rejection died silently inside waitUntil.
 *
 * The fix is to ask the page to route itself (postMessage, handled by
 * docs/pro/js/push-actions.js) and to fall back to openWindow when no page is
 * open. openWindow is cross-scope-safe.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = (event.notification && event.notification.data) || {};
  const plan = resolveNotificationAction(event.action || '', data);

  console.log('[FCM-SW] Notification clicked:', data.type, event.action || '(body)', plan.kind);

  if (plan.kind === 'close') return;

  event.waitUntil((async () => {
    // A tel: link cannot be handed to an existing tab — it must be opened.
    if (plan.kind === 'call') {
      try {
        const w = await clients.openWindow('tel:' + plan.phone);
        if (w) return w;
      } catch (e) { /* fall through to the lead */ }
      return clients.openWindow(plan.url);
    }

    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windowClients.find((c) => c.url.indexOf('/pro/') !== -1);

    if (open) {
      try { await open.focus(); } catch (e) { /* focus can reject; keep going */ }
      // The page owns navigation and any Firestore write: this worker holds no
      // auth session, so a snooze cannot be performed here.
      open.postMessage({
        type: 'NBD_PUSH_ACTION',
        action: plan.kind,
        url: plan.url,
        leadId: plan.leadId || '',
      });
      return open;
    }

    // Nothing open: carry the intent in the URL so the page can finish it.
    const url = plan.kind === 'snooze'
      ? plan.url + (plan.url.indexOf('?') === -1 ? '?' : '&') + 'pushAction=snooze'
      : plan.url;
    return clients.openWindow(url);
  })());
});

/**
 * Get the URL to navigate to based on notification type and data
 */
function getClickUrl(data = {}) {
  const baseUrl = '/pro/';
  
  switch (data.type) {
    case 'newLead':
      return `${baseUrl}dashboard.html?tab=leads&leadId=${data.leadId || ''}`;
    
    case 'appointmentReminder':
      return `${baseUrl}dashboard.html?tab=calendar&appointmentId=${data.appointmentId || ''}`;
    
    case 'followUpDue':
      return `${baseUrl}dashboard.html?tab=d2d&followUpId=${data.followUpId || ''}`;
    
    case 'claimUpdate':
      return `${baseUrl}customer.html?leadId=${data.leadId || ''}`;
    
    case 'teamActivity':
      return `${baseUrl}dashboard.html?tab=team`;
    
    case 'd2dStreak':
      return `${baseUrl}dashboard.html?tab=d2d`;

    case 'yardSignPickup':
      return `${baseUrl}dashboard.html#/signs`;
    
    default:
      return `${baseUrl}dashboard.html`;
  }
}

/**
 * Get action buttons for notification based on type
 */
// Kept byte-identical to the server's copy in functions/push-functions.js —
// a background-rendered notification and an FCM-rendered one must offer the
// same buttons, or the same push shows different actions depending on whether
// the browser or this worker drew it. push-notification-actions.test.js
// compares the two lists.
function getNotificationActions(type) {
  switch (type) {
    case 'newLead':
      // A roofer's first move on a new lead is to phone them. Two taps from
      // the lock screen instead of six.
      return [
        { action: 'call', title: 'Call' },
        { action: 'view', title: 'Open' },
        { action: 'snooze', title: 'Snooze 1h' }
      ];

    case 'appointmentReminder':
    case 'followUpDue':
      return [
        { action: 'view', title: 'View' },
        { action: 'snooze', title: 'Snooze 1h' },
        { action: 'dismiss', title: 'Dismiss' }
      ];

    default:
      return [{ action: 'view', title: 'View' }];
  }
}

/**
 * Service Worker Install Event
 */
self.addEventListener('install', (event) => {
  console.log('[FCM-SW] Service Worker installing...');
  self.skipWaiting();
});

/**
 * Service Worker Activate Event
 */
self.addEventListener('activate', (event) => {
  console.log('[FCM-SW] Service Worker activating...');
  event.waitUntil(clients.claim());
});
