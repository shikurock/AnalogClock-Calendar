(function () {
    "use strict";

    /* =======================================================
       1. アプリで使う設定と、画面の部品をまとめる場所
       ======================================================= */
    const STORAGE_KEY = "tokeibe.schedules.v1";
    const DISMISSED_ALERTS_KEY = "tokeibe.dismissed-alerts.v1";
    const NOTIFICATION_HISTORY_KEY = "tokeibe.notification-history.v1";
    const THEME_STORAGE_KEY = "tokeibe.theme.v1";
    const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
    const FADE_DURATION = 180;
    const NOTIFICATION_GRACE_MS = 5 * 60 * 1000;
    const NOTIFICATION_HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const SERVICE_WORKER_READY_TIMEOUT_MS = 3000;
    const REMINDER_MINUTE_OPTIONS = Object.freeze([0, 1, 5, 10, 15, 30, 60, 1440]);
    const GOOGLE_IDENTITY_SCRIPT = "https://accounts.google.com/gsi/client";
    const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
    const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
    const GOOGLE_TIME_ZONE = "Asia/Tokyo";

    /*
       Google Cloudで発行した「ウェブ アプリ用のクライアントID」を、下の空文字の中へ貼ります。
       例：123456789012-abcdef.apps.googleusercontent.com
       クライアントシークレットは秘密情報なので、このファイルやHTMLへ絶対に書きません。
    */
    const GOOGLE_CLIENT_ID = "";
    const LONG_DATE_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "short"
    });
    const MONTH_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "long"
    });
    const GOOGLE_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
        timeZone: GOOGLE_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    });

    const elements = {
        calendarMonthLabel: document.getElementById("calendarMonthLabel"),
        calendarGrid: document.getElementById("calendarGrid"),
        previousMonthButton: document.getElementById("previousMonthButton"),
        nextMonthButton: document.getElementById("nextMonthButton"),
        todayButton: document.getElementById("todayButton"),
        selectedDateLabel: document.getElementById("selectedDateLabel"),
        hourButtons: document.getElementById("hourButtons"),
        hourHand: document.getElementById("hourHand"),
        minuteHand: document.getElementById("minuteHand"),
        scheduleArcs: document.getElementById("scheduleArcs"),
        clockFace: document.getElementById("clockFace"),
        centralAddButton: document.getElementById("centralAddButton"),
        hourPopover: document.getElementById("hourPopover"),
        hourPopoverTitle: document.getElementById("hourPopoverTitle"),
        amButton: document.getElementById("amButton"),
        pmButton: document.getElementById("pmButton"),
        popoverAddButton: document.getElementById("popoverAddButton"),
        scheduleAlert: document.getElementById("scheduleAlert"),
        scheduleAlertTitle: document.getElementById("scheduleAlertTitle"),
        scheduleAlertDetail: document.getElementById("scheduleAlertDetail"),
        scheduleAlertClose: document.getElementById("scheduleAlertClose"),
        reminderAlert: document.getElementById("reminderAlert"),
        reminderAlertTitle: document.getElementById("reminderAlertTitle"),
        reminderAlertDetail: document.getElementById("reminderAlertDetail"),
        reminderAlertClose: document.getElementById("reminderAlertClose"),
        todayScheduleCount: document.getElementById("todayScheduleCount"),
        todayScheduleList: document.getElementById("todayScheduleList"),
        scheduleModal: document.getElementById("scheduleModal"),
        scheduleForm: document.getElementById("scheduleForm"),
        scheduleDate: document.getElementById("scheduleDate"),
        scheduleTitle: document.getElementById("scheduleTitle"),
        scheduleStart: document.getElementById("scheduleStart"),
        scheduleEnd: document.getElementById("scheduleEnd"),
        scheduleReminder: document.getElementById("scheduleReminder"),
        formError: document.getElementById("formError"),
        modalCloseButton: document.getElementById("modalCloseButton"),
        formCancelButton: document.getElementById("formCancelButton"),
        scheduleImportant: document.getElementById("scheduleImportant"),
        googleAddChoice: document.getElementById("googleAddChoice"),
        addToGoogleCalendar: document.getElementById("addToGoogleCalendar"),
        themeToggle: document.getElementById("themeToggle"),
        themeToggleIcon: document.getElementById("themeToggleIcon"),
        themeToggleText: document.getElementById("themeToggleText"),
        notificationPermissionPanel: document.getElementById("notificationPermissionPanel"),
        notificationPermissionStatus: document.getElementById("notificationPermissionStatus"),
        notificationPermissionButton: document.getElementById("notificationPermissionButton"),
        googleConnectButton: document.getElementById("googleConnectButton"),
        googleImportButton: document.getElementById("googleImportButton"),
        googleDisconnectButton: document.getElementById("googleDisconnectButton"),
        googleConnectionBadge: document.getElementById("googleConnectionBadge"),
        googleCalendarStatus: document.getElementById("googleCalendarStatus"),
        liveStatus: document.getElementById("liveStatus")
    };

    const firstNow = new Date();
    let viewingMonth = new Date(firstNow.getFullYear(), firstNow.getMonth(), 1);
    let selectedDate = startOfDay(firstNow);
    let selectedHour = 12;
    let selectedPeriod = firstNow.getHours() < 12 ? "am" : "pm";
    let schedules = loadSchedules();
    let scheduleIndex = buildScheduleIndex(schedules);
    let lastKnownTodayKey = toDateKey(firstNow);
    let previousFocus = null;
    let activeHourButton = null;
    let popoverHideTimer = null;
    let modalHideTimer = null;
    let alertHideTimer = null;
    let reminderAlertHideTimer = null;
    let currentAlertKey = "";
    let currentAlertDateKey = "";
    let currentAlertSchedules = [];
    let currentReminderAlertKey = "";
    let currentReminderDismissalKeys = [];
    let tickTimer = null;
    let notificationServiceWorkerPromise = null;
    let googleScriptPromise = null;
    let googleTokenClient = null;
    let googleAccessToken = "";
    let googleTokenExpiresAt = 0;
    let googleImportController = null;
    const dismissedAlertKeys = loadDismissedAlerts();
    const notificationHistory = loadNotificationHistory();
    const pendingNotificationKeys = new Set();
    const failedNotificationKeys = new Set();

    /* =======================================================
       2. 日付と時刻を安全に扱う、小さな道具
       ======================================================= */
    function padNumber(value) {
        return String(value).padStart(2, "0");
    }

    function startOfDay(date) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }

    // toISOString()は日付がずれることがあるため、端末の年月日をそのまま使います。
    function toDateKey(date) {
        return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
    }

    function parseDateKey(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (!match) {
            return null;
        }

        const year = Number(match[1]);
        const month = Number(match[2]) - 1;
        const day = Number(match[3]);
        const date = new Date(year, month, day);

        if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
            return null;
        }

        return date;
    }

    function isTimeString(value) {
        if (!/^\d{2}:\d{2}$/.test(value)) {
            return false;
        }

        const [hours, minutes] = value.split(":").map(Number);
        return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
    }

    function timeToMinutes(value) {
        const [hours, minutes] = value.split(":").map(Number);
        return (hours * 60) + minutes;
    }

    function minutesToTime(value) {
        const safeValue = Math.max(0, Math.min(1439, value));
        return `${padNumber(Math.floor(safeValue / 60))}:${padNumber(safeValue % 60)}`;
    }

    function normalizeReminderMinutes(value) {
        const reminderMinutes = Number(value);
        return REMINDER_MINUTE_OPTIONS.includes(reminderMinutes) ? reminderMinutes : 0;
    }

    function formatReminderLabel(reminderMinutes) {
        const safeMinutes = normalizeReminderMinutes(reminderMinutes);
        if (safeMinutes === 1440) {
            return "1日前に通知";
        }
        if (safeMinutes === 60) {
            return "1時間前に通知";
        }
        return safeMinutes > 0 ? `${safeMinutes}分前に通知` : "通知なし";
    }

    function makeScheduleStartDate(schedule) {
        const date = parseDateKey(schedule.date);
        if (!date || !isTimeString(schedule.start)) {
            return null;
        }

        const startMinutes = timeToMinutes(schedule.start);
        return new Date(
            date.getFullYear(),
            date.getMonth(),
            date.getDate(),
            Math.floor(startMinutes / 60),
            startMinutes % 60,
            0,
            0
        );
    }

    function makeReminderDate(schedule) {
        const startDate = makeScheduleStartDate(schedule);
        const reminderMinutes = normalizeReminderMinutes(schedule.reminderMinutes);
        if (!startDate || reminderMinutes === 0) {
            return null;
        }
        return new Date(startDate.getTime() - (reminderMinutes * 60 * 1000));
    }

    function isNotificationTime(now, targetDate) {
        if (!targetDate) {
            return false;
        }
        const elapsed = now.getTime() - targetDate.getTime();
        return elapsed >= 0 && elapsed < NOTIFICATION_GRACE_MS;
    }

    /* 追加する前に過ぎていた時刻を、あとから新しい通知として出さないための確認です。 */
    function wasNotificationTimeAfterCreation(schedule, targetDate) {
        if (!targetDate || typeof schedule.createdAt !== "string") {
            return true;
        }

        const createdAt = new Date(schedule.createdAt);
        /* 入力は分単位なので、同じ1分の途中で追加した場合だけは「今の通知」として扱います。 */
        return Number.isNaN(createdAt.getTime())
            || (targetDate.getTime() + 60000) > createdAt.getTime();
    }

    /* 最大1日前のリマインドと5分の遅れだけを見るため、近い3日分に絞って軽く確認します。 */
    function getNotificationCandidateSchedules(now) {
        const today = startOfDay(now);
        const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
        const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
        return [yesterday, today, tomorrow].flatMap((date) => schedulesForDate(date));
    }

    function formatLongDate(date) {
        return LONG_DATE_FORMATTER.format(date);
    }

    function formatMonth(date) {
        return MONTH_FORMATTER.format(date);
    }

    function makeScheduleId() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return window.crypto.randomUUID();
        }

        return `schedule-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function schedulesForDate(date) {
        const targetKey = typeof date === "string" ? date : toDateKey(date);
        return scheduleIndex.get(targetKey) || [];
    }

    function buildScheduleIndex(scheduleList) {
        const index = new Map();
        scheduleList.forEach((schedule) => {
            if (!index.has(schedule.date)) {
                index.set(schedule.date, []);
            }
            index.get(schedule.date).push(schedule);
        });
        index.forEach((items) => {
            items.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
        });
        return index;
    }

    function rebuildScheduleIndex() {
        scheduleIndex = buildScheduleIndex(schedules);
    }

    /* =======================================================
       3. 予定の保存と読み込み
       ======================================================= */
    function isValidStoredSchedule(item) {
        return item
            && typeof item.id === "string"
            && item.id.trim().length > 0
            && parseDateKey(item.date)
            && typeof item.title === "string"
            && item.title.trim().length > 0
            && isTimeString(item.start)
            && isTimeString(item.end)
            && (typeof item.important === "undefined" || typeof item.important === "boolean")
            && (
                typeof item.reminderMinutes === "undefined"
                || (typeof item.reminderMinutes === "number"
                    && REMINDER_MINUTE_OPTIONS.includes(item.reminderMinutes))
            )
            && (typeof item.source === "undefined" || item.source === "local" || item.source === "google")
            && timeToMinutes(item.end) > timeToMinutes(item.start);
    }

    function normalizeStoredSchedule(item) {
        return {
            ...item,
            important: item.important === true,
            reminderMinutes: normalizeReminderMinutes(item.reminderMinutes),
            source: item.source === "google" ? "google" : "local",
            googleCalendarId: typeof item.googleCalendarId === "string" ? item.googleCalendarId : "",
            googleEventId: typeof item.googleEventId === "string" ? item.googleEventId : "",
            googleHtmlLink: typeof item.googleHtmlLink === "string" ? item.googleHtmlLink : ""
        };
    }

    function loadSchedules() {
        try {
            const savedValue = window.localStorage.getItem(STORAGE_KEY);
            if (!savedValue) {
                return [];
            }

            const parsedValue = JSON.parse(savedValue);
            if (!Array.isArray(parsedValue)) {
                return [];
            }

            const seenIds = new Set();
            return parsedValue.filter((item) => {
                if (!isValidStoredSchedule(item) || seenIds.has(item.id)) {
                    return false;
                }

                seenIds.add(item.id);
                return true;
            }).map(normalizeStoredSchedule);
        } catch (error) {
            console.warn("保存済みの予定を読み込めませんでした。", error);
            return [];
        }
    }

    function saveSchedules() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
            return true;
        } catch (error) {
            console.warn("予定を端末に保存できませんでした。", error);
            return false;
        }
    }

    function loadDismissedAlerts() {
        try {
            const savedValue = window.sessionStorage.getItem(DISMISSED_ALERTS_KEY);
            const parsedValue = savedValue ? JSON.parse(savedValue) : [];
            return new Set(Array.isArray(parsedValue) ? parsedValue : []);
        } catch (error) {
            return new Set();
        }
    }

    function saveDismissedAlerts() {
        try {
            window.sessionStorage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify([...dismissedAlertKeys]));
        } catch (error) {
            // 一時的なお知らせなので、保存できなくても予定そのものには影響しません。
        }
    }

    /* ブラウザー通知を二重に出さないため、直近7日分だけ通知済み記録を残します。 */
    function loadNotificationHistory() {
        try {
            const savedValue = window.localStorage.getItem(NOTIFICATION_HISTORY_KEY);
            const parsedValue = savedValue ? JSON.parse(savedValue) : {};
            const oldestAllowed = Date.now() - NOTIFICATION_HISTORY_MAX_AGE_MS;
            const entries = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
                ? Object.entries(parsedValue)
                : [];
            return new Map(entries.filter(([key, sentAt]) => (
                typeof key === "string"
                && typeof sentAt === "number"
                && Number.isFinite(sentAt)
                && sentAt >= oldestAllowed
            )));
        } catch (error) {
            return new Map();
        }
    }

    function saveNotificationHistory() {
        try {
            const oldestAllowed = Date.now() - NOTIFICATION_HISTORY_MAX_AGE_MS;
            notificationHistory.forEach((sentAt, key) => {
                if (sentAt < oldestAllowed) {
                    notificationHistory.delete(key);
                }
            });
            window.localStorage.setItem(
                NOTIFICATION_HISTORY_KEY,
                JSON.stringify(Object.fromEntries(notificationHistory))
            );
        } catch (error) {
            // 通知履歴を保存できない場合も、予定と画面内のお知らせはそのまま使えます。
        }
    }

    function syncNotificationHistory() {
        const latestHistory = loadNotificationHistory();
        notificationHistory.clear();
        latestHistory.forEach((sentAt, key) => notificationHistory.set(key, sentAt));
    }

    function markBrowserNotificationSent(notificationKey) {
        notificationHistory.set(notificationKey, Date.now());
        saveNotificationHistory();
    }

    function removeNotificationHistoryForSchedule(scheduleId) {
        syncNotificationHistory();
        const keyEnding = `:${scheduleId}`;
        let changed = false;
        notificationHistory.forEach((sentAt, key) => {
            if (key.endsWith(keyEnding)) {
                notificationHistory.delete(key);
                changed = true;
            }
        });
        pendingNotificationKeys.forEach((key) => {
            if (key.endsWith(keyEnding)) {
                pendingNotificationKeys.delete(key);
            }
        });
        failedNotificationKeys.forEach((key) => {
            if (key.endsWith(keyEnding)) {
                failedNotificationKeys.delete(key);
            }
        });
        if (changed) {
            saveNotificationHistory();
        }
    }

    function removeDismissedAlertsForSchedule(scheduleId) {
        const keyEnding = `:${scheduleId}`;
        let changed = false;
        dismissedAlertKeys.forEach((key) => {
            if (key.endsWith(keyEnding)) {
                dismissedAlertKeys.delete(key);
                changed = true;
            }
        });
        if (changed) {
            saveDismissedAlerts();
        }
    }

    /* =======================================================
       4. 明るい表示とダークモードを切り替える
       ======================================================= */
    function getInitialTheme() {
        try {
            const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
            if (savedTheme === "light" || savedTheme === "dark") {
                return savedTheme;
            }
        } catch (error) {
            // 保存が使えない場合も、端末の設定を見て表示できます。
        }

        return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
    }

    function applyTheme(theme, shouldSave = false) {
        const isDark = theme === "dark";
        document.documentElement.dataset.theme = isDark ? "dark" : "light";
        document.body.dataset.theme = isDark ? "dark" : "light";
        elements.themeToggle.setAttribute("aria-checked", String(isDark));
        elements.themeToggle.setAttribute("aria-label", isDark
            ? "ライトモードに切り替える"
            : "ダークモードに切り替える");
        elements.themeToggleIcon.textContent = isDark ? "☀" : "☾";
        elements.themeToggleText.textContent = isDark ? "ライト" : "ダーク";

        if (shouldSave) {
            try {
                window.localStorage.setItem(THEME_STORAGE_KEY, isDark ? "dark" : "light");
            } catch (error) {
                announce("表示テーマを保存できませんでしたが、この画面には反映しました。");
            }
        }
    }

    function toggleTheme() {
        const nextTheme = document.body.dataset.theme === "dark" ? "light" : "dark";
        applyTheme(nextTheme, true);
        announce(nextTheme === "dark" ? "ダークモードにしました。" : "ライトモードにしました。");
    }

    /* =======================================================
       5. ブラウザー通知の許可と、通知を一度だけ表示する処理
       ======================================================= */
    function canUseBrowserNotifications() {
        return window.isSecureContext && "Notification" in window;
    }

    function updateBrowserNotificationUi() {
        const panel = elements.notificationPermissionPanel;
        const status = elements.notificationPermissionStatus;
        const button = elements.notificationPermissionButton;

        if (!canUseBrowserNotifications()) {
            panel.dataset.state = "unsupported";
            status.textContent = "localhostまたはHTTPSで開くと使えます。黄色い画面内通知はそのまま動きます。";
            button.textContent = "通知を利用できません";
            button.disabled = true;
            return;
        }

        const permission = window.Notification.permission;
        panel.dataset.state = permission;
        if (permission === "granted") {
            status.textContent = "許可済みです。ページを開いていれば別タブでも通知します（少し遅れる場合があります）。";
            button.textContent = "通知は許可済み";
            button.disabled = true;
        } else if (permission === "denied") {
            status.textContent = "ブロックされています。ブラウザのサイト設定から通知を許可してください。";
            button.textContent = "通知はブロック中";
            button.disabled = true;
        } else {
            status.textContent = "未設定です。許可すると、リマインド時刻と予定開始時刻を通知します。";
            button.textContent = "通知を許可";
            button.disabled = false;
        }
    }

    function waitForActiveNotificationWorker(registration) {
        if (registration.active) {
            return Promise.resolve(registration);
        }

        const worker = registration.installing || registration.waiting;
        if (!worker) {
            return Promise.resolve(null);
        }

        return new Promise((resolve) => {
            let isFinished = false;
            let timeoutId = null;

            const finish = (value) => {
                if (isFinished) {
                    return;
                }
                isFinished = true;
                window.clearTimeout(timeoutId);
                worker.removeEventListener("statechange", checkWorkerState);
                resolve(value);
            };

            const checkWorkerState = () => {
                if (registration.active || worker.state === "activated") {
                    finish(registration);
                } else if (worker.state === "redundant") {
                    finish(null);
                }
            };

            worker.addEventListener("statechange", checkWorkerState);
            timeoutId = window.setTimeout(() => {
                finish(registration.active ? registration : null);
            }, SERVICE_WORKER_READY_TIMEOUT_MS);
            checkWorkerState();
        });
    }

    function prepareNotificationServiceWorker() {
        if (!("serviceWorker" in navigator) || !window.isSecureContext) {
            return Promise.resolve(null);
        }
        if (!notificationServiceWorkerPromise) {
            notificationServiceWorkerPromise = navigator.serviceWorker
                .register("service-worker.js?v=20260821m")
                .then(waitForActiveNotificationWorker)
                .then((registration) => {
                    /* 3秒を超えた場合は、次の通知で有効化済みかもう一度確認できます。 */
                    if (!registration) {
                        notificationServiceWorkerPromise = null;
                    }
                    return registration;
                })
                .catch((error) => {
                    notificationServiceWorkerPromise = null;
                    console.warn("通知を表示する準備ができませんでした。", error);
                    return null;
                });
        }
        return notificationServiceWorkerPromise;
    }

    async function requestBrowserNotificationPermission() {
        if (!canUseBrowserNotifications() || window.Notification.permission !== "default") {
            updateBrowserNotificationUi();
            return;
        }

        elements.notificationPermissionButton.disabled = true;
        elements.notificationPermissionButton.textContent = "確認中…";
        try {
            const permission = await window.Notification.requestPermission();
            updateBrowserNotificationUi();
            if (permission === "granted") {
                await prepareNotificationServiceWorker();
                announce("ブラウザ通知を許可しました。");
                tick();
            } else {
                announce("ブラウザ通知は許可されませんでした。黄色い画面内通知は使えます。");
            }
        } catch (error) {
            updateBrowserNotificationUi();
            announce("ブラウザ通知の許可を確認できませんでした。黄色い画面内通知は使えます。");
        }
    }

    function runWithNotificationLock(callback) {
        if (navigator.locks && typeof navigator.locks.request === "function") {
            return navigator.locks.request("tokeibe-browser-notification", { mode: "exclusive" }, callback);
        }
        return callback();
    }

    function isBrowserNotificationStillValid(kind, scheduleId, targetTimestamp) {
        /* storageイベントより先に処理が進んでもよいよう、保存場所から最新予定を直接確認します。 */
        const schedule = loadSchedules().find((item) => item.id === scheduleId);
        if (!schedule) {
            return false;
        }

        const startDate = makeScheduleStartDate(schedule);
        const targetDate = kind === "reminder" ? makeReminderDate(schedule) : startDate;
        if (
            !startDate
            || !targetDate
            || targetDate.getTime() !== targetTimestamp
            || !wasNotificationTimeAfterCreation(schedule, targetDate)
            || !isNotificationTime(new Date(), targetDate)
        ) {
            return false;
        }

        return kind !== "reminder" || Date.now() < startDate.getTime();
    }

    async function showBrowserNotification(notificationKey, title, body, isStillValid) {
        if (
            !canUseBrowserNotifications()
            || window.Notification.permission !== "granted"
            || notificationHistory.has(notificationKey)
            || pendingNotificationKeys.has(notificationKey)
            || failedNotificationKeys.has(notificationKey)
        ) {
            return;
        }

        pendingNotificationKeys.add(notificationKey);
        const targetUrl = new URL("./", window.location.href).href;
        const iconUrl = new URL("img/icon.png", targetUrl).href;
        const options = {
            body,
            tag: `tokeibe-${notificationKey}`,
            icon: iconUrl,
            badge: iconUrl,
            data: { url: targetUrl }
        };

        try {
            await runWithNotificationLock(async () => {
                /* 別タブが先に通知した可能性があるため、ロックの中でもう一度読み直します。 */
                syncNotificationHistory();
                if (
                    notificationHistory.has(notificationKey)
                    || failedNotificationKeys.has(notificationKey)
                    || window.Notification.permission !== "granted"
                    || !isStillValid()
                ) {
                    return;
                }

                const registration = await prepareNotificationServiceWorker();
                syncNotificationHistory();
                if (
                    notificationHistory.has(notificationKey)
                    || window.Notification.permission !== "granted"
                    || !isStillValid()
                ) {
                    return;
                }

                if (registration && typeof registration.showNotification === "function") {
                    await registration.showNotification(title, options);
                } else {
                    const notification = new window.Notification(title, options);
                    notification.addEventListener("click", () => {
                        window.focus();
                        notification.close();
                    });
                }
                markBrowserNotificationSent(notificationKey);
            });
        } catch (error) {
            failedNotificationKeys.add(notificationKey);
            console.warn("ブラウザ通知を表示できませんでした。", error);
        } finally {
            pendingNotificationKeys.delete(notificationKey);
        }
    }

    function checkBrowserNotifications(now) {
        if (!canUseBrowserNotifications() || window.Notification.permission !== "granted") {
            return;
        }

        getNotificationCandidateSchedules(now).forEach((schedule) => {
            const startDate = makeScheduleStartDate(schedule);
            const reminderDate = makeReminderDate(schedule);
            const body = `${schedule.start}〜${schedule.end}　${schedule.title}`;

            if (
                isNotificationTime(now, reminderDate)
                && startDate
                && now.getTime() < startDate.getTime()
                && wasNotificationTimeAfterCreation(schedule, reminderDate)
            ) {
                const reminderTime = minutesToTime((reminderDate.getHours() * 60) + reminderDate.getMinutes());
                const reminderKey = `reminder:${reminderDate.getTime()}:${schedule.id}`;
                void showBrowserNotification(
                    reminderKey,
                    `${reminderTime}のリマインド時間になりました。`,
                    body,
                    () => isBrowserNotificationStillValid("reminder", schedule.id, reminderDate.getTime())
                );
            }

            if (isNotificationTime(now, startDate) && wasNotificationTimeAfterCreation(schedule, startDate)) {
                const startKey = `start:${startDate.getTime()}:${schedule.id}`;
                void showBrowserNotification(
                    startKey,
                    "予定の時刻になりました",
                    body,
                    () => isBrowserNotificationStillValid("start", schedule.id, startDate.getTime())
                );
            }
        });
    }

    /* =======================================================
       6. 月間カレンダーを描く
       ======================================================= */
    /* 午前・午後の色帯の端へ、その時間帯にある予定数を丸く表示します。 */
    function appendCalendarPeriodCount(button, period, count) {
        const countBadge = document.createElement("span");
        countBadge.className = `calendar-period-count ${period}`;
        countBadge.textContent = String(count);
        countBadge.setAttribute("aria-hidden", "true");
        button.appendChild(countBadge);
    }

    /* カーソルやキーボードで日付を選んだときに、全予定のタイトルを見せます。 */
    function appendCalendarScheduleTooltip(button, dateKey, dateSchedules) {
        const tooltip = document.createElement("span");
        const heading = document.createElement("span");
        const list = document.createElement("span");

        tooltip.id = `calendar-schedule-tooltip-${dateKey}`;
        tooltip.className = "calendar-schedule-tooltip";
        tooltip.setAttribute("role", "tooltip");
        heading.className = "calendar-tooltip-heading";
        heading.textContent = `この日の予定 ${dateSchedules.length}件`;
        list.className = "calendar-tooltip-list";

        dateSchedules.forEach((schedule) => {
            const item = document.createElement("span");
            const time = document.createElement("span");
            const title = document.createElement("span");

            item.className = "calendar-tooltip-item";
            time.className = "calendar-tooltip-time";
            time.textContent = `${schedule.start}〜${schedule.end}`;
            title.className = "calendar-tooltip-title";
            title.textContent = schedule.title;
            item.append(time, title);

            if (schedule.important) {
                const importantLabel = document.createElement("span");
                item.classList.add("is-important");
                importantLabel.className = "calendar-tooltip-important";
                importantLabel.textContent = "重要";
                item.appendChild(importantLabel);
            }

            list.appendChild(item);
        });

        tooltip.append(heading, list);
        button.setAttribute("aria-describedby", tooltip.id);
        button.appendChild(tooltip);
    }

    function renderCalendar() {
        const year = viewingMonth.getFullYear();
        const month = viewingMonth.getMonth();
        const firstWeekday = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const todayKey = toDateKey(new Date());
        const selectedKey = toDateKey(selectedDate);

        elements.calendarMonthLabel.textContent = formatMonth(viewingMonth);
        elements.calendarGrid.replaceChildren();

        for (let blankIndex = 0; blankIndex < firstWeekday; blankIndex += 1) {
            const blank = document.createElement("span");
            blank.className = "calendar-blank";
            blank.setAttribute("aria-hidden", "true");
            elements.calendarGrid.appendChild(blank);
        }

        for (let day = 1; day <= daysInMonth; day += 1) {
            const date = new Date(year, month, day);
            const dateKey = toDateKey(date);
            const dateSchedules = schedulesForDate(dateKey);
            /* 12:00を境にし、正午をまたぐ予定は午前・午後の両方へ表示します。 */
            const amSchedules = dateSchedules.filter((schedule) => timeToMinutes(schedule.start) < 720);
            const pmSchedules = dateSchedules.filter((schedule) => timeToMinutes(schedule.end) > 720);
            const importantScheduleCount = dateSchedules.filter((schedule) => schedule.important).length;
            const button = document.createElement("button");

            button.type = "button";
            button.className = "calendar-day";
            button.textContent = String(day);
            button.dataset.date = dateKey;
            button.setAttribute("aria-pressed", String(dateKey === selectedKey));

            /* 日付の数字も、日曜日は赤・土曜日は青になる目印を付けます。 */
            if (date.getDay() === 0) {
                button.classList.add("sunday");
            } else if (date.getDay() === 6) {
                button.classList.add("saturday");
            }

            const descriptionParts = [formatLongDate(date)];
            if (dateKey === todayKey) {
                button.classList.add("is-today");
                button.setAttribute("aria-current", "date");
                descriptionParts.push("今日");
            }
            if (dateKey === selectedKey) {
                button.classList.add("is-selected");
            }
            if (dateSchedules.length > 0) {
                button.classList.add("has-schedule");
                descriptionParts.push(`予定${dateSchedules.length}件`);
            }
            /* 日付マスの上を午前、下を午後として色の帯を付けます。 */
            if (amSchedules.length > 0) {
                button.classList.add("has-am-schedule");
                descriptionParts.push(`午前にかかる予定${amSchedules.length}件`);
                if (amSchedules.some((schedule) => schedule.important)) {
                    button.classList.add("has-important-am-schedule");
                }
                appendCalendarPeriodCount(button, "am", amSchedules.length);
            }
            if (pmSchedules.length > 0) {
                button.classList.add("has-pm-schedule");
                descriptionParts.push(`午後にかかる予定${pmSchedules.length}件`);
                if (pmSchedules.some((schedule) => schedule.important)) {
                    button.classList.add("has-important-pm-schedule");
                }
                appendCalendarPeriodCount(button, "pm", pmSchedules.length);
            }
            if (importantScheduleCount > 0) {
                button.classList.add("has-important-schedule");
                descriptionParts.push(`重要な予定${importantScheduleCount}件`);
            }
            if (dateSchedules.length > 0) {
                if (date.getDay() <= 1) {
                    button.classList.add("calendar-tooltip-align-start");
                } else if (date.getDay() >= 5) {
                    button.classList.add("calendar-tooltip-align-end");
                }
                appendCalendarScheduleTooltip(button, dateKey, dateSchedules);
            }

            button.setAttribute("aria-label", descriptionParts.join("、"));
            button.addEventListener("click", () => {
                selectedDate = date;
                closeHourPopover();
                renderAllScheduleViews();
                const refreshedButton = elements.calendarGrid.querySelector(`[data-date="${dateKey}"]`);
                if (refreshedButton) {
                    refreshedButton.focus({ preventScroll: true });
                }
                announce(`${formatLongDate(date)}を選びました。`);
            });
            elements.calendarGrid.appendChild(button);
        }
    }

    function moveMonth(monthDifference) {
        const oldSelectedDay = selectedDate.getDate();
        viewingMonth = new Date(viewingMonth.getFullYear(), viewingMonth.getMonth() + monthDifference, 1);
        const lastDay = new Date(viewingMonth.getFullYear(), viewingMonth.getMonth() + 1, 0).getDate();
        selectedDate = new Date(
            viewingMonth.getFullYear(),
            viewingMonth.getMonth(),
            Math.min(oldSelectedDay, lastDay)
        );
        closeHourPopover();
        renderAllScheduleViews();
    }

    function returnToToday() {
        const today = new Date();
        selectedDate = startOfDay(today);
        viewingMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        closeHourPopover();
        renderAllScheduleViews();
        announce("今日の予定に戻りました。");
    }

    /* =======================================================
       7. 1～12の時刻ボタンと吹き出し
       ======================================================= */
    function buildHourButtons() {
        elements.hourButtons.replaceChildren();

        for (let hour = 1; hour <= 12; hour += 1) {
            const angle = (hour * 30) - 90;
            const radians = angle * (Math.PI / 180);
            const radius = 41;
            const button = document.createElement("button");

            button.type = "button";
            button.className = "hour-button";
            button.dataset.hour = String(hour);
            button.textContent = String(hour);
            button.style.setProperty("--hour-left", `${50 + (radius * Math.cos(radians))}%`);
            button.style.setProperty("--hour-top", `${50 + (radius * Math.sin(radians))}%`);
            button.setAttribute("aria-label", `${hour}時から予定を追加`);
            button.setAttribute("aria-expanded", "false");
            button.setAttribute("aria-controls", "hourPopover");
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                openHourPopover(hour, button);
            });
            elements.hourButtons.appendChild(button);
        }
    }

    function openHourPopover(hour, button) {
        if (activeHourButton === button && elements.hourPopover.classList.contains("is-visible")) {
            closeHourPopover();
            return;
        }

        closeHourPopover(false);
        window.clearTimeout(popoverHideTimer);
        selectedHour = hour;
        activeHourButton = button;
        elements.hourPopoverTitle.textContent = `${hour}時からの予定`;
        elements.hourPopover.hidden = false;
        elements.hourPopover.classList.add("is-visible");
        elements.hourPopover.setAttribute("aria-hidden", "false");
        button.setAttribute("aria-expanded", "true");
        updatePeriodButtons();
        positionHourPopover();

        // 時計の枠より外側へ出しつつ、ブラウザーの端からはみ出さない位置に置きます。
        window.requestAnimationFrame(() => {
            positionHourPopover();
            (selectedPeriod === "am" ? elements.amButton : elements.pmButton).focus();
        });
    }

    function positionHourPopover() {
        if (!activeHourButton || !elements.hourPopover.classList.contains("is-visible")) {
            return;
        }

        const faceRect = elements.clockFace.getBoundingClientRect();
        const buttonRect = activeHourButton.getBoundingClientRect();
        const popoverRect = elements.hourPopover.getBoundingClientRect();
        const buttonCenterX = buttonRect.left - faceRect.left + (buttonRect.width / 2);
        const buttonCenterY = buttonRect.top - faceRect.top + (buttonRect.height / 2);
        const distanceFromCenterX = buttonCenterX - (faceRect.width / 2);
        const distanceFromCenterY = buttonCenterY - (faceRect.height / 2);
        const space = 12;
        let left;
        let top;

        // 3時・9時の近くは横へ、12時・6時の近くは上下へ出します。
        if (Math.abs(distanceFromCenterX) > Math.abs(distanceFromCenterY)) {
            left = distanceFromCenterX < 0
                ? buttonRect.left - faceRect.left - popoverRect.width - space
                : buttonRect.right - faceRect.left + space;
            top = buttonCenterY - (popoverRect.height / 2);
        } else {
            left = buttonCenterX - (popoverRect.width / 2);
            top = distanceFromCenterY < 0
                ? buttonRect.top - faceRect.top - popoverRect.height - space
                : buttonRect.bottom - faceRect.top + space;
        }

        const viewportSpace = 10;
        const minimumLeft = viewportSpace - faceRect.left;
        const maximumLeft = document.documentElement.clientWidth - viewportSpace - faceRect.left - popoverRect.width;
        const minimumTop = viewportSpace - faceRect.top;
        const maximumTop = document.documentElement.clientHeight - viewportSpace - faceRect.top - popoverRect.height;
        left = Math.max(minimumLeft, Math.min(Math.max(minimumLeft, maximumLeft), left));
        top = Math.max(minimumTop, Math.min(Math.max(minimumTop, maximumTop), top));
        elements.hourPopover.style.left = `${left}px`;
        elements.hourPopover.style.top = `${top}px`;

        // 時計の太い枠ぶんのずれも、最後に実際の位置を見て補正します。
        const placedRect = elements.hourPopover.getBoundingClientRect();
        const horizontalCorrection = placedRect.left < viewportSpace
            ? viewportSpace - placedRect.left
            : Math.min(0, document.documentElement.clientWidth - viewportSpace - placedRect.right);
        const verticalCorrection = placedRect.top < viewportSpace
            ? viewportSpace - placedRect.top
            : Math.min(0, document.documentElement.clientHeight - viewportSpace - placedRect.bottom);
        if (horizontalCorrection || verticalCorrection) {
            elements.hourPopover.style.left = `${left + horizontalCorrection}px`;
            elements.hourPopover.style.top = `${top + verticalCorrection}px`;
        }
    }

    function closeHourPopover(returnFocus = false) {
        window.clearTimeout(popoverHideTimer);
        elements.hourPopover.classList.remove("is-visible");
        elements.hourPopover.setAttribute("aria-hidden", "true");

        if (activeHourButton) {
            activeHourButton.setAttribute("aria-expanded", "false");
            if (returnFocus) {
                activeHourButton.focus();
            }
        }
        activeHourButton = null;
        popoverHideTimer = window.setTimeout(() => {
            if (!elements.hourPopover.classList.contains("is-visible")) {
                elements.hourPopover.hidden = true;
            }
        }, FADE_DURATION);
    }

    function updatePeriodButtons() {
        const isMorning = selectedPeriod === "am";
        elements.amButton.setAttribute("aria-pressed", String(isMorning));
        elements.pmButton.setAttribute("aria-pressed", String(!isMorning));
    }

    /* =======================================================
       8. 時計の背景に、午前は青・午後はオレンジで予定を描く
       ======================================================= */
    function appendScheduleArc(period, startMinutes, endMinutes, isImportant) {
        const periodStart = period === "am" ? 0 : 720;
        const segmentStart = Math.max(startMinutes, periodStart);
        const segmentEnd = Math.min(endMinutes, periodStart + 720);

        if (segmentEnd <= segmentStart) {
            return;
        }

        const duration = segmentEnd - segmentStart;
        const startInsideRing = segmentStart - periodStart;
        const circle = document.createElementNS(SVG_NAMESPACE, "circle");

        circle.setAttribute("cx", "50");
        circle.setAttribute("cy", "50");
        circle.setAttribute("r", period === "am" ? "43" : "36");
        circle.setAttribute("pathLength", "720");
        circle.setAttribute("stroke-dasharray", `${duration} ${720 - duration}`);
        circle.setAttribute("stroke-dashoffset", String(-startInsideRing));
        circle.classList.add("schedule-arc", period);
        if (isImportant) {
            circle.classList.add("important");
        }
        elements.scheduleArcs.appendChild(circle);
    }

    function markCoveredHours(startMinutes, endMinutes, period, isImportant) {
        const periodStart = period === "am" ? 0 : 720;
        const segmentStart = Math.max(startMinutes, periodStart);
        const segmentEnd = Math.min(endMinutes, periodStart + 720);

        if (segmentEnd <= segmentStart) {
            return;
        }

        const firstHour = Math.floor(segmentStart / 60);
        const lastHour = Math.floor((segmentEnd - 1) / 60);
        for (let hour24 = firstHour; hour24 <= lastHour; hour24 += 1) {
            const displayHour = hour24 % 12 || 12;
            const button = elements.hourButtons.querySelector(`[data-hour="${displayHour}"]`);
            if (button) {
                button.classList.add(period === "am" ? "has-am-schedule" : "has-pm-schedule");
                if (isImportant) {
                    button.classList.add("has-important-schedule");
                }
            }
        }
    }

    function renderClockSchedules() {
        const selectedSchedules = schedulesForDate(selectedDate);
        elements.selectedDateLabel.textContent = `${formatLongDate(selectedDate)}の予定`;
        elements.scheduleArcs.replaceChildren();

        elements.hourButtons.querySelectorAll(".hour-button").forEach((button) => {
            button.classList.remove("has-am-schedule", "has-pm-schedule", "has-important-schedule");
        });

        // 通常予定を先、重要予定を後に描いて、赤色が隠れないようにします。
        [...selectedSchedules]
            .sort((a, b) => Number(a.important) - Number(b.important))
            .forEach((schedule) => {
            const startMinutes = timeToMinutes(schedule.start);
            const endMinutes = timeToMinutes(schedule.end);
            appendScheduleArc("am", startMinutes, endMinutes, schedule.important);
            appendScheduleArc("pm", startMinutes, endMinutes, schedule.important);
            markCoveredHours(startMinutes, endMinutes, "am", schedule.important);
            markCoveredHours(startMinutes, endMinutes, "pm", schedule.important);
            });
    }

    /* =======================================================
       9. 時計の針を、端末の現在時刻に合わせる
       ======================================================= */
    function updateClockHands(now) {
        const hours = now.getHours() % 12;
        const minutes = now.getMinutes();
        const hourDegrees = (hours * 30) + (minutes * 0.5);
        const minuteDegrees = minutes * 6;

        elements.hourHand.style.setProperty("--rotation", `${hourDegrees}deg`);
        elements.minuteHand.style.setProperty("--rotation", `${minuteDegrees}deg`);
    }

    /* =======================================================
       10. 今日の日程一覧
       ======================================================= */
    function renderTodayScheduleList() {
        const todaySchedules = schedulesForDate(new Date());
        elements.todayScheduleCount.textContent = `${todaySchedules.length}件`;
        elements.todayScheduleList.replaceChildren();

        if (todaySchedules.length === 0) {
            const emptyItem = document.createElement("li");
            emptyItem.className = "empty-schedule";
            emptyItem.textContent = "今日の予定はまだありません。時計の数字か中央の＋から追加できます。";
            elements.todayScheduleList.appendChild(emptyItem);
            return;
        }

        todaySchedules.forEach((schedule) => {
            const item = document.createElement("li");
            const time = document.createElement("time");
            const title = document.createElement("span");
            const deleteButton = document.createElement("button");

            item.className = "schedule-item";
            if (schedule.important) {
                item.classList.add("is-important");
            }
            item.style.setProperty(
                "--schedule-color",
                schedule.important
                    ? "var(--color-important)"
                    : (timeToMinutes(schedule.start) < 720 ? "var(--color-am)" : "var(--color-pm)")
            );

            time.className = "schedule-time";
            time.textContent = `${schedule.start}〜${schedule.end}`;
            time.dateTime = `${schedule.date}T${schedule.start}`;

            title.className = "schedule-title";
            title.textContent = schedule.title;

            if (schedule.important) {
                const importantBadge = document.createElement("span");
                importantBadge.className = "schedule-badge important";
                importantBadge.textContent = "重要";
                title.appendChild(importantBadge);
            }
            if (schedule.source === "google" || schedule.googleEventId) {
                const googleBadge = document.createElement("span");
                googleBadge.className = "schedule-badge google";
                googleBadge.textContent = "Google";
                title.appendChild(googleBadge);
            }
            if (normalizeReminderMinutes(schedule.reminderMinutes) > 0) {
                const reminderBadge = document.createElement("span");
                reminderBadge.className = "schedule-badge reminder";
                reminderBadge.textContent = formatReminderLabel(schedule.reminderMinutes);
                title.appendChild(reminderBadge);
            }

            deleteButton.type = "button";
            deleteButton.className = "delete-schedule-button";
            deleteButton.textContent = "×";
            deleteButton.setAttribute("aria-label", `${schedule.title}を削除`);
            deleteButton.addEventListener("click", () => deleteSchedule(schedule));

            item.append(time, title, deleteButton);
            elements.todayScheduleList.appendChild(item);
        });
    }

    function deleteSchedule(schedule) {
        const googleNote = schedule.source === "google" || schedule.googleEventId
            ? "\nGoogleカレンダー側の予定は削除されません。"
            : "";
        const shouldDelete = window.confirm(`「${schedule.title}」をこのブラウザーから削除しますか？${googleNote}`);
        if (!shouldDelete) {
            return;
        }

        const previousSchedules = schedules;
        schedules = schedules.filter((item) => item.id !== schedule.id);
        rebuildScheduleIndex();
        if (!saveSchedules()) {
            schedules = previousSchedules;
            rebuildScheduleIndex();
            announce("端末に保存できなかったため、予定は削除されませんでした。");
            return;
        }

        removeNotificationHistoryForSchedule(schedule.id);
        removeDismissedAlertsForSchedule(schedule.id);
        renderAllScheduleViews();
        checkAlertsAndNotifications(new Date());
        announce(`${schedule.title}を削除しました。`);
    }

    /* =======================================================
       11. 予定を入力する画面を開く・閉じる
       ======================================================= */
    function getDefaultScheduleRange() {
        const now = new Date();
        const isTodaySelected = toDateKey(selectedDate) === toDateKey(now);
        if (!isTodaySelected) {
            return {
                date: startOfDay(selectedDate),
                startMinutes: 9 * 60
            };
        }

        const currentMinutes = (now.getHours() * 60) + now.getMinutes();
        const roundedUp = Math.ceil(currentMinutes / 30) * 30;

        // 今日の中に未来の時刻を作れない場合は、翌日の朝を初期値にします。
        if (roundedUp >= 24 * 60) {
            return {
                date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
                startMinutes: 9 * 60
            };
        }

        return {
            date: startOfDay(now),
            startMinutes: roundedUp
        };
    }

    function hourAndPeriodToMinutes(hour, period) {
        if (period === "am") {
            return hour === 12 ? 0 : hour * 60;
        }
        return (hour === 12 ? 12 : hour + 12) * 60;
    }

    function openScheduleModal(options = {}) {
        window.clearTimeout(modalHideTimer);
        const focusReturnTarget = activeHourButton || document.activeElement;
        closeHourPopover(false);
        previousFocus = focusReturnTarget;

        const defaultRange = options.hour
            ? {
                date: startOfDay(selectedDate),
                startMinutes: hourAndPeriodToMinutes(options.hour, options.period || selectedPeriod)
            }
            : getDefaultScheduleRange();
        const startMinutes = defaultRange.startMinutes;
        const endMinutes = Math.min(startMinutes + 60, 1439);

        elements.scheduleDate.value = toDateKey(defaultRange.date);
        elements.scheduleTitle.value = "";
        elements.scheduleStart.value = minutesToTime(startMinutes);
        elements.scheduleEnd.value = minutesToTime(endMinutes);
        elements.scheduleReminder.value = "0";
        elements.scheduleImportant.checked = false;
        elements.addToGoogleCalendar.checked = false;
        elements.formError.hidden = true;
        elements.formError.textContent = "";
        elements.scheduleModal.hidden = false;
        document.body.style.overflow = "hidden";

        window.requestAnimationFrame(() => {
            elements.scheduleModal.classList.add("is-visible");
            elements.scheduleTitle.focus();
        });
    }

    function closeScheduleModal(returnFocus = true) {
        if (elements.scheduleModal.hidden) {
            return;
        }

        elements.scheduleModal.classList.remove("is-visible");
        document.body.style.overflow = "";
        modalHideTimer = window.setTimeout(() => {
            elements.scheduleModal.hidden = true;
        }, FADE_DURATION);

        if (returnFocus && previousFocus instanceof HTMLElement) {
            previousFocus.focus();
        }
        previousFocus = null;
    }

    function showFormError(message, field) {
        elements.formError.textContent = message;
        elements.formError.hidden = false;
        if (field) {
            field.focus();
        }
    }

    async function submitSchedule(event) {
        event.preventDefault();

        const date = parseDateKey(elements.scheduleDate.value);
        const title = elements.scheduleTitle.value.trim();
        const start = elements.scheduleStart.value;
        const end = elements.scheduleEnd.value;
        const reminderMinutes = normalizeReminderMinutes(elements.scheduleReminder.value);
        const important = elements.scheduleImportant.checked;
        const requestedGoogleAdd = !elements.googleAddChoice.hidden && elements.addToGoogleCalendar.checked;
        const shouldAddToGoogle = requestedGoogleAdd && hasValidGoogleToken();

        if (!date) {
            showFormError("正しい日付を選んでください。", elements.scheduleDate);
            return;
        }
        if (!title) {
            showFormError("予定のタイトルを入力してください。", elements.scheduleTitle);
            return;
        }
        if (!isTimeString(start) || !isTimeString(end)) {
            showFormError("始まる時刻と終わる時刻を入力してください。", elements.scheduleStart);
            return;
        }
        if (timeToMinutes(end) <= timeToMinutes(start)) {
            showFormError("終わる時刻は、始まる時刻より後にしてください。", elements.scheduleEnd);
            return;
        }
        if (!REMINDER_MINUTE_OPTIONS.includes(Number(elements.scheduleReminder.value))) {
            showFormError("正しいリマインド時間を選んでください。", elements.scheduleReminder);
            return;
        }

        const newSchedule = {
            id: makeScheduleId(),
            date: toDateKey(date),
            title,
            start,
            end,
            reminderMinutes,
            important,
            source: "local",
            googleCalendarId: "",
            googleEventId: "",
            googleHtmlLink: "",
            createdAt: new Date().toISOString()
        };

        schedules.push(newSchedule);
        schedules.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
        rebuildScheduleIndex();
        if (!saveSchedules()) {
            schedules = schedules.filter((schedule) => schedule.id !== newSchedule.id);
            rebuildScheduleIndex();
            showFormError("端末に保存できませんでした。空き容量やブラウザの設定を確認してください。", elements.scheduleTitle);
            announce("端末に保存できなかったため、予定は追加されませんでした。");
            return;
        }

        selectedDate = date;
        viewingMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        renderAllScheduleViews();
        closeScheduleModal();
        checkAlertsAndNotifications(new Date());
        const reminderAnnouncement = reminderMinutes > 0
            ? ` ${formatReminderLabel(reminderMinutes)}を設定しました。`
            : "";
        announce(`${title}を${start}から${end}に追加しました。${reminderAnnouncement}`);

        if (requestedGoogleAdd && !shouldAddToGoogle) {
            clearGoogleConnectionState("Googleの接続期限が切れたため、ローカルだけに保存しました。もう一度接続してください。", true);
            announce("Googleの接続期限が切れたため、ローカルだけに保存しました。");
        }

        // Google追加に失敗しても、先に保存したローカル予定は消しません。
        if (shouldAddToGoogle) {
            setGoogleStatus("Googleカレンダーへ追加しています。");
            try {
                const googleEvent = await insertScheduleIntoGoogle(newSchedule);
                newSchedule.googleCalendarId = "primary";
                newSchedule.googleEventId = googleEvent.id || makeGoogleEventId(newSchedule.id);
                newSchedule.googleHtmlLink = typeof googleEvent.htmlLink === "string" ? googleEvent.htmlLink : "";
                if (!saveSchedules()) {
                    setGoogleStatus("Googleには追加できましたが、連携情報を端末へ保存できませんでした。", true);
                    announce("Googleには追加できましたが、連携情報を端末へ保存できませんでした。");
                    return;
                }
                renderTodayScheduleList();
                setGoogleStatus(`「${title}」をGoogleカレンダーにも追加しました。`);
                announce(`${title}をGoogleカレンダーにも追加しました。`);
            } catch (error) {
                setGoogleStatus(getGoogleErrorMessage(error, "Googleへの追加に失敗しました。ローカル予定は保存されています。"), true);
                announce("Googleへの追加だけ失敗しました。ローカル予定は保存されています。");
            }
        }
    }

    function keepFocusInsideModal(event) {
        if (event.key !== "Tab" || elements.scheduleModal.hidden) {
            return;
        }

        const focusableElements = [...elements.scheduleModal.querySelectorAll(
            "button:not([disabled]), input:not([disabled]), select:not([disabled])"
        )].filter((element) => element.offsetParent !== null);

        if (focusableElements.length === 0) {
            return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (event.shiftKey && document.activeElement === firstElement) {
            event.preventDefault();
            lastElement.focus();
        } else if (!event.shiftKey && document.activeElement === lastElement) {
            event.preventDefault();
            firstElement.focus();
        }
    }

    /* =======================================================
       12. GoogleカレンダーをOAuth 2.0で安全に読み書きする
       ======================================================= */
    function isGoogleClientIdConfigured() {
        return typeof GOOGLE_CLIENT_ID === "string"
            && GOOGLE_CLIENT_ID.length > 0
            && GOOGLE_CLIENT_ID.length <= 255
            && !/\s/.test(GOOGLE_CLIENT_ID)
            && GOOGLE_CLIENT_ID.endsWith(".apps.googleusercontent.com");
    }

    /* Google OAuthはHTTPS、または開発用のlocalhostでだけ使います。 */
    function canUseGoogleOAuthOnCurrentOrigin() {
        const localHosts = ["localhost", "127.0.0.1", "::1", "[::1]"];
        return window.location.protocol === "https:"
            || (window.location.protocol === "http:" && localHosts.includes(window.location.hostname));
    }

    function setGoogleStatus(message, isError = false) {
        elements.googleCalendarStatus.textContent = message;
        elements.googleCalendarStatus.classList.toggle("is-error", isError);
    }

    function hasValidGoogleToken() {
        return Boolean(googleAccessToken) && Date.now() < googleTokenExpiresAt;
    }

    function updateGoogleConnectionUi() {
        const isConnected = hasValidGoogleToken();
        const isConfigured = isGoogleClientIdConfigured();
        const canUseOAuth = canUseGoogleOAuthOnCurrentOrigin();
        elements.googleConnectionBadge.textContent = isConnected ? "接続済み" : "未接続";
        elements.googleConnectionBadge.classList.toggle("is-connected", isConnected);
        elements.googleConnectButton.textContent = isConnected ? "Google接続済み" : "Googleカレンダーと連携";
        elements.googleConnectButton.disabled = isConnected || !isConfigured || !canUseOAuth;
        elements.googleImportButton.disabled = !isConnected || Boolean(googleImportController);
        elements.googleDisconnectButton.disabled = !isConnected;
        elements.googleAddChoice.hidden = !isConnected;
        if (!isConnected) {
            elements.addToGoogleCalendar.checked = false;
        }
    }

    function clearGoogleConnectionState(message, isError = false) {
        if (googleImportController) {
            googleImportController.abort();
            googleImportController = null;
        }
        googleAccessToken = "";
        googleTokenExpiresAt = 0;
        updateGoogleConnectionUi();
        if (message) {
            setGoogleStatus(message, isError);
        }
    }

    function loadGoogleIdentityServices() {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) {
            return Promise.resolve();
        }
        if (googleScriptPromise) {
            return googleScriptPromise;
        }

        googleScriptPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            let timeoutId = null;

            const finish = (callback) => {
                window.clearTimeout(timeoutId);
                script.onload = null;
                script.onerror = null;
                callback();
            };

            script.src = GOOGLE_IDENTITY_SCRIPT;
            script.async = true;
            script.dataset.tokeibeGoogleIdentity = "true";
            script.onload = () => finish(() => {
                if (window.google && window.google.accounts && window.google.accounts.oauth2) {
                    resolve();
                } else {
                    reject(new Error("Googleの認証機能を確認できませんでした。"));
                }
            });
            script.onerror = () => finish(() => reject(new Error("Googleの認証機能を読み込めませんでした。")));
            timeoutId = window.setTimeout(() => {
                finish(() => reject(new Error("Googleの認証機能の読み込みに時間がかかっています。")));
            }, 15000);
            document.head.appendChild(script);
        }).catch((error) => {
            googleScriptPromise = null;
            throw error;
        });

        return googleScriptPromise;
    }

    function handleGoogleTokenResponse(response) {
        if (!response || response.error || !response.access_token) {
            clearGoogleConnectionState("Googleへの接続が許可されませんでした。ローカルの予定はそのまま使えます。", true);
            return;
        }

        const oauth = window.google && window.google.accounts && window.google.accounts.oauth2;
        const hasScope = !oauth || typeof oauth.hasGrantedAllScopes !== "function"
            ? String(response.scope || "").split(" ").includes(GOOGLE_SCOPE)
            : oauth.hasGrantedAllScopes(response, GOOGLE_SCOPE);
        if (!hasScope) {
            clearGoogleConnectionState("カレンダー予定の権限が許可されていません。", true);
            return;
        }

        const expiresInSeconds = Number(response.expires_in) || 3600;
        googleAccessToken = response.access_token;
        googleTokenExpiresAt = Date.now() + (Math.max(5, expiresInSeconds - 60) * 1000);
        updateGoogleConnectionUi();
        setGoogleStatus("Googleカレンダーへ接続しました。表示中の月を取り込めます。");
        announce("Googleカレンダーへ接続しました。");
    }

    function handleGooglePopupError(error) {
        const wasClosed = error && error.type === "popup_closed";
        clearGoogleConnectionState(wasClosed
            ? "Googleへの接続はキャンセルされました。"
            : "Googleの接続画面を開けませんでした。ポップアップの設定を確認してください。", !wasClosed);
    }

    async function connectGoogleCalendar() {
        if (!canUseGoogleOAuthOnCurrentOrigin()) {
            setGoogleStatus("Google連携はファイルの直接表示では使えません。localhostまたはHTTPSで開いてください。", true);
            return;
        }

        if (!isGoogleClientIdConfigured()) {
            setGoogleStatus("Google連携は、サイト管理者によるクライアントIDの設定完了後に利用できます。", true);
            return;
        }

        elements.googleConnectButton.disabled = true;
        elements.googleConnectButton.textContent = "認証機能を読込中…";
        setGoogleStatus("Googleの認証機能を読み込んでいます。");

        try {
            await loadGoogleIdentityServices();
            if (!googleTokenClient) {
                googleTokenClient = window.google.accounts.oauth2.initTokenClient({
                    client_id: GOOGLE_CLIENT_ID,
                    scope: GOOGLE_SCOPE,
                    callback: handleGoogleTokenResponse,
                    error_callback: handleGooglePopupError
                });
            }
            elements.googleConnectButton.disabled = false;
            elements.googleConnectButton.textContent = "Googleカレンダーと連携";
            setGoogleStatus("Googleの画面で、カレンダー予定への許可を確認してください。");
            /* 空文字にすると、同意済みの利用者へ毎回同じ許可画面を強制しません。 */
            googleTokenClient.requestAccessToken({ prompt: "" });
        } catch (error) {
            updateGoogleConnectionUi();
            setGoogleStatus(error && error.message
                ? error.message
                : "Googleの認証機能を読み込めませんでした。", true);
        }
    }

    function disconnectGoogleCalendar() {
        clearGoogleConnectionState("このタブのGoogle接続を切りました。取り込んだ予定は残ります。");
        announce("このタブのGoogle接続を切りました。");
    }

    function makeGoogleError(message, status = 0, code = "") {
        const error = new Error(message);
        error.status = status;
        error.code = code;
        return error;
    }

    function getGoogleErrorMessage(error, fallbackMessage) {
        if (error && error.name === "AbortError") {
            return "Googleからの取り込みを中止しました。";
        }
        if (error && (error.status === 401 || error.code === "token_expired")) {
            return "Googleの接続期限が切れました。もう一度接続してください。";
        }
        if (error && error.status === 403) {
            return "Google Calendar APIの有効化、テストユーザー、許可範囲を確認してください。";
        }
        if (error && error.status === 429) {
            return "Googleへのアクセスが混み合っています。少し待ってからもう一度お試しください。";
        }
        if (error && error.status >= 500) {
            return "Google側で一時的な問題が起きています。時間を置いてお試しください。";
        }
        return fallbackMessage;
    }

    function waitForRetry(milliseconds, signal) {
        return new Promise((resolve, reject) => {
            const timeoutId = window.setTimeout(resolve, milliseconds);
            if (signal) {
                signal.addEventListener("abort", () => {
                    window.clearTimeout(timeoutId);
                    reject(new DOMException("Aborted", "AbortError"));
                }, { once: true });
            }
        });
    }

    async function googleApiFetch(url, options = {}, attempt = 0) {
        if (!hasValidGoogleToken()) {
            clearGoogleConnectionState("Googleの接続期限が切れました。もう一度接続してください。", true);
            throw makeGoogleError("Google token expired", 401, "token_expired");
        }

        const headers = new Headers(options.headers || {});
        headers.set("Authorization", `Bearer ${googleAccessToken}`);
        const response = await window.fetch(url, { ...options, headers });

        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            await waitForRetry(450 * (2 ** attempt), options.signal);
            return googleApiFetch(url, options, attempt + 1);
        }

        let responseData = null;
        try {
            responseData = await response.json();
        } catch (error) {
            responseData = null;
        }

        if (!response.ok) {
            if (response.status === 401) {
                clearGoogleConnectionState("Googleの接続期限が切れました。もう一度接続してください。", true);
            }
            throw makeGoogleError("Google Calendar API request failed", response.status);
        }

        return responseData || {};
    }

    function makeGoogleMonthBoundary(date) {
        return `${toDateKey(date)}T00:00:00+09:00`;
    }

    async function fetchGoogleMonthEvents(signal) {
        const monthStart = new Date(viewingMonth.getFullYear(), viewingMonth.getMonth(), 1);
        const nextMonthStart = new Date(viewingMonth.getFullYear(), viewingMonth.getMonth() + 1, 1);
        const allEvents = [];
        let nextPageToken = "";
        let pageCount = 0;

        do {
            const parameters = new URLSearchParams({
                singleEvents: "true",
                orderBy: "startTime",
                showDeleted: "false",
                timeMin: makeGoogleMonthBoundary(monthStart),
                timeMax: makeGoogleMonthBoundary(nextMonthStart),
                timeZone: GOOGLE_TIME_ZONE,
                maxResults: "250",
                fields: "nextPageToken,items(id,status,summary,start,end,updated,etag,htmlLink,extendedProperties)"
            });
            if (nextPageToken) {
                parameters.set("pageToken", nextPageToken);
            }

            const response = await googleApiFetch(
                `${GOOGLE_CALENDAR_API}/calendars/primary/events?${parameters.toString()}`,
                { signal }
            );
            if (Array.isArray(response.items)) {
                allEvents.push(...response.items);
            }
            nextPageToken = typeof response.nextPageToken === "string" ? response.nextPageToken : "";
            pageCount += 1;
            if (pageCount >= 50 && nextPageToken) {
                throw makeGoogleError("Google Calendar pages exceeded the safe limit");
            }
        } while (nextPageToken);

        return allEvents;
    }

    function googleDateTimeToParts(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return null;
        }

        const values = {};
        GOOGLE_DATE_TIME_FORMATTER.formatToParts(date).forEach((part) => {
            if (part.type !== "literal") {
                values[part.type] = part.value;
            }
        });
        if (!values.year || !values.month || !values.day || !values.hour || !values.minute) {
            return null;
        }
        return {
            date: `${values.year}-${values.month}-${values.day}`,
            time: `${values.hour}:${values.minute}`
        };
    }

    function convertGoogleEvent(event) {
        if (!event || event.status === "cancelled" || typeof event.id !== "string" || !event.id) {
            return { reason: "invalid" };
        }
        if (event.start && event.start.date) {
            return { reason: "all-day" };
        }
        if (!event.start || !event.end || !event.start.dateTime || !event.end.dateTime) {
            return { reason: "invalid" };
        }

        const start = googleDateTimeToParts(event.start.dateTime);
        const end = googleDateTimeToParts(event.end.dateTime);
        if (!start || !end) {
            return { reason: "invalid" };
        }
        if (start.date !== end.date) {
            return { reason: "multi-day" };
        }
        if (!isTimeString(start.time) || !isTimeString(end.time) || timeToMinutes(end.time) <= timeToMinutes(start.time)) {
            return { reason: "invalid" };
        }

        const privateProperties = event.extendedProperties && event.extendedProperties.private
            ? event.extendedProperties.private
            : {};
        const rawTitle = typeof event.summary === "string" ? event.summary.trim() : "";
        return {
            schedule: {
                date: start.date,
                title: (rawTitle || "Googleカレンダーの予定").slice(0, 60),
                start: start.time,
                end: end.time,
                reminderMinutes: 0,
                important: privateProperties.tokeibeImportance === "important"
                    || privateProperties.importance === "important",
                source: "google",
                googleCalendarId: "primary",
                googleEventId: event.id,
                googleHtmlLink: typeof event.htmlLink === "string" ? event.htmlLink : "",
                googleUpdated: typeof event.updated === "string" ? event.updated : "",
                googleEtag: typeof event.etag === "string" ? event.etag : ""
            },
            localScheduleId: typeof privateProperties.tokeibeLocalId === "string"
                ? privateProperties.tokeibeLocalId
                : ""
        };
    }

    function makeImportedScheduleId(googleEventId, scheduleList) {
        const baseId = `google-${googleEventId}`;
        if (!scheduleList.some((schedule) => schedule.id === baseId)) {
            return baseId;
        }
        return `${baseId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function importGoogleEvents(events) {
        const previousSchedules = schedules;
        let nextSchedules = [...schedules];
        let addedCount = 0;
        let updatedCount = 0;
        let duplicateCount = 0;
        let allDayCount = 0;
        let multiDayCount = 0;
        let skippedCount = 0;
        const responseIds = new Set();

        events.forEach((event) => {
            if (event && typeof event.id === "string" && responseIds.has(event.id)) {
                duplicateCount += 1;
                return;
            }
            if (event && typeof event.id === "string") {
                responseIds.add(event.id);
            }

            const converted = convertGoogleEvent(event);
            if (!converted.schedule) {
                if (converted.reason === "all-day") {
                    allDayCount += 1;
                } else if (converted.reason === "multi-day") {
                    multiDayCount += 1;
                } else {
                    skippedCount += 1;
                }
                return;
            }

            const imported = converted.schedule;
            let existingIndex = converted.localScheduleId
                ? nextSchedules.findIndex((schedule) => schedule.id === converted.localScheduleId)
                : -1;
            if (existingIndex < 0) {
                existingIndex = nextSchedules.findIndex((schedule) => (
                    schedule.googleCalendarId === "primary" && schedule.googleEventId === imported.googleEventId
                ));
            }

            if (existingIndex >= 0) {
                const existing = nextSchedules[existingIndex];
                if (existing.source === "google") {
                    const updated = {
                        ...existing,
                        ...imported,
                        reminderMinutes: normalizeReminderMinutes(existing.reminderMinutes),
                        important: existing.important || imported.important
                    };
                    const hasChanged = ["date", "title", "start", "end", "important", "googleHtmlLink", "googleUpdated", "googleEtag"]
                        .some((key) => updated[key] !== existing[key]);
                    if (hasChanged) {
                        nextSchedules[existingIndex] = updated;
                        updatedCount += 1;
                    } else {
                        duplicateCount += 1;
                    }
                } else {
                    const hasNewReference = existing.googleEventId !== imported.googleEventId
                        || existing.googleHtmlLink !== imported.googleHtmlLink;
                    if (hasNewReference) {
                        nextSchedules[existingIndex] = {
                            ...existing,
                            googleCalendarId: "primary",
                            googleEventId: imported.googleEventId,
                            googleHtmlLink: imported.googleHtmlLink
                        };
                        updatedCount += 1;
                    } else {
                        duplicateCount += 1;
                    }
                }
                return;
            }

            nextSchedules.push({
                ...imported,
                id: makeImportedScheduleId(imported.googleEventId, nextSchedules),
                createdAt: new Date().toISOString()
            });
            addedCount += 1;
        });

        if (addedCount > 0 || updatedCount > 0) {
            nextSchedules.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
            schedules = nextSchedules;
            rebuildScheduleIndex();
            if (!saveSchedules()) {
                schedules = previousSchedules;
                rebuildScheduleIndex();
                throw makeGoogleError("Imported schedules could not be saved", 0, "storage_failed");
            }
            renderAllScheduleViews();
            checkAlertsAndNotifications(new Date());
        }

        return { addedCount, updatedCount, duplicateCount, allDayCount, multiDayCount, skippedCount };
    }

    async function importVisibleGoogleMonth() {
        if (!hasValidGoogleToken()) {
            clearGoogleConnectionState("Googleの接続期限が切れました。もう一度接続してください。", true);
            return;
        }

        googleImportController = new AbortController();
        updateGoogleConnectionUi();
        elements.googleImportButton.textContent = "取り込み中…";
        setGoogleStatus(`${formatMonth(viewingMonth)}の予定をGoogleから確認しています。`);

        try {
            const events = await fetchGoogleMonthEvents(googleImportController.signal);
            const result = importGoogleEvents(events);
            const notes = [
                `新規${result.addedCount}件`,
                `更新${result.updatedCount}件`,
                `取込済み${result.duplicateCount}件`
            ];
            const unsupportedCount = result.allDayCount + result.multiDayCount + result.skippedCount;
            if (unsupportedCount > 0) {
                notes.push(`対象外${unsupportedCount}件（終日${result.allDayCount}件・日またぎ${result.multiDayCount}件）`);
            }
            setGoogleStatus(`${formatMonth(viewingMonth)}：${notes.join("、")}。`);
            announce(`Googleカレンダーから${result.addedCount}件取り込みました。`);
        } catch (error) {
            if (error && error.code === "storage_failed") {
                setGoogleStatus("Google予定を読み込めましたが、このブラウザーへ保存できませんでした。", true);
            } else {
                setGoogleStatus(getGoogleErrorMessage(error, "Googleの予定を取り込めませんでした。通信状態を確認してください。"), true);
            }
        } finally {
            googleImportController = null;
            elements.googleImportButton.textContent = "表示中の月を取り込む";
            updateGoogleConnectionUi();
        }
    }

    function makeGoogleEventId(localScheduleId) {
        const safeId = String(localScheduleId).toLowerCase().replace(/[^a-v0-9]/g, "");
        return `tokeibe${safeId}`.slice(0, 1024);
    }

    async function insertScheduleIntoGoogle(schedule) {
        const eventId = makeGoogleEventId(schedule.id);
        const eventBody = {
            id: eventId,
            summary: schedule.title,
            start: {
                dateTime: `${schedule.date}T${schedule.start}:00`,
                timeZone: GOOGLE_TIME_ZONE
            },
            end: {
                dateTime: `${schedule.date}T${schedule.end}:00`,
                timeZone: GOOGLE_TIME_ZONE
            },
            extendedProperties: {
                private: {
                    tokeibeLocalId: schedule.id,
                    tokeibeVersion: "1",
                    tokeibeImportance: schedule.important ? "important" : "normal"
                }
            }
        };

        try {
            return await googleApiFetch(`${GOOGLE_CALENDAR_API}/calendars/primary/events`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(eventBody)
            });
        } catch (error) {
            if (!error || error.status !== 409) {
                throw error;
            }

            const existingEvent = await googleApiFetch(
                `${GOOGLE_CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}`
            );
            const privateProperties = existingEvent.extendedProperties && existingEvent.extendedProperties.private
                ? existingEvent.extendedProperties.private
                : {};
            if (privateProperties.tokeibeLocalId !== schedule.id) {
                throw error;
            }
            return existingEvent;
        }
    }

    /* =======================================================
       13. リマインドと現在の予定を、時計の前で知らせる
       ======================================================= */
    function makeReminderDismissalKey(schedule, reminderDate) {
        return `reminder:${reminderDate.getTime()}:${schedule.id}`;
    }

    function getDueReminderEntries(now) {
        return getNotificationCandidateSchedules(now).map((schedule) => {
            const startDate = makeScheduleStartDate(schedule);
            const reminderDate = makeReminderDate(schedule);
            return {
                schedule,
                startDate,
                reminderDate,
                dismissalKey: reminderDate ? makeReminderDismissalKey(schedule, reminderDate) : ""
            };
        }).filter((entry) => (
            entry.reminderDate
            && isNotificationTime(now, entry.reminderDate)
            && entry.startDate
            && now.getTime() < entry.startDate.getTime()
            && wasNotificationTimeAfterCreation(entry.schedule, entry.reminderDate)
            && !dismissedAlertKeys.has(entry.dismissalKey)
        )).sort((a, b) => (
            a.reminderDate - b.reminderDate
            || a.schedule.start.localeCompare(b.schedule.start)
        ));
    }

    function showReminderAlert(alertKey, reminderEntries) {
        window.clearTimeout(reminderAlertHideTimer);
        currentReminderAlertKey = alertKey;
        currentReminderDismissalKeys = reminderEntries.map((entry) => entry.dismissalKey);

        const reminderTimes = [...new Set(reminderEntries.map((entry) => (
            minutesToTime((entry.reminderDate.getHours() * 60) + entry.reminderDate.getMinutes())
        )))];
        elements.reminderAlertTitle.textContent = `${reminderTimes.join("・")}のリマインド時間になりました。`;
        elements.reminderAlertDetail.textContent = reminderEntries
            .map(({ schedule }) => `${schedule.start}〜${schedule.end}　${schedule.title}`)
            .join("\n");
        elements.reminderAlert.hidden = false;
        window.requestAnimationFrame(() => elements.reminderAlert.classList.add("is-visible"));
    }

    function hideReminderAlert() {
        elements.reminderAlert.classList.remove("is-visible");
        currentReminderAlertKey = "";
        currentReminderDismissalKeys = [];
        window.clearTimeout(reminderAlertHideTimer);
        reminderAlertHideTimer = window.setTimeout(() => {
            if (!elements.reminderAlert.classList.contains("is-visible")) {
                elements.reminderAlert.hidden = true;
            }
        }, FADE_DURATION);
    }

    function dismissReminderAlert() {
        currentReminderDismissalKeys.forEach((key) => dismissedAlertKeys.add(key));
        saveDismissedAlerts();
        hideReminderAlert();
        announce("リマインドのお知らせを閉じました。");
    }

    function checkReminderAlert(now) {
        const reminderEntries = getDueReminderEntries(now);
        if (reminderEntries.length === 0) {
            if (!elements.reminderAlert.hidden) {
                hideReminderAlert();
            }
            return;
        }

        const alertKey = reminderEntries.map((entry) => entry.dismissalKey).sort().join("|");
        if (currentReminderAlertKey !== alertKey || elements.reminderAlert.hidden) {
            showReminderAlert(alertKey, reminderEntries);
        }
    }

    function makeDismissedScheduleKey(schedule) {
        const startDate = makeScheduleStartDate(schedule);
        const startKey = startDate ? startDate.getTime() : `${schedule.date}:${schedule.start}`;
        return `start:${startKey}:${schedule.id}`;
    }

    function showScheduleAlert(alertKey, dateKey, activeSchedules) {
        window.clearTimeout(alertHideTimer);
        currentAlertKey = alertKey;
        currentAlertDateKey = dateKey;
        currentAlertSchedules = activeSchedules;
        elements.scheduleAlertDetail.textContent = activeSchedules
            .map((schedule) => `${schedule.start}〜${schedule.end}　${schedule.title}`)
            .join("\n");
        elements.scheduleAlert.hidden = false;
        window.requestAnimationFrame(() => elements.scheduleAlert.classList.add("is-visible"));
    }

    function hideScheduleAlert() {
        elements.scheduleAlert.classList.remove("is-visible");
        currentAlertKey = "";
        currentAlertDateKey = "";
        currentAlertSchedules = [];
        window.clearTimeout(alertHideTimer);
        alertHideTimer = window.setTimeout(() => {
            if (!elements.scheduleAlert.classList.contains("is-visible")) {
                elements.scheduleAlert.hidden = true;
            }
        }, FADE_DURATION);
    }

    function dismissScheduleAlert() {
        if (currentAlertDateKey && currentAlertSchedules.length > 0) {
            currentAlertSchedules.forEach((schedule) => {
                dismissedAlertKeys.add(makeDismissedScheduleKey(schedule));
            });
            saveDismissedAlerts();
        }
        hideScheduleAlert();
        announce("予定のお知らせを閉じました。");
    }

    function checkScheduleAlert(now) {
        const currentMinutes = (now.getHours() * 60) + now.getMinutes();
        const currentDateKey = toDateKey(now);
        const activeSchedules = schedulesForDate(now).filter((schedule) => (
            currentMinutes >= timeToMinutes(schedule.start)
            && currentMinutes < timeToMinutes(schedule.end)
            && !dismissedAlertKeys.has(makeDismissedScheduleKey(schedule))
        ));

        if (activeSchedules.length === 0) {
            if (!elements.scheduleAlert.hidden) {
                hideScheduleAlert();
            }
            return;
        }

        const alertKey = activeSchedules.map(makeDismissedScheduleKey).sort().join("|");

        if (currentAlertKey !== alertKey || elements.scheduleAlert.hidden) {
            showScheduleAlert(alertKey, currentDateKey, activeSchedules);
        }
    }

    function checkAlertsAndNotifications(now) {
        checkReminderAlert(now);
        checkScheduleAlert(now);
        checkBrowserNotifications(now);
    }

    /* =======================================================
       14. 画面をまとめて更新する処理
       ======================================================= */
    function renderAllScheduleViews() {
        renderCalendar();
        renderClockSchedules();
        renderTodayScheduleList();
    }

    function announce(message) {
        elements.liveStatus.textContent = "";
        window.requestAnimationFrame(() => {
            elements.liveStatus.textContent = message;
        });
    }

    function tick() {
        const now = new Date();
        const todayKey = toDateKey(now);
        if (!document.hidden) {
            updateClockHands(now);
        }
        checkAlertsAndNotifications(now);

        // 日付をまたいだ場合は、今日の印と一覧を自動で更新します。
        if (todayKey !== lastKnownTodayKey) {
            const wasShowingToday = toDateKey(selectedDate) === lastKnownTodayKey;
            lastKnownTodayKey = todayKey;

            // それまで今日を見ていた場合だけ、新しい今日へ時計を進めます。
            if (wasShowingToday) {
                selectedDate = startOfDay(now);
                viewingMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            }

            renderAllScheduleViews();
        }
    }

    function scheduleNextTick() {
        window.clearTimeout(tickTimer);
        // ページが後ろにある間も、軽い確認を1分に1回だけ続けます。
        const millisecondsUntilNextMinute = 60000 - (Date.now() % 60000) + 40;
        tickTimer = window.setTimeout(() => {
            tick();
            scheduleNextTick();
        }, millisecondsUntilNextMinute);
    }

    /* =======================================================
       15. ボタンを押したときの動きを結びつける
       ======================================================= */
    function registerEvents() {
        elements.themeToggle.addEventListener("click", toggleTheme);
        elements.previousMonthButton.addEventListener("click", () => moveMonth(-1));
        elements.nextMonthButton.addEventListener("click", () => moveMonth(1));
        elements.todayButton.addEventListener("click", returnToToday);
        elements.centralAddButton.addEventListener("click", () => openScheduleModal());
        elements.amButton.addEventListener("click", () => {
            selectedPeriod = "am";
            updatePeriodButtons();
        });
        elements.pmButton.addEventListener("click", () => {
            selectedPeriod = "pm";
            updatePeriodButtons();
        });
        elements.popoverAddButton.addEventListener("click", () => {
            openScheduleModal({ hour: selectedHour, period: selectedPeriod });
        });
        elements.reminderAlertClose.addEventListener("click", dismissReminderAlert);
        elements.scheduleAlertClose.addEventListener("click", dismissScheduleAlert);
        elements.notificationPermissionButton.addEventListener("click", requestBrowserNotificationPermission);
        elements.modalCloseButton.addEventListener("click", () => closeScheduleModal());
        elements.formCancelButton.addEventListener("click", () => closeScheduleModal());
        elements.scheduleForm.addEventListener("submit", submitSchedule);
        elements.googleConnectButton.addEventListener("click", connectGoogleCalendar);
        elements.googleImportButton.addEventListener("click", importVisibleGoogleMonth);
        elements.googleDisconnectButton.addEventListener("click", disconnectGoogleCalendar);
        elements.scheduleModal.addEventListener("click", (event) => {
            if (event.target === elements.scheduleModal) {
                closeScheduleModal();
            }
        });

        document.addEventListener("click", (event) => {
            if (
                elements.hourPopover.classList.contains("is-visible")
                && !elements.hourPopover.contains(event.target)
                && !event.target.closest(".hour-button")
            ) {
                closeHourPopover();
            }

            /* スマホで開いた予定タイトルは、カレンダーの外を押すと閉じます。 */
            if (
                !event.target.closest(".calendar-day")
                && document.activeElement
                && document.activeElement.classList.contains("calendar-day")
            ) {
                document.activeElement.blur();
            }
        });

        document.addEventListener("keydown", (event) => {
            keepFocusInsideModal(event);
            if (event.key !== "Escape") {
                return;
            }

            if (!elements.scheduleModal.hidden) {
                closeScheduleModal();
            } else if (elements.hourPopover.classList.contains("is-visible")) {
                closeHourPopover(true);
            } else if (!elements.reminderAlert.hidden) {
                dismissReminderAlert();
            } else if (!elements.scheduleAlert.hidden) {
                dismissScheduleAlert();
            } else if (
                document.activeElement
                && document.activeElement.classList.contains("calendar-day")
            ) {
                document.activeElement.blur();
            }
        });

        window.addEventListener("resize", positionHourPopover);
        window.addEventListener("storage", (event) => {
            if (event.key === NOTIFICATION_HISTORY_KEY) {
                syncNotificationHistory();
            } else if (event.key === STORAGE_KEY) {
                /* 別タブで増減した予定も、表示と通知の両方へすぐ反映します。 */
                schedules = loadSchedules();
                rebuildScheduleIndex();
                renderAllScheduleViews();
                checkAlertsAndNotifications(new Date());
            }
        });
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) {
                updateBrowserNotificationUi();
                tick();
                scheduleNextTick();
            }
        });
    }

    /* =======================================================
       16. アプリを開始する
       ======================================================= */
    function init() {
        applyTheme(getInitialTheme());
        updateBrowserNotificationUi();
        if (canUseBrowserNotifications() && window.Notification.permission === "granted") {
            void prepareNotificationServiceWorker();
        }
        updateGoogleConnectionUi();
        if (!canUseGoogleOAuthOnCurrentOrigin()) {
            setGoogleStatus("Google連携を使うときは、localhostまたはHTTPSでこのページを開いてください。");
        } else if (!isGoogleClientIdConfigured()) {
            setGoogleStatus("Googleカレンダー連携は準備中です。予定管理はそのまま使えます。");
        } else {
            setGoogleStatus("「Googleカレンダーと連携」を押すと、Googleの正式な許可画面が開きます。");
        }
        buildHourButtons();
        registerEvents();
        renderAllScheduleViews();
        tick();
        scheduleNextTick();
    }

    init();
}());
