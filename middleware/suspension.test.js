// Run: node --test middleware/suspension.test.js
// Tests that requireAdmin and requireNgo correctly block suspended users.
// No real DB needed — User.findOne is stubbed with controlled responses.
const test = require("node:test");
const assert = require("node:assert");

// ── Stub User.findOne ───────────────────────────────────────────────────
// We replace User.findOne with a function that returns a fake Mongoose query
// object (.select().lean() etc.) resolving to whatever `_nextUser` is set to.
let _nextUser = null;
function setNextUser(doc) { _nextUser = doc; }

const fakeQuery = () => ({
    select() { return this; },
    lean() { return this; },
    then(resolve, reject) {
        return Promise.resolve(_nextUser).then(resolve, reject);
    },
    catch(fn) { return Promise.resolve(_nextUser).catch(fn); }
});

const userModelPath = require.resolve("../Models/usermodel");
require.cache[userModelPath] = {
    id: userModelPath, filename: userModelPath, loaded: true,
    exports: { findOne: () => fakeQuery() }
};

// Now require the real middleware (they import the stubbed User model).
const requireAdmin = require("./requireAdmin");
const requireNgo = require("./requireNgo");

// ── Helper: run middleware and capture status + body ─────────────────────
function runMiddleware(mw, req) {
    return new Promise((resolve) => {
        let statusCode = null;
        let resBody = null;
        let nextCalled = false;

        const res = {
            status(code) { statusCode = code; return res; },
            json(body) { resBody = body; resolve({ statusCode, body: resBody || body, nextCalled }); }
        };
        const next = () => { nextCalled = true; resolve({ statusCode: null, body: null, nextCalled: true }); };

        mw(req, res, next);
    });
}

// ── requireAdmin tests ──────────────────────────────────────────────────

test("requireAdmin: active admin → allowed", async () => {
    setNextUser({ uid: "admin1", role: "admin", email: "a@b.co", isSuspended: false });
    const result = await runMiddleware(requireAdmin, { authUid: "admin1" });
    assert.strictEqual(result.nextCalled, true, "next() should be called");
});

test("requireAdmin: suspended admin → 403", async () => {
    setNextUser({ uid: "admin1", role: "admin", email: "a@b.co", isSuspended: true });
    const result = await runMiddleware(requireAdmin, { authUid: "admin1" });
    assert.strictEqual(result.statusCode, 403);
    assert.ok(result.body.message.includes("suspended"), `message should mention suspended, got: ${result.body.message}`);
    assert.strictEqual(result.nextCalled, false);
});

test("requireAdmin: missing user → 403 Forbidden", async () => {
    setNextUser(null);
    const result = await runMiddleware(requireAdmin, { authUid: "ghost" });
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.nextCalled, false);
});

test("requireAdmin: role mismatch (ngo_admin calling admin route) → 403", async () => {
    setNextUser({ uid: "ngo1", role: "ngo_admin", email: "n@b.co", isSuspended: false });
    const result = await runMiddleware(requireAdmin, { authUid: "ngo1" });
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.nextCalled, false);
});

test("requireAdmin: no authUid → 401", async () => {
    const result = await runMiddleware(requireAdmin, {});
    assert.strictEqual(result.statusCode, 401);
    assert.strictEqual(result.nextCalled, false);
});

// ── requireNgo tests ────────────────────────────────────────────────────

test("requireNgo: active ngo_admin → allowed", async () => {
    setNextUser({ uid: "ngo1", role: "ngo_admin", email: "n@b.co", ngoId: "aaa", isSuspended: false });
    const result = await runMiddleware(requireNgo, { authUid: "ngo1", method: "GET" });
    assert.strictEqual(result.nextCalled, true);
});

test("requireNgo: suspended ngo_admin → 403", async () => {
    setNextUser({ uid: "ngo1", role: "ngo_admin", email: "n@b.co", ngoId: "aaa", isSuspended: true });
    const result = await runMiddleware(requireNgo, { authUid: "ngo1", method: "GET" });
    assert.strictEqual(result.statusCode, 403);
    assert.ok(result.body.message.includes("suspended"));
    assert.strictEqual(result.nextCalled, false);
});

test("requireNgo: active ngo_member → allowed", async () => {
    setNextUser({ uid: "m1", role: "ngo_member", email: "m@b.co", ngoId: "bbb", isSuspended: false });
    const result = await runMiddleware(requireNgo, { authUid: "m1", method: "GET" });
    assert.strictEqual(result.nextCalled, true);
});

test("requireNgo: suspended ngo_member → 403", async () => {
    setNextUser({ uid: "m1", role: "ngo_member", email: "m@b.co", ngoId: "bbb", isSuspended: true });
    const result = await runMiddleware(requireNgo, { authUid: "m1", method: "GET" });
    assert.strictEqual(result.statusCode, 403);
    assert.ok(result.body.message.includes("suspended"));
    assert.strictEqual(result.nextCalled, false);
});

test("requireNgo: missing user → 403", async () => {
    setNextUser(null);
    const result = await runMiddleware(requireNgo, { authUid: "ghost", method: "GET" });
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.nextCalled, false);
});

test("requireNgo: role mismatch (regular user) → 403", async () => {
    setNextUser({ uid: "u1", role: "user", email: "u@b.co", isSuspended: false });
    const result = await runMiddleware(requireNgo, { authUid: "u1", method: "GET" });
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.nextCalled, false);
});

test("requireNgo: no authUid → 401", async () => {
    const result = await runMiddleware(requireNgo, { method: "GET" });
    assert.strictEqual(result.statusCode, 401);
    assert.strictEqual(result.nextCalled, false);
});

test("requireNgo: OPTIONS method → always allowed (CORS preflight)", async () => {
    // OPTIONS should bypass all checks
    setNextUser(null); // even with no user
    const result = await runMiddleware(requireNgo, { method: "OPTIONS" });
    assert.strictEqual(result.nextCalled, true);
});
