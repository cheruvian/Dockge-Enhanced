import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const data = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-monitor-webhook-"));
process.env.DOCKGE_DATA_DIR = data;
const { MonitoringWatcher } = await import("./monitoring-watcher");
const watcher = MonitoringWatcher.getInstance();

test("unhealthy and crash-loop events reach generic webhooks without another provider, retaining cooldowns", async () => {
    const events: Array<{ type: string;
        data: Record<string, unknown> }> = [];
    watcher.sendWebhookNotification = async (type, data) => {
        events.push({ type,
            data });
        return [];
    };
    watcher.settings.crashLoopEnabled = true;
    watcher.settings.crashLoopThreshold = 2;
    const internal = watcher as unknown as {
        onContainerDie(name: string, id: string): void;
        onContainerUnhealthy(event: object, name: string, id: string): Promise<void>;
    };
    internal.onContainerDie("app", "one");
    assert.equal(events.length, 0);
    internal.onContainerDie("app", "one");
    assert.equal(events[0].type, "container.crash_loop");
    internal.onContainerDie("app", "one");
    internal.onContainerDie("app", "one");
    assert.equal(events.length, 1);
    await internal.onContainerUnhealthy({ Actor: { Attributes: { "com.docker.compose.project": "photos",
        "com.docker.compose.service": "api" } } }, "photos-api", "two");
    await internal.onContainerUnhealthy({}, "photos-api", "two");
    assert.equal(events.length, 2);
    assert.equal(events[1].type, "container.unhealthy");
    assert.equal(events[1].data.action, "notify");
    assert.equal(events[1].data.stackName, "photos");
});

test.after(async () => {
    // Event history writes are asynchronous in the watcher.
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.rm(data, { recursive: true,
        force: true });
});
