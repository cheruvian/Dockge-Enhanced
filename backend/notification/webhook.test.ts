import test from "node:test";
import assert from "node:assert/strict";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { AddressInfo } from "node:net";
import { deliverMonitoringWebhooks, monitoringNotification, validateMonitoringWebhooks } from "./webhook";

async function receiver(handler: (req: IncomingMessage, res: ServerResponse) => void, run: (url: string) => Promise<void>) {
    const server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/event`);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

test("validates explicit private HTTP and public HTTPS destinations without losing URL tokens", () => {
    assert.deepEqual(validateMonitoringWebhooks([{ url: "http://n8n:5678/webhook/test?token=abc" }]), [{ url: "http://n8n:5678/webhook/test?token=abc" }]);
    for (const value of [ null, [{}], [{ url: "file:///tmp/out" }], [{ url: "https://user:password@example.test" }], [{ url: "https://example.test/#fragment" }], Array(6).fill({ url: "https://example.test" }), [{ url: "https://example.test",
        secret: 5 }]]) {
        assert.throws(() => validateMonitoringWebhooks(value));
    }
});

test("posts the event JSON with verifiable signature and a stable event ID across retries", async () => {
    const event = monitoringNotification("container.unhealthy", "heihei", { containerName: "n8n",
        action: "notify" });
    const received: string[] = [];
    await receiver((req, res) => {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            assert.equal(req.method, "POST");
            assert.equal(req.headers["x-dockge-event-id"], event.id);
            assert.equal(req.headers["x-dockge-signature"], "sha256=" + createHmac("sha256", "test-secret").update(req.headers["x-dockge-timestamp"] + "." + body).digest("hex"));
            received.push(body);
            res.writeHead(received.length === 1 ? 503 : 204).end();
        });
    }, async url => {
        const results = await deliverMonitoringWebhooks([{ url,
            secret: "test-secret" }], event);
        assert.deepEqual(results, [{ destination: 0,
            ok: true,
            attempts: 2,
            status: 204 }]);
    });
    assert.equal(received.length, 2);
    assert.equal(received[0], received[1]);
    assert.deepEqual(JSON.parse(received[0]), event);
});

test("does not follow redirects or retry permanent errors; destinations are independent", async () => {
    let requests = 0;
    await receiver((_req, res) => {
        requests++;
        res.writeHead(302, { location: "/secret-target" }).end();
    }, async redirect => {
        await receiver((_req, res) => res.writeHead(401).end(), async forbidden => {
            const results = await deliverMonitoringWebhooks([{ url: redirect }, { url: forbidden }], monitoringNotification("notification.test", "", {}));
            assert.deepEqual(results.map(r => [ r.ok, r.attempts, r.status ]), [[ false, 1, 302 ], [ false, 1, 401 ]]);
        });
    });
    assert.equal(requests, 1);
});

test("stops retrying after three transient failures", async () => {
    let attempts = 0;
    await receiver((_req, res) => {
        attempts++;
        res.writeHead(503).end();
    }, async url => {
        assert.deepEqual(await deliverMonitoringWebhooks([{ url }], monitoringNotification("container.crash_loop", "", {})), [{ destination: 0,
            ok: false,
            attempts: 3,
            status: 503 }]);
    });
    assert.equal(attempts, 3);
});
