import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import type { DockgeServer } from "../dockge-server";

const data = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-monitor-api-"));
process.env.DOCKGE_DATA_DIR = data;
process.env.DOCKGE_AUTH_MODE = "local";
const { MonitoringRouter } = await import("./monitoring-router");
const { MonitoringWatcher } = await import("../watchers/monitoring-watcher");
const { Settings } = await import("../settings");
Settings.get = (async () => "test-host") as typeof Settings.get;
const watcher = MonitoringWatcher.getInstance();
// Exercise settings persistence without starting unrelated Docker/history collectors.
watcher.startIfEnabled = async () => watcher.loadSettings();

test("authenticated API validates, persists and tests saved webhook destinations", async () => {
    const received: unknown[] = [];
    const receiver = createServer((req, res) => {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            received.push(JSON.parse(body));
            res.writeHead(204).end();
        });
    });
    await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
    const secret = randomBytes(32).toString("hex");
    const app = express();
    app.use(new MonitoringRouter().create(app, { jwtSecret: secret } as DockgeServer));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { authorization: "Bearer " + jwt.sign({ username: "test" }, secret),
        "content-type": "application/json" };
    try {
        assert.equal((await fetch(base + "/api/monitoring/webhooks/test", { method: "POST" })).status, 401);
        const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/receive`;
        const saved = await fetch(base + "/api/monitoring/settings", { method: "POST",
            headers,
            body: JSON.stringify({ webhooks: [{ url }] }) });
        assert.equal(saved.status, 200);
        assert.equal((await fs.stat(path.join(data, "monitoring-settings.json"))).mode & 0o777, 0o600);
        const invalid = await fetch(base + "/api/monitoring/settings", { method: "POST",
            headers,
            body: JSON.stringify({ webhooks: [{ url: "file:///tmp/out" }] }) });
        assert.equal(invalid.status, 400);
        assert.equal(watcher.settings.webhooks[0].url, url);
        const result = await fetch(base + "/api/monitoring/webhooks/test", { method: "POST",
            headers });
        assert.equal(result.status, 200);
        assert.equal((await result.json() as { ok: boolean }).ok, true);
        assert.equal(received.length, 1);
        assert.equal((received[0] as { type: string }).type, "notification.test");
    } finally {
        await Promise.all([ new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => receiver.close(() => resolve())) ]);
        await fs.rm(data, { recursive: true,
            force: true });
    }
});
