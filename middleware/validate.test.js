// Run: node --test middleware/
// Mounts the REAL routers behind the REAL sanitize middleware with auth stubbed.
// Every request asserted here must be rejected (400) before any DB access, so no DB is needed.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const express = require("express");
const mongoSanitize = require("express-mongo-sanitize");

// Stub auth so the routes' own validation is what we exercise.
const authPath = require.resolve("./requireAuth");
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: (req, res, next) => { req.authUid = "u1"; next(); } };
for (const name of ["requireActiveUser", "requireNgo"]) {
    const p = require.resolve(`./${name}`);
    require.cache[p] = { id: p, filename: p, loaded: true, exports: (req, res, next) => { req.activeUser = {}; req.ngoUser = { uid: "u1", ngoId: "000000000000000000000001" }; next(); } };
}
const nsPath = require.resolve("../Services/notification-service");
require.cache[nsPath] = { id: nsPath, filename: nsPath, loaded: true, exports: {} };

const app = express();
// Test-only: trust one proxy hop so each request can present its own client IP via X-Forwarded-For.
// The production limiter (1h window, max 5) is untouched; tests just use distinct rate-limit keys.
app.set("trust proxy", 1);
app.use(express.json());
app.use(mongoSanitize());
app.use("/api/reports", require("../Routes/report-routes"));
app.use("/api/users", require("../Routes/users-routes"));
app.use("/api/adoptions", require("../Routes/adoption-routes"));
app.use("/api/ngo", require("../Routes/ngo-routes"));
app.use("/api/notifications", require("../Routes/notification-routes"));

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

