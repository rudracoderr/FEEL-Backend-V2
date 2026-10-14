// Run: node --test middleware/admin-features.test.js
// Real admin router + real validators; auth, Mongoose models, firebase-admin and FCM are all stubbed,
// so NO database is touched and NO push notification is ever sent.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const path = require("path");

const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// Thenable chainable query stand-in.
const q = (result) => {
    const o = { select: () => o, sort: () => o, skip: () => o, limit: () => o, lean: () => o, populate: () => o, then: (res, rej) => Promise.resolve(typeof result === "function" ? result() : result).then(res, rej) };
    return o;
};

for (const name of ["requireAuth", "requireAdmin"]) {
    stub(`./${name}`, (req, res, next) => { req.authUid = "admin1"; req.adminUser = { uid: "admin1", email: "admin@feel.org" }; next(); });
}

const calls = { audit: [], insertMany: [], multicast: [], updateMany: [], reportUpdate: [] };
const M = {
    User: {}, Report: {}, AbuseReport: {}, Ngo: {}, NgoTransfer: {}, AdoptionListing: {},
    Notification: { insertMany: async (docs) => { calls.insertMany.push(docs); return docs; } },
    Broadcast: {
        exists: async () => null,
        create: async (d) => ({ _id: "b1", ...d }),
        findByIdAndUpdate: async (id, u) => ({ _id: id, ...u.$set })
    },
    AuditLog: { create: async (d) => { calls.audit.push(d); return d; } }
};
M.AuditLog.schema = { path: () => ({ enumValues: ["User Suspended", "Report Resolved"] }) };

stub("../Models/usermodel", M.User);
stub("../Models/report-model", M.Report);
stub("../Models/abuse-report-model", M.AbuseReport);
stub("../Models/ngo-model", M.Ngo);
stub("../Models/ngo-transfer-model", M.NgoTransfer);
stub("../Models/audit-log-model", M.AuditLog);
stub("../Models/adoption-listing-model", M.AdoptionListing);
stub("../Models/notification-model", M.Notification);
stub("../Models/broadcast-model", M.Broadcast);
stub("../firebase-admin", { isFirebaseAdminInitialized: () => true });
let multicastResult = { accepted: 0, failed: 0, staleTokens: [] };
stub("../Services/notification-service", { sendAnnouncementMulticast: async (tokens, p) => { calls.multicast.push({ tokens, p }); return multicastResult; } });

const app = express();
app.use(express.json());
app.use("/api/admin", require("../Routes/admin-routes"));

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const call = (method, url, body) => fetch(base + url, {
    method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body)
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const ID = "507f1f77bcf86cd799439011";
const good = { audience: "volunteers", title: "Heads up", body: "Rescue drive Sunday", confirm: true };

// ── pagination / filtering ────────────────────────────────────────────────
test("pagination: limit above max and bad page rejected, valid request returns metadata", async () => {
    assert.strictEqual((await call("GET", "/api/admin/users?limit=51")).status, 400);
    assert.strictEqual((await call("GET", "/api/admin/users?page=0")).status, 400);
    assert.strictEqual((await call("GET", "/api/admin/reports?status=bogus")).status, 400);
    assert.strictEqual((await call("GET", "/api/admin/users?search[$ne]=x")).status, 400);
    M.User.aggregate = async () => [];
    M.User.countDocuments = async () => 41;
    const r = await call("GET", "/api/admin/users?page=2&limit=20&status=suspended&search=a.b");
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.pagination, { page: 2, limit: 20, total: 41, totalPages: 3, hasMore: true });
});

test("unexpected errors return a generic message (no internal detail leaked)", async () => {
    M.User.aggregate = async () => { throw new Error("secret mongo detail host=10.0.0.1"); };
    const r = await call("GET", "/api/admin/users");
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.body.message, "Internal server error");
    assert.ok(!JSON.stringify(r.body).includes("secret"));
});

// ── reports ───────────────────────────────────────────────────────────────
test("resolve: audit/resolvedBy come from verified admin, client resolvedBy ignored", async () => {
    calls.audit.length = 0;
    M.Report.findOneAndUpdate = (filter, update) => { calls.reportUpdate.push({ filter, update }); return q({ _id: ID, status: "resolved" }); };
    M.AbuseReport.updateMany = async () => ({});
    const r = await call("PATCH", `/api/admin/reports/${ID}/resolve`, { resolutionRemark: "done", resolvedBy: "hacker" });
    assert.strictEqual(r.status, 200);
    const { filter, update } = calls.reportUpdate.at(-1);
    assert.strictEqual(update.$set.resolvedBy, "admin@feel.org");
    assert.deepStrictEqual(filter.currentHandlerType, { $ne: "ngo" });
    assert.strictEqual(calls.audit[0].action, "Report Resolved");
    assert.strictEqual(calls.audit[0].adminId, "admin1");
});

