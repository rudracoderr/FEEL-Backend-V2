/**
 * Security regression test for requireAuth middleware.
 *
 * Verifies that:
 *  1. A valid Firebase ID token is accepted.
 *  2. A missing Authorization header is rejected with 401.
 *  3. An invalid / non-Firebase token is rejected with 401.
 *  4. Authorization: Mock <uid> is REJECTED with 401 (bypass removed).
 *
 * Run: node middleware/requireAuth.test.js
 * (No external test-runner dependency — plain Node assertions.)
 */

"use strict";

// ---------------------------------------------------------------------------
// Minimal mock for firebase-admin module
// ---------------------------------------------------------------------------
const VALID_TOKEN = "valid-firebase-token-abc123";
const VALID_UID   = "firebase-user-uid-xyz";

const mockAdmin = {
    isFirebaseAdminInitialized: () => true,
    auth: () => ({
        verifyIdToken: async (token) => {
            if (token === VALID_TOKEN) return { uid: VALID_UID };
            const err = new Error("Token invalid");
            err.code = "auth/argument-error";
            throw err;
        }
    })
};

// Patch require cache before loading the middleware
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "../firebase-admin") return mockAdmin;
    if (request === "../Models/usermodel") {
        return { updateOne: () => ({ catch: () => {} }) };
    }
    return originalLoad.apply(this, arguments);
};

const requireAuth = require("./requireAuth");
Module._load = originalLoad; // restore

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function makeReqRes(authorizationHeader) {
    const req = {
        method: "GET",
        headers: { authorization: authorizationHeader }
    };
    const res = {
        _status: null,
        _body: null,
        status(code) { this._status = code; return this; },
        json(body)   { this._body  = body; return this; }
    };
    return { req, res };
}

async function assert(label, fn) {
    try {
        await fn();
        console.log(`  PASS: ${label}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL: ${label}`);
        console.error(`        ${e.message}`);
        failed++;
    }
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
(async () => {
    console.log("\n=== requireAuth Security Tests ===\n");

    // 1. Valid Firebase Bearer token -> should call next()
    await assert("Valid Firebase token is accepted", async () => {
        const { req, res } = makeReqRes(`Bearer ${VALID_TOKEN}`);
        let nextCalled = false;
        await requireAuth(req, res, () => { nextCalled = true; });
        if (!nextCalled) throw new Error("next() was not called");
        assertEqual(req.authUid, VALID_UID, "authUid mismatch");
        if (res._status !== null) throw new Error(`Expected no response, got status ${res._status}`);
    });

    // 2. Missing Authorization header -> 401
    await assert("Missing Authorization header is rejected (401)", async () => {
        const { req, res } = makeReqRes(undefined);
        let nextCalled = false;
        await requireAuth(req, res, () => { nextCalled = true; });
        if (nextCalled) throw new Error("next() must NOT be called");
        assertEqual(res._status, 401, "Expected HTTP 401");
    });

    // 3. Invalid / garbage token -> 401
    await assert("Invalid token string is rejected (401)", async () => {
        const { req, res } = makeReqRes("Bearer not-a-real-firebase-token");
        let nextCalled = false;
        await requireAuth(req, res, () => { nextCalled = true; });
        if (nextCalled) throw new Error("next() must NOT be called");
        assertEqual(res._status, 401, "Expected HTTP 401");
    });

    // 4. Mock <uid> header -> MUST be rejected (bypass removed)
    await assert("Authorization: Mock <uid> is REJECTED (401) - bypass removed", async () => {
        const { req, res } = makeReqRes("Mock some-dev-uid");
        let nextCalled = false;
        await requireAuth(req, res, () => { nextCalled = true; });
        if (nextCalled) throw new Error("SECURITY FAILURE: Mock auth bypass still works - next() was called");
        assertEqual(res._status, 401, "Expected HTTP 401");
        if (req.authUid) throw new Error(`SECURITY FAILURE: req.authUid was set to '${req.authUid}' via Mock header`);
    });

    // 5. OPTIONS preflight -> always passes (CORS)
    await assert("OPTIONS preflight is always passed through", async () => {
        const { req, res } = makeReqRes(undefined);
        req.method = "OPTIONS";
        let nextCalled = false;
        await requireAuth(req, res, () => { nextCalled = true; });
        if (!nextCalled) throw new Error("next() must be called for OPTIONS");
    });

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
