// Run: node --test middleware/
// Verifies volunteer cancel/progress/resolve are blocked (409) once an NGO owns the report,
// and still behave normally before NGO takeover. Models are stubbed in-memory; no DB needed.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");

const authPath = require.resolve("./requireAuth");
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: (req, res, next) => { req.authUid = "vol1"; next(); } };
const nsPath = require.resolve("../Services/notification-service");
require.cache[nsPath] = { id: nsPath, filename: nsPath, loaded: true, exports: { createNotification: async () => null } };

const Report = require("../Models/report-model");
const User = require("../Models/usermodel");
const NgoTransfer = require("../Models/ngo-transfer-model");

let current, mutated;
User.findOne = (q) => {
    const user = { uid: q.uid, isVolunteer: true, role: "user" };
    const p = Promise.resolve(q.role === "admin" ? [] : user);
    p.select = () => p;
    return p;
};
User.find = async () => [];
Report.findById = async () => current;
Report.findByIdAndUpdate = async (_id, update) => { mutated = true; return { ...current, ...update.$set }; };
NgoTransfer.updateMany = async () => ({});

const app = express();
app.use(express.json());
app.use("/api/reports", require("../Routes/report-routes"));

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const ID = "507f1f77bcf86cd799439011";
const patch = (action, body = {}) => fetch(`${base}/api/reports/${ID}/${action}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const report = (handler) => ({
    _id: ID, status: "accepted", title: "Dog", volunteerProgress: "Assigned",
    assignedVolunteer: { uid: "vol1" }, currentHandlerType: handler,
    transferStatus: handler === "ngo" ? "completed" : "none", assistance: { status: "none" }
});
const resolution = { resolutionDetails: { photoUrl: "http://x/y.jpg", note: "done" } };
const calls = {
    cancel: () => patch("cancel"),
    progress: () => patch("progress", { progress: "On The Way" }),
    "progress (Resolved)": () => patch("progress", { progress: "Resolved", ...resolution }),
    resolve: () => patch("resolve", resolution)
};

for (const [name, fn] of Object.entries(calls)) {
    test(`volunteer ${name} after NGO takeover -> 409, no mutation`, async () => {
        current = report("ngo"); mutated = false;
        const res = await fn();
        assert.strictEqual(res.status, 409);
        assert.match(res.body.message, /transferred to an NGO/);
        assert.strictEqual(mutated, false);
    });
    for (const handler of ["none", "volunteer"]) {
        test(`volunteer ${name} before NGO takeover (${handler}) -> 200`, async () => {
            current = report(handler); mutated = false;
            const res = await fn();
            assert.strictEqual(res.status, 200);
            assert.strictEqual(mutated, true);
        });
    }
}