test("report owned by an NGO cannot be changed by admin (409)", async () => {
    M.Report.findOneAndUpdate = () => q(null);
    M.Report.findById = () => q({ status: "accepted", currentHandlerType: "ngo" });
    const r = await call("PATCH", `/api/admin/reports/${ID}/fake`);
    assert.strictEqual(r.status, 409);
    assert.match(r.body.message, /owned by an NGO/);
});

test("accepted report can be marked fake via the existing endpoint (200)", async () => {
    M.Report.findOneAndUpdate = () => q({ _id: ID, status: "fake" });
    assert.strictEqual((await call("PATCH", `/api/admin/reports/${ID}/fake`)).status, 200);
});

// ── moderation ────────────────────────────────────────────────────────────
test("dismiss abuse flag: 200 audited; already-dismissed -> 409; unknown -> 404", async () => {
    calls.audit.length = 0;
    M.AbuseReport.findOneAndUpdate = () => q({ _id: ID, reason: "Spam", reportId: ID, status: "dismissed" });
    assert.strictEqual((await call("PATCH", `/api/admin/moderation/${ID}/dismiss`, { note: "false flag" })).status, 200);
    assert.strictEqual(calls.audit[0].action, "Abuse Report Dismissed");

    M.AbuseReport.findOneAndUpdate = () => q(null);
    M.AbuseReport.findById = () => q({ status: "dismissed" });
    assert.strictEqual((await call("PATCH", `/api/admin/moderation/${ID}/dismiss`)).status, 409);
    M.AbuseReport.findById = () => q(null);
    assert.strictEqual((await call("PATCH", `/api/admin/moderation/${ID}/dismiss`)).status, 404);
    assert.strictEqual((await call("PATCH", `/api/admin/moderation/not-an-id/dismiss`)).status, 400);
});

// ── paid volunteers ───────────────────────────────────────────────────────
test("paid volunteer transitions are validated server-side and audited", async () => {
    calls.audit.length = 0;
    M.User.findOneAndUpdate = () => q(null);
    M.User.findOne = () => q({ paidVolunteerStatus: "approved" });
    const bad = await call("POST", "/api/admin/paid-volunteers/u1/reject", { reason: "no" });
    assert.strictEqual(bad.status, 409);
    assert.strictEqual((await call("POST", "/api/admin/paid-volunteers/u1/reject", {})).status, 400); // reason required

    M.User.findOne = () => q(null);
    assert.strictEqual((await call("POST", "/api/admin/paid-volunteers/u1/approve")).status, 404);

    let captured;
    M.User.findOneAndUpdate = (f, u) => { captured = { f, u }; return q({ uid: "u1", paidVolunteerStatus: "approved" }); };
    const ok = await call("POST", "/api/admin/paid-volunteers/u1/approve");
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(captured.u.$set.isPaidVolunteer, true);
    assert.strictEqual(captured.u.$set.paidVolunteerReviewedBy, "admin@feel.org");
    assert.strictEqual(calls.audit[0].action, "Paid Volunteer Approved");
});