let ipCounter = 0;
const call = (method, url, body, ip = `10.0.0.${++ipCounter}`) => fetch(base + url, {
    method, headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: body ? JSON.stringify(body) : undefined
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const ID = "507f1f77bcf86cd799439011";
const validReport = {
    title: "Dog", description: "Injured dog", reporterName: "A", reporterContact: "123",
    imageUrls: ["http://x/y.jpg"], location: { type: "Point", coordinates: [77.1, 28.6] }
};

const rejected = [
    ["GET", "/api/reports?limit=1000", null, "excessive limit"],
    ["GET", "/api/reports?page=0", null, "page 0"],
    ["GET", "/api/reports?page=-3", null, "negative page"],
    ["GET", "/api/reports?lat=999&lng=0&radius=5", null, "bad lat"],
    ["GET", "/api/reports?lat=0&lng=999&radius=5", null, "bad lng"],
    ["GET", "/api/reports?lat=0&lng=0&radius=-5", null, "negative radius"],
    ["GET", "/api/reports?status=bogus", null, "invalid enum"],
    ["GET", "/api/reports?status[$ne]=pending", null, "$ne in query (object, not enum)"],
    ["GET", "/api/reports?assistanceAcceptedBy[$ne]=x", null, "$ne operator object"],
    ["GET", "/api/reports?assistanceAcceptedBy[$regex]=.*", null, "$regex operator object"],
    ["GET", "/api/reports?assistanceAcceptedBy[$gt]=", null, "$gt operator object"],
    ["GET", "/api/reports?assistanceAcceptedBy[$in][]=a", null, "$in operator object"],
    ["GET", "/api/reports/not-an-id", null, "malformed ObjectId"],
    ["PATCH", "/api/reports/xyz/accept", {}, "malformed ObjectId (patch)"],
    ["DELETE", `/api/reports/${ID}/transfers/xyz`, null, "malformed transferId"],
    ["POST", "/api/reports", { ...validReport, title: { $ne: null } }, "operator object as title"],
    ["POST", "/api/reports", { ...validReport, title: "a".repeat(201) }, "long title"],
    ["POST", "/api/reports", { ...validReport, description: "a".repeat(100000) }, "huge description"],
    ["POST", "/api/reports", { ...validReport, title: 123 }, "number title"],
    ["POST", "/api/reports", { ...validReport, severity: "Nuclear" }, "bad severity"],
    ["POST", "/api/reports", { ...validReport, location: { coordinates: [0, 91] } }, "lat > 90"],
    ["POST", "/api/reports", { ...validReport, location: { coordinates: [181, 0] } }, "lng > 180"],
    ["POST", "/api/reports", { ...validReport, location: { coordinates: ["a", "b"] } }, "non-numeric coords"],
    ["POST", "/api/reports", { ...validReport, location: { coordinates: { $gt: 0 } } }, "operator coords"],
    ["POST", "/api/reports", { ...validReport, imageUrls: "str" }, "imageUrls not array"],
    ["PUT", `/api/reports/${ID}`, { title: ["x"] }, "array title on update"],
    ["POST", `/api/reports/${ID}/transfers`, { ngoId: { $ne: null } }, "operator ngoId"],
    ["POST", `/api/reports/${ID}/transfers`, { ngoId: "bad" }, "malformed ngoId"],
    ["PATCH", `/api/reports/${ID}/progress`, { progress: { $ne: 1 } }, "operator progress"],
    ["POST", "/api/users", { email: "not-an-email", location: { coordinates: [1, 1] } }, "bad email"],
    ["POST", "/api/users", { email: "a@b.co", fullName: "x".repeat(101), location: { coordinates: [1, 1] } }, "long name"],
    ["POST", "/api/users", { email: { $ne: "" }, location: { coordinates: [1, 1] } }, "operator email"],
    ["POST", "/api/users", { email: "a@b.co", phone: "abc<script>", location: { coordinates: [1, 1] } }, "bad phone"],
    ["POST", "/api/users", { email: "a@b.co", location: { coordinates: [200, 1] } }, "user bad lng"],
    ["PATCH", "/api/users/u1/device-token", { deviceToken: { $ne: 1 } }, "operator deviceToken"],
    ["PATCH", "/api/users/u1/availability", { isAvailable: true, location: { coordinates: [0, 100] } }, "availability bad lat"],
    ["POST", "/api/adoptions", { animalName: { $ne: 1 } }, "operator animalName"],
    ["POST", "/api/adoptions", { description: "a".repeat(3001) }, "long adoption description"],
    ["POST", `/api/adoptions/${ID}/apply`, { reason: { $gt: "" }, experience: "e", livingSituation: "l", phone: "1" }, "operator form answer"],
    ["POST", "/api/adoptions/bad/apply", {}, "malformed listing id"],
    ["PATCH", "/api/adoptions/applications/bad/approve", {}, "malformed application id"],
    ["GET", "/api/notifications?limit=500", null, "notif limit"],
    ["GET", "/api/notifications?page=abc", null, "notif page"],
    ["PATCH", "/api/notifications/bad/read", null, "malformed notification id"],
    ["GET", "/api/ngo/transfers?status[$ne]=x", null, "ngo status operator"],
    ["GET", "/api/ngo/transfers?status=weird", null, "ngo status enum"],
    ["PATCH", "/api/ngo/transfers/bad/accept", {}, "malformed transfer id"],
    ["PATCH", `/api/ngo/transfers/${ID}/reject`, { remarks: { $ne: 1 } }, "operator remarks"],
    ["PATCH", `/api/ngo/transfers/${ID}/close`, { closureRemarks: "x".repeat(1001) }, "long closure remarks"]
];

for (const [method, url, body, label] of rejected) {
    test(`400: ${label}`, async () => {
        const r = await call(method, url, body);
        assert.strictEqual(r.status, 400, `${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
        assert.ok(r.body.message);
    });
}

test("createReportLimiter: 5 per client per window, 6th gets 429 with existing response shape", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 5; i++) {
        const r = await call("POST", "/api/reports", { ...validReport, title: 123 }, ip);
        assert.strictEqual(r.status, 400, `request ${i + 1}`);
    }
    const blocked = await call("POST", "/api/reports", { ...validReport, title: 123 }, ip);
    assert.strictEqual(blocked.status, 429);
    assert.deepStrictEqual(blocked.body, { success: false, message: "Too many reports submitted. Please try again in an hour." });
    // A different client is unaffected (keyed per IP).
    const other = await call("POST", "/api/reports", { ...validReport, title: 123 }, "203.0.113.51");
    assert.strictEqual(other.status, 400);
});

test("validation error shape is consistent", async () => {
    const r = await call("GET", "/api/reports?limit=1000");
    assert.strictEqual(r.body.message, "Validation failed");
    assert.ok(Array.isArray(r.body.errors) && r.body.errors[0].field === "limit");
});

test("mongoSanitize strips $ keys and dotted keys from body/query", async () => {
    const probe = express();
    probe.use(express.json());
    probe.use(mongoSanitize());
    probe.post("/p", (req, res) => res.json({ body: req.body, query: req.query }));
    const s = probe.listen(0);
    const r = await fetch(`http://127.0.0.1:${s.address().port}/p?a[$ne]=1&b=ok`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: { $gt: "" }, "y.z": 1, ok: "fine", nested: { $where: "1" } })
    }).then(r => r.json());
    s.close();
    assert.deepStrictEqual(r.query, { a: {}, b: "ok" });
    assert.deepStrictEqual(r.body, { x: {}, ok: "fine", nested: {} });
});

test("legit queries pass validation (reach the DB layer, i.e. not 400)", async () => {
    // With no DB connected the handler would hang on buffering, so we only assert the
    // validators accept these by running them through the validator chain directly.
    const { validate, pagination } = require("./validate");
    for (const q of [{ page: "1", limit: "20" }, { page: "2", limit: "50" }, {}]) {
        const req = { query: q, body: {}, params: {}, headers: {} };
        let status = null;
        const res = { status: s => (status = s, res), json: () => {} };
        let passed = false;
        const mws = validate(pagination);
        for (const mw of mws) await new Promise(r => { const out = mw(req, res, () => { passed = true; r(); }); Promise.resolve(out).then(() => r()); });
        assert.ok(passed && status === null, JSON.stringify(q));
    }
});
