"use strict";

/* =========================================================
   ブラウザー通知を押したとき、予定管理の画面へ戻すだけの軽い処理です。
   ページや画像のキャッシュ処理は行いません。
   ========================================================= */
function getSafeTargetUrl(requestedUrl) {
    const scopeUrl = new URL(self.registration.scope);
    try {
        const targetUrl = new URL(
            typeof requestedUrl === "string" ? requestedUrl : scopeUrl.href,
            scopeUrl
        );
        if (targetUrl.origin === scopeUrl.origin && targetUrl.href.startsWith(scopeUrl.href)) {
            return targetUrl.href;
        }
    } catch (error) {
        // 壊れたURLや別サイトのURLは使わず、このアプリの先頭へ戻します。
    }
    return scopeUrl.href;
}

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const requestedUrl = event.notification.data && event.notification.data.url;
    const targetUrl = getSafeTargetUrl(requestedUrl);
    const scopeUrl = self.registration.scope;

    event.waitUntil(self.clients.matchAll({
        type: "window",
        includeUncontrolled: true
    }).then((clientList) => {
        const openClient = clientList.find((client) => client.url === targetUrl)
            || clientList.find((client) => client.url.startsWith(scopeUrl));
        if (openClient && typeof openClient.focus === "function") {
            if (openClient.url !== targetUrl && typeof openClient.navigate === "function") {
                return openClient.navigate(targetUrl)
                    .then((navigatedClient) => (navigatedClient || openClient).focus())
                    .catch(() => self.clients.openWindow(targetUrl));
            }
            return openClient.focus()
                .catch(() => self.clients.openWindow(targetUrl));
        }
        return self.clients.openWindow(targetUrl);
    }));
});