// ── NGO archive ───────────────────────────────────────────────────────────
test("NGO delete is blocked while it owns accepted cases, otherwise archives (no hard delete)", async () => {
    M.Ngo.findById = () => q({ _id: ID, name: "Paws", archivedAt: null });
    M.NgoTransfer.countDocuments = async () => 2;
    assert.strictEqual((await call("DELETE", `/api/admin/ngos/${ID}`)).status, 409);

    calls.updateMany.length = 0; calls.audit.length = 0;
    M.NgoTransfer.countDocuments = async () => 0;
    M.Ngo.updateOne = async () => ({});
    M.NgoTransfer.find = () => q([{ _id: "t1", reportId: "r1" }]);
    M.Report.updateMany = async (...a) => { calls.updateMany.push(["report", ...a]); return {}; };
    M.NgoTransfer.updateMany = async (...a) => { calls.updateMany.push(["transfer", ...a]); return {}; };
    M.User.updateMany = async (...a) => { calls.updateMany.push(["user", ...a]); return { modifiedCount: 3 }; };
    assert.ok(!M.Ngo.findByIdAndDelete, "hard delete must not exist");
    const r = await call("DELETE", `/api/admin/ngos/${ID}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.membersSuspended, 3);
    assert.strictEqual(r.body.transfersCancelled, 1);
    assert.strictEqual(calls.audit[0].action, "NGO Archived");
    assert.deepStrictEqual(calls.updateMany.map(c => c[0]), ["report", "transfer", "user"]);
});

// ── broadcast ─────────────────────────────────────────────────────────────
test("broadcast: requires confirm, valid audience, uid for single-user (no FCM call)", async () => {
    calls.multicast.length = 0;
    assert.strictEqual((await call("POST", "/api/admin/notifications/broadcast", { ...good, confirm: false })).status, 400);
    assert.strictEqual((await call("POST", "/api/admin/notifications/broadcast", { ...good, audience: "everyone" })).status, 400);
    assert.strictEqual((await call("POST", "/api/admin/notifications/broadcast", { ...good, audience: "user" })).status, 400);
    assert.strictEqual(calls.multicast.length, 0);
});

test("broadcast: dedupes recipients/tokens, clears stale tokens, records partial result + audit (mock FCM)", async () => {
    calls.audit.length = 0; calls.insertMany.length = 0;
    M.User.countDocuments = async () => 4;
    M.User.find = () => q([
        { uid: "a", deviceToken: "t1" },
        { uid: "a", deviceToken: "t1" },   // duplicate user
        { uid: "b", deviceToken: "t1" },   // shared token
        { uid: "c", deviceToken: "t2" },
        { uid: "d", deviceToken: null }
    ]);
    let staleQuery;
    M.User.updateMany = async (f) => { staleQuery = f; return { modifiedCount: 1 }; };
    multicastResult = { accepted: 1, failed: 1, staleTokens: ["t2"] };

    const r = await call("POST", "/api/admin/notifications/broadcast", good);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(calls.multicast[0].tokens.sort(), ["t1", "t2"]);
    assert.strictEqual(calls.multicast[0].p.data.type, "admin_announcement");
    assert.deepStrictEqual(calls.insertMany[0].map(d => d.recipientUid).sort(), ["a", "b", "c", "d"]);
    assert.ok(calls.insertMany[0].every(d => d.type === "admin_announcement"));
    assert.deepStrictEqual(staleQuery, { deviceToken: { $in: ["t2"] } });
    assert.strictEqual(r.body.broadcast.status, "partial");
    assert.strictEqual(r.body.broadcast.fcmAccepted, 1);
    assert.strictEqual(calls.audit[0].action, "Notification Broadcast");
    assert.strictEqual(calls.audit[0].adminEmail, "admin@feel.org");
});

test("broadcast: identical repeat within window -> 409", async () => {
    M.Broadcast.exists = async () => ({ _id: "b0" });
    assert.strictEqual((await call("POST", "/api/admin/notifications/broadcast", good)).status, 409);
    M.Broadcast.exists = async () => null;
});

test("broadcast: rate limited after 5 attempts per admin (429)", async () => {
    assert.strictEqual((await call("POST", "/api/admin/notifications/broadcast", good)).status, 429);
});

test("preview returns counts without sending", async () => {
    calls.multicast.length = 0;
    M.User.countDocuments = async () => 7;
    const r = await call("POST", "/api/admin/notifications/preview", { audience: "paid_volunteers" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.recipientCount, 7);
    assert.strictEqual(calls.multicast.length, 0);
});

// ── dashboard ─────────────────────────────────────────────────────────────
test("dashboard-stats aggregates counts server-side", async () => {
    M.Report.aggregate = async () => [{ _id: "pending", count: 3 }, { _id: "resolved", count: 2 }, { _id: "accepted", count: 1 }];
    M.User.countDocuments = async () => 10;
    M.Ngo.countDocuments = async () => 4;
    M.AbuseReport.countDocuments = async () => 5;
    M.Report.find = () => q([]);
    const r = await call("GET", "/api/admin/dashboard-stats");
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.stats.reports, { total: 6, pending: 3, accepted: 1, resolved: 2, fake: 0 });
    assert.strictEqual(r.body.stats.ngos, 4);
});

// ── legacy abuse docs & single-user preview ──────────────────────────────
test("moderation handles legacy AbuseReport docs without status field and normalizes to pending", async () => {
    let capturedFilter = null;
    M.AbuseReport.find = (f) => { capturedFilter = f; return q([{ _id: ID, reportId: ID, reason: "Spam" }]); };
    M.AbuseReport.countDocuments = async () => 1;
    M.Report.find = () => q([{ _id: ID, title: "Injured puppy", status: "pending" }]);

    const r = await call("GET", "/api/admin/moderation");
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(capturedFilter, { $or: [{ status: "pending" }, { status: { $exists: false } }] });
    assert.strictEqual(r.body.items[0].abuseReport.status, "pending");
    assert.strictEqual(r.body.items[0].report.title, "Injured puppy");
});

test("preview with single-user audience accepts valid uid and applies suspension filter", async () => {
    let capturedFilter = null;
    M.User.countDocuments = async (f) => { capturedFilter = f; return 1; };
    const r = await call("POST", "/api/admin/notifications/preview", { audience: "user", uid: "user_abc123" });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(capturedFilter, { isSuspended: { $ne: true }, uid: "user_abc123", deviceToken: { $exists: true, $nin: [null, ""] } });
});

