// Run: node --test middleware/
// Real admin router behind the real sanitize middleware, auth stubbed. Rejections must happen (400) before any DB access.
// Acceptances are checked by running the very same validator chains the routes use (no DB needed).
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const mongoSanitize = require("express-mongo-sanitize");

for (const name of ["requireAuth", "requireAdmin"]) {
    const p = require.resolve(`./${name}`);
    require.cache[p] = { id: p, filename: p, loaded: true, exports: (req, res, next) => { req.authUid = "admin1"; req.adminUser = { uid: "admin1", email: "a@b.co" }; next(); } };
}

const app = express();
app.use(express.json());
app.use(mongoSanitize());
app.use("/api/admin", require("../Routes/admin-routes"));

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const call = (method, url, body) => fetch(base + url, {
    method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body)
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const UID = "AbC123xyz_-0987654321qwertyui"; // Firebase-style uid (NOT an ObjectId)
const ID = "507f1f77bcf86cd799439011";
const validNgo = { name: "O'Connor Animal-Care", email: "ngo@example.org", phone: "+91 98765-43210", address: "Delhi-NCR, Sector #12" };

const rejected = [
    // admin reasons (user suspend, volunteer reject/suspend)
    ...["users", "volunteers"].flatMap(kind => (kind === "users" ? ["suspend"] : ["reject", "suspend"]).flatMap(action => {
        const u = `/api/admin/${kind}/${UID}/${action}`;
        return [
            ["POST", u, {}, `${kind}/${action}: missing reason`],
            ["POST", u, { reason: "   \t\n " }, `${kind}/${action}: whitespace-only reason`],
            ["POST", u, { reason: null }, `${kind}/${action}: null reason`],
            ["POST", u, { reason: 42 }, `${kind}/${action}: numeric reason`],
            ["POST", u, { reason: ["x"] }, `${kind}/${action}: array reason`],
            ["POST", u, { reason: { $ne: null } }, `${kind}/${action}: $ne operator reason`],
            ["POST", u, { reason: { $gt: "" } }, `${kind}/${action}: $gt operator reason`],
            ["POST", u, { reason: "a".repeat(501) }, `${kind}/${action}: oversized reason`]
        ];
    })),
    // malformed Firebase uid
    ["POST", `/api/admin/users/${"u".repeat(129)}/suspend`, { reason: "ok" }, "oversized uid"],
    ["POST", "/api/admin/users/bad%20uid/suspend", { reason: "ok" }, "uid containing whitespace"],
    ["POST", "/api/admin/users/bad%00uid/suspend", { reason: "ok" }, "uid containing control char"],
    ["POST", `/api/admin/volunteers/${"u".repeat(129)}/approve`, {}, "oversized uid (approve)"],
    ["POST", "/api/admin/users/bad%09uid/unsuspend", {}, "uid with tab (unsuspend)"],
    ["GET", `/api/admin/users/${"u".repeat(129)}/reports`, undefined, "oversized uid (reports)"],
    // NGO create
    ["POST", "/api/admin/ngos", {}, "ngo create: empty body"],
    ["POST", "/api/admin/ngos", { ...validNgo, name: "   " }, "ngo create: whitespace name"],
    ["POST", "/api/admin/ngos", { ...validNgo, name: { $ne: null } }, "ngo create: operator name"],
    ["POST", "/api/admin/ngos", { ...validNgo, name: ["a"] }, "ngo create: array name"],
    ["POST", "/api/admin/ngos", { ...validNgo, name: "n".repeat(101) }, "ngo create: oversized name"],
    ["POST", "/api/admin/ngos", { ...validNgo, email: "not-an-email" }, "ngo create: bad email"],
    ["POST", "/api/admin/ngos", { ...validNgo, email: { $gt: "" } }, "ngo create: operator email"],
    ["POST", "/api/admin/ngos", { ...validNgo, phone: "abc<script>" }, "ngo create: bad phone"],
    ["POST", "/api/admin/ngos", { ...validNgo, phone: "1".repeat(21) }, "ngo create: oversized phone"],
    ["POST", "/api/admin/ngos", { ...validNgo, phone: null }, "ngo create: null phone"],
    ["POST", "/api/admin/ngos", { ...validNgo, address: "a".repeat(301) }, "ngo create: oversized address"],
    ["POST", "/api/admin/ngos", { ...validNgo, address: { $ne: 1 } }, "ngo create: operator address"],
    ["POST", "/api/admin/ngos", { ...validNgo, password: "123" }, "ngo create: short password"],
    ["POST", "/api/admin/ngos", { ...validNgo, password: { $ne: "" } }, "ngo create: operator password"],
    ["POST", "/api/admin/ngos", { ...validNgo, password: "p".repeat(129) }, "ngo create: oversized password"],
    ["POST", "/api/admin/ngos", { ...validNgo, active: "false" }, "ngo create: non-boolean active"],
    // NGO patch
    ["PATCH", `/api/admin/ngos/${ID}`, { name: { $ne: null } }, "ngo patch: operator name"],
    ["PATCH", `/api/admin/ngos/${ID}`, { name: "n".repeat(101) }, "ngo patch: oversized name"],
    ["PATCH", `/api/admin/ngos/${ID}`, { contactEmail: "nope" }, "ngo patch: bad contactEmail"],
    ["PATCH", `/api/admin/ngos/${ID}`, { contactEmail: ["a@b.co"] }, "ngo patch: array contactEmail"],
    ["PATCH", `/api/admin/ngos/${ID}`, { phone: "bad<phone>" }, "ngo patch: bad phone"],
    ["PATCH", `/api/admin/ngos/${ID}`, { phone: 5551234 }, "ngo patch: numeric phone"],
    ["PATCH", `/api/admin/ngos/${ID}`, { city: "c".repeat(101) }, "ngo patch: oversized city"],
    ["PATCH", `/api/admin/ngos/${ID}`, { city: { $gt: "" } }, "ngo patch: operator city"],
    ["PATCH", `/api/admin/ngos/${ID}`, { active: "yes" }, "ngo patch: non-boolean active"],
    ["PATCH", `/api/admin/ngos/${ID}`, { active: { $ne: false } }, "ngo patch: operator active"],
    ["PATCH", "/api/admin/ngos/not-an-id", { name: "x" }, "ngo patch: malformed id"],
    // report resolve
    ["PATCH", `/api/admin/reports/${ID}/resolve`, {}, "resolve: missing remark"],
    ["PATCH", `/api/admin/reports/${ID}/resolve`, { resolutionRemark: "   " }, "resolve: whitespace remark"],
    ["PATCH", `/api/admin/reports/${ID}/resolve`, { resolutionRemark: null }, "resolve: null remark"],
    ["PATCH", `/api/admin/reports/${ID}/resolve`, { resolutionRemark: { $ne: null } }, "resolve: operator remark"],
    ["PATCH", `/api/admin/reports/${ID}/resolve`, { resolutionRemark: ["x"] }, "resolve: array remark"],
    ["PATCH", `/api/admin/reports/${ID}/resolve`, { resolutionRemark: "a".repeat(2001) }, "resolve: oversized remark"],
    ["PATCH", `/api/admin/reports/${ID}/resolve`, { resolutionRemark: "ok", resolvedBy: { $ne: 1 } }, "resolve: operator resolvedBy"],
    ["PATCH", `/api/admin/reports/${ID}/resolve`, { resolutionRemark: "ok", resolvedBy: "r".repeat(101) }, "resolve: oversized resolvedBy"],
    ["PATCH", "/api/admin/reports/bad/resolve", { resolutionRemark: "ok" }, "resolve: malformed id"]
];

for (const [method, url, body, label] of rejected) {
    test(`400: ${label}`, async () => {
        const r = await call(method, url, body);
        assert.strictEqual(r.status, 400, `${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
        assert.ok(r.body.message);
    });
}

test("admin validation error uses the standard shape", async () => {
    const r = await call("POST", `/api/admin/users/${UID}/suspend`, { reason: "  " });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.success, false);
    assert.strictEqual(r.body.message, "Validation failed");
    assert.strictEqual(r.body.error, "Validation failed");
    assert.ok(Array.isArray(r.body.errors) && r.body.errors[0].field === "reason");
});

// ── Acceptance: run the same chains the router uses against valid input ──
const { validate, requiredStr, uidParam, str, body: bodyV } = require("./validate");

async function runChains(chains, { body = {}, params = {} } = {}) {
    const req = { body, params, query: {}, headers: {} };
    let status = null, out = null;
    const res = { status: s => (status = s, res), json: j => { out = j; } };
    for (const mw of validate(...chains)) {
        if (status !== null) break;
        await new Promise(r => { const x = mw(req, res, () => r()); Promise.resolve(x).then(() => r()); });
    }
    return { passed: status === null, status, out, req };
}

test("valid reasons accepted (apostrophes, hyphens, punctuation) and trimmed", async () => {
    for (const reason of ["Dog's injury", "Delhi-NCR volunteer, O'Connor", "Animal #12: repeated no-show!", "ok"]) {
        const r = await runChains([uidParam(), requiredStr("reason", 500)], { body: { reason: `  ${reason}  ` }, params: { uid: UID } });
        assert.ok(r.passed, reason);
        assert.strictEqual(r.req.body.reason, reason, "trimmed value written back");
    }
});

test("reason exactly at the limit is accepted, one over is rejected (limit applies after trimming)", async () => {
    assert.ok((await runChains([requiredStr("reason", 500)], { body: { reason: ` ${"a".repeat(500)} ` } })).passed);
    assert.ok(!(await runChains([requiredStr("reason", 500)], { body: { reason: "a".repeat(501) } })).passed);
});

test("Firebase-style uids are accepted; ObjectId-only validation is NOT applied", async () => {
    for (const uid of [UID, "u1", "a".repeat(128), "google.com:1234567890", "x-y_z"]) {
        assert.ok((await runChains([uidParam()], { params: { uid } })).passed, uid);
    }
    assert.ok(!(await runChains([uidParam()], { params: { uid: "a".repeat(129) } })).passed);
    assert.ok(!(await runChains([uidParam()], { params: { uid: "a b" } })).passed);
});

test("valid NGO name/phone/address/city (apostrophes, hyphens, punctuation) accepted", async () => {
    const chains = [requiredStr("name", 100), str("address", 300), str("city", 100)];
    for (const name of ["O'Connor Animal-Care", "St. Mary's Shelter (Delhi-NCR)", "Paws & Claws #1"]) {
        assert.ok((await runChains(chains, { body: { name, address: "Block-A, Sector #12", city: "Delhi-NCR" } })).passed, name);
    }
});
