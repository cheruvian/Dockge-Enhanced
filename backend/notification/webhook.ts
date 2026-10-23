import { createHmac, randomUUID } from "node:crypto";
import axios from "axios";

export interface MonitoringWebhook {
    url: string;
    secret?: string;
}

export interface MonitoringNotification {
    schemaVersion: 1;
    id: string;
    type: "container.unhealthy" | "container.crash_loop" | "notification.test";
    timestamp: string;
    source: "dockge-enhanced";
    hostname: string;
    data: Record<string, unknown>;
}

export function validateMonitoringWebhooks(value: unknown): MonitoringWebhook[] {
    if (!Array.isArray(value) || value.length > 5) {
        throw new Error("webhooks must be an array of at most five destinations");
    }
    return value.map(item => {
        if (!item || typeof item.url !== "string" || item.url.length > 4096) {
            throw new Error("Each webhook requires an HTTP(S) URL");
        }
        let url: URL;
        try {
            url = new URL(item.url);
        } catch {
            throw new Error("Each webhook requires an HTTP(S) URL");
        }
        if (![ "http:", "https:" ].includes(url.protocol) || url.username || url.password || url.hash) {
            throw new Error("Webhook URLs must use HTTP(S), without userinfo or fragments");
        }
        if (item.secret !== undefined && (typeof item.secret !== "string" || item.secret.length > 4096)) {
            throw new Error("Webhook secret must be a string of at most 4096 characters");
        }
        return { url: url.toString(),
            ...(item.secret ? { secret: item.secret } : {}) };
    });
}

export function monitoringNotification(type: MonitoringNotification["type"], hostname: string, data: Record<string, unknown>): MonitoringNotification {
    return { schemaVersion: 1,
        id: randomUUID(),
        type,
        timestamp: new Date().toISOString(),
        source: "dockge-enhanced",
        hostname,
        data };
}

export interface WebhookDelivery {
    destination: number;
    ok: boolean;
    attempts: number;
    status?: number;
}

/** Explicit operator-selected destinations may be on the private LAN. Never follow redirects. */
export async function deliverMonitoringWebhooks(destinations: MonitoringWebhook[], event: MonitoringNotification): Promise<WebhookDelivery[]> {
    const body = JSON.stringify(event);
    return Promise.all(destinations.map(async (destination, index) => {
        let status: number | undefined;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const timestamp = String(Math.floor(Date.now() / 1000));
            const headers: Record<string, string> = {
                "Content-Type": "application/json",
                "X-Dockge-Event-Id": event.id,
                "X-Dockge-Timestamp": timestamp,
            };
            if (destination.secret) {
                headers["X-Dockge-Signature"] = "sha256=" + createHmac("sha256", destination.secret).update(timestamp + "." + body).digest("hex");
            }
            try {
                const response = await axios.post(destination.url, body, {
                    headers,
                    timeout: 5000,
                    maxRedirects: 0,
                    maxContentLength: 64 * 1024,
                    validateStatus: () => true,
                    proxy: false,
                });
                status = response.status;
                if (status >= 200 && status < 300) {
                    return { destination: index,
                        ok: true,
                        attempts: attempt,
                        status };
                }
                if (status !== 429 && status < 500) {
                    return { destination: index,
                        ok: false,
                        attempts: attempt,
                        status };
                }
            } catch {
                // Do not log Axios errors: they contain destination tokens and signing headers.
                status = undefined;
            }
            if (attempt < 3) {
                await new Promise(resolve => setTimeout(resolve, attempt * 1000));
            }
        }
        return { destination: index,
            ok: false,
            attempts: 3,
            status };
    }));
}
