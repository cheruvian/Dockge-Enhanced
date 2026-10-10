import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { DockgeServer } from "./dockge-server";
import { StackGitService } from "./stack-git-service";

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-git-"));
    t.after(() => fs.rm(root, { recursive: true,
        force: true }));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root,
        encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Git fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", "/dev/null");
    for (const name of [ "minecraft", "nextcloud" ]) {
        await fs.mkdir(path.join(root, name));
        await fs.writeFile(path.join(root, name, "compose.yaml"), "services:\n  app:\n    image: alpine:latest\n");
    }
    git("add", ".");
    git("commit", "-q", "-m", "Initial stacks");
    const server = {
        stacksDir: root,
        externalStacks: { get: async () => null },
    } as unknown as DockgeServer;
    return { root,
        git,
        service: new StackGitService(server) };
}

test("a stack commit preserves staged changes from sibling stacks", async (t) => {
    const { root, git, service } = await fixture(t);
    await fs.writeFile(path.join(root, "nextcloud", "README.md"), "Staged sibling version\n");
    git("add", "nextcloud/README.md");
    const stagedSibling = git("show", ":nextcloud/README.md");
    await fs.writeFile(path.join(root, "nextcloud", "README.md"), "Unstaged sibling version\n");
    await fs.writeFile(path.join(root, "minecraft", "README.md"), "Selected stack change\n");
    await service.commit("minecraft", "Update Minecraft");

    assert.deepEqual(git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n"), [ "minecraft/README.md" ]);
    assert.equal(git("show", ":nextcloud/README.md"), stagedSibling);
    assert.equal(await fs.readFile(path.join(root, "nextcloud", "README.md"), "utf8"), "Unstaged sibling version\n");
    assert.equal(git("diff", "--cached", "--name-only"), "nextcloud/README.md");
});

test("a stack with no changes cannot commit staged sibling changes", async (t) => {
    const { root, git, service } = await fixture(t);
    const head = git("rev-parse", "HEAD");
    await fs.writeFile(path.join(root, "nextcloud", "README.md"), "Sibling change\n");
    git("add", "nextcloud/README.md");

    await assert.rejects(service.commit("minecraft", "Nothing to commit"), /No safe Git change to commit/);

    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(git("diff", "--cached", "--name-only"), "nextcloud/README.md");
});

test("sensitive files in a sibling stack do not block a selected stack commit", async (t) => {
    const { root, git, service } = await fixture(t);
    await fs.writeFile(path.join(root, "nextcloud", ".env"), "FIXTURE=not-a-secret\n");
    await fs.writeFile(path.join(root, "minecraft", "README.md"), "Minecraft change\n");

    await service.commit("minecraft", "Update Minecraft");

    assert.equal(git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "minecraft/README.md");
    assert.equal(git("status", "--porcelain"), "?? nextcloud/.env");
});

test("sensitive files in the selected stack remain blocked", async (t) => {
    const { root, git, service } = await fixture(t);
    const head = git("rev-parse", "HEAD");
    await fs.writeFile(path.join(root, "minecraft", ".env"), "FIXTURE=not-a-secret\n");
    await fs.writeFile(path.join(root, "minecraft", "README.md"), "Minecraft change\n");

    await assert.rejects(service.commit("minecraft", "Update Minecraft"), /Sensitive files must be removed or ignored/);

    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(git("diff", "--cached", "--name-only"), "");
});
