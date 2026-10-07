// Run: node --test middleware/privacy.test.js
// Verifies that public GET /api/reports/:id does NOT expose private fields,
// and that the paid-volunteer projection correctly adds the extra fields.
//
// Strategy: We stub requireAuth/requireActiveUser/requireNgo/notification-service
// and mongoose's Report model so no real DB is needed, then hit the real report
// router via HTTP.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const mongoSanitize = require("express-mongo-sanitize");

// ── Stub out auth middleware ────────────────────────────────────────────
const authPath = require.resolve("./requireAuth");
require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: (req, res, next) => { req.authUid = "u1"; next(); }
};
for (const name of ["requireActiveUser", "requireNgo"]) {
    const p = require.resolve(`./${name}`);
    require.cache[p] = {
        id: p, filename: p, loaded: true,
        exports: (req, res, next) => { req.activeUser = {}; req.ngoUser = { uid: "u1", ngoId: "000000000000000000000001" }; next(); }
    };
}
const nsPath = require.resolve("../Services/notification-service");
require.cache[nsPath] = { id: nsPath, filename: nsPath, loaded: true, exports: {} };

// ── Stub firebase-admin ─────────────────────────────────────────────────
// We need to control whether the caller is identified as a paid volunteer.
let _firebaseDecode = null; // set to { uid: "..." } to simulate auth, null for unauthed
const faPath = require.resolve("../firebase-admin");
require.cache[faPath] = {
    id: faPath, filename: faPath, loaded: true,
    exports: {
        isFirebaseAdminInitialized: () => true,
        auth: () => ({
            verifyIdToken: async () => {
                if (!_firebaseDecode) throw new Error("no token");
                return _firebaseDecode;
            }
        })
    }
};

// ── Stub User model (for the optional PV lookup inside GET /:id) ────────
// We'll control what the user lookup returns via _pvUser.
let _pvUser = null;
const userModelPath = require.resolve("../Models/usermodel");
const fakeUserQuery = () => ({
    select() { return this; },
    lean() { return this; },
    sort() { return this; },
    then(resolve) { return Promise.resolve(_pvUser).then(resolve); },
    catch(fn) { return Promise.resolve(_pvUser).catch(fn); }
});
require.cache[userModelPath] = {
    id: userModelPath, filename: userModelPath, loaded: true,
    exports: {
        findOne: () => fakeUserQuery(),
        updateOne: () => ({ catch: () => {} }),
        findOneAndUpdate: () => fakeUserQuery()
    }
};

// ── Stub Report model ───────────────────────────────────────────────────
// We need Report.findById(id).select(projection).lean() to return a document
// whose shape proves whether the projection stripped private fields.
const FULL_REPORT = {
    _id: "507f1f77bcf86cd799439011",
    title: "Injured Dog",
    description: "Near the park",
    severity: "High",
    status: "accepted",
    assignedVolunteer: {
        uid: "vol1",
        fullName: "Volunteer One",
        phone: "+911234567890",  // PRIVATE
        email: "vol@x.co"       // PRIVATE
    },
    acceptedAt: new Date().toISOString(),
    resolvedAt: null,
    volunteerProgress: "On The Way",
    progressUpdatedAt: null,
    location: { type: "Point", coordinates: [77.1, 28.6] },
    address: "Test Address",
    landmark: "Near park",
    date: new Date().toISOString(),
    reporterName: "Reporter One",
    reporterUid: "reporter1",       // should be in public projection (used for client gate logic)
    reporterContact: "+919876543",  // PRIVATE - should never appear
    reporterDeviceToken: "fcm:abc", // PRIVATE - should never appear
    imageUrls: ["http://x/y.jpg"],
    resolutionRemark: "Resolved OK",
    resolutionDetails: {
        photoUrl: "http://x/photo.jpg",
        note: "All good",
        resolvedAt: new Date().toISOString(),
        resolvedByUid: "admin1"     // PRIVATE - should not appear in public
    },
    assistance: {
        status: "accepted",
        requestedAt: new Date().toISOString(),
        acceptedByUid: "pv1",
        acceptedByName: "PV One",
        acceptedByPhone: "+911111111111",  // PRIVATE for public, should appear for PV
        notifiedVolunteerCount: 3,         // PRIVATE
        notifiedVolunteerUids: ["a","b"]   // PRIVATE
    },
    transferStatus: "none",
    currentHandlerType: "volunteer",
    currentNgoId: null,
    resolvedBy: "admin"
};

// Simulate Mongoose's .select(projection) by filtering the document
function applyProjection(doc, projection) {
    const result = {};
    for (const key of Object.keys(projection)) {
        if (projection[key] !== 1) continue;
        const parts = key.split(".");
        let src = doc;
        let dst = result;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (i === parts.length - 1) {
                if (src && src[p] !== undefined) dst[p] = src[p];
            } else {
                if (!dst[p]) dst[p] = {};
                dst = dst[p];
                src = src ? src[p] : undefined;
            }
        }
    }
    // Mongoose always includes _id unless explicitly excluded
    result._id = doc._id;
    return result;
}

const reportModelPath = require.resolve("../Models/report-model");
require.cache[reportModelPath] = {
    id: reportModelPath, filename: reportModelPath, loaded: true,
    exports: {
        find: () => ({
            select() { return this; },
            sort() { return this; },
            skip() { return this; },
            limit() { return this; },
            lean() { return this; },
            then(resolve) { return Promise.resolve([]).then(resolve); },
            catch(fn) { return Promise.resolve([]).catch(fn); }
        }),
        findById: (id) => {
            let _projection = null;
            const q = {
                select(proj) { _projection = proj; return q; },
                lean() { return q; },
                then(resolve) {
                    const result = _projection ? applyProjection(FULL_REPORT, _projection) : { ...FULL_REPORT };
                    return Promise.resolve(result).then(resolve);
                },
                catch(fn) { return Promise.resolve(null).catch(fn); }
            };
            return q;
        },
        estimatedDocumentCount: () => Promise.resolve(0),
        countDocuments: () => Promise.resolve(0),
        findOne: () => fakeUserQuery(),
        schema: { index: () => {} },
        index: () => {}
    }
};

// ── Stub other models ───────────────────────────────────────────────────
for (const modelName of ["abuse-report-model", "ngo-model", "ngo-transfer-model", "adoption-listing-model", "notification-model"]) {
    const p = require.resolve(`../Models/${modelName}`);
    if (!require.cache[p]) {
        require.cache[p] = {
            id: p, filename: p, loaded: true,
            exports: {
                find: () => ({ select: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: () => ({ then: (r) => Promise.resolve([]).then(r), catch: () => {} }) }) }) }) }) }),
                findById: () => ({ lean: () => ({ then: (r) => Promise.resolve(null).then(r) }) }),
                findOne: () => ({ lean: () => ({ then: (r) => Promise.resolve(null).then(r) }) }),
                countDocuments: () => Promise.resolve(0),
                schema: { index: () => {} },
                index: () => {}
            }
        };
    }
}

// ── Mount routes ────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(mongoSanitize());
app.use("/api/reports", require("../Routes/report-routes"));

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const ID = "507f1f77bcf86cd799439011";

// ── Test: unauthenticated GET /:id — no private fields ──────────────────

test("unauthenticated GET /reports/:id does NOT expose assistance.acceptedByPhone", async () => {
    _firebaseDecode = null; // unauthenticated
    _pvUser = null;
    const r = await fetch(`${base}/api/reports/${ID}`).then(r => r.json());
    assert.strictEqual(r.assistance?.acceptedByPhone, undefined,
        `acceptedByPhone should not be in response, got: ${r.assistance?.acceptedByPhone}`);
});

test("unauthenticated GET /reports/:id does NOT expose reporterContact", async () => {
    _firebaseDecode = null;
    _pvUser = null;
    const r = await fetch(`${base}/api/reports/${ID}`).then(r => r.json());
    assert.strictEqual(r.reporterContact, undefined, "reporterContact should not be in response");
});

test("unauthenticated GET /reports/:id does NOT expose reporterDeviceToken", async () => {
    _firebaseDecode = null;
    _pvUser = null;
    const r = await fetch(`${base}/api/reports/${ID}`).then(r => r.json());
    assert.strictEqual(r.reporterDeviceToken, undefined, "reporterDeviceToken should not be in response");
});

test("unauthenticated GET /reports/:id does NOT expose assignedVolunteer.phone", async () => {
    _firebaseDecode = null;
    _pvUser = null;
    const r = await fetch(`${base}/api/reports/${ID}`).then(r => r.json());
    assert.strictEqual(r.assignedVolunteer?.phone, undefined, "assignedVolunteer.phone should not be in public response");
});

test("unauthenticated GET /reports/:id does NOT expose assignedVolunteer.email", async () => {
    _firebaseDecode = null;
    _pvUser = null;
    const r = await fetch(`${base}/api/reports/${ID}`).then(r => r.json());
    assert.strictEqual(r.assignedVolunteer?.email, undefined, "assignedVolunteer.email should not be in public response");
});

test("unauthenticated GET /reports/:id does NOT expose resolutionDetails.resolvedByUid", async () => {
    _firebaseDecode = null;
    _pvUser = null;
    const r = await fetch(`${base}/api/reports/${ID}`).then(r => r.json());
    assert.strictEqual(r.resolutionDetails?.resolvedByUid, undefined,
        "resolutionDetails.resolvedByUid should not be in public response");
});

test("unauthenticated GET /reports/:id DOES include reporterUid (needed for client gate logic)", async () => {
    _firebaseDecode = null;
    _pvUser = null;
    const r = await fetch(`${base}/api/reports/${ID}`).then(r => r.json());
    assert.strictEqual(r.reporterUid, "reporter1", "reporterUid should be present for client-side gate logic");
});

test("unauthenticated GET /reports/:id DOES include safe resolutionDetails fields", async () => {
    _firebaseDecode = null;
    _pvUser = null;
    const r = await fetch(`${base}/api/reports/${ID}`).then(r => r.json());
    assert.strictEqual(r.resolutionDetails?.photoUrl, "http://x/photo.jpg");
    assert.strictEqual(r.resolutionDetails?.note, "All good");
    assert.ok(r.resolutionDetails?.resolvedAt, "resolvedAt should be present");
});

// ── Test: authenticated paid volunteer — gets extra fields ──────────────

test("paid volunteer GET /reports/:id DOES include assignedVolunteer.phone", async () => {
    _firebaseDecode = { uid: "pv1" };
    _pvUser = { isPaidVolunteer: true, paidVolunteerStatus: "approved" };
    const r = await fetch(`${base}/api/reports/${ID}`, {
        headers: { "Authorization": "Bearer fake-token" }
    }).then(r => r.json());
    assert.strictEqual(r.assignedVolunteer?.phone, "+911234567890",
        "PV should see assignedVolunteer.phone");
});

test("paid volunteer GET /reports/:id DOES include assistance.acceptedByPhone", async () => {
    _firebaseDecode = { uid: "pv1" };
    _pvUser = { isPaidVolunteer: true, paidVolunteerStatus: "approved" };
    const r = await fetch(`${base}/api/reports/${ID}`, {
        headers: { "Authorization": "Bearer fake-token" }
    }).then(r => r.json());
    assert.strictEqual(r.assistance?.acceptedByPhone, "+911111111111",
        "PV should see assistance.acceptedByPhone");
});

test("paid volunteer GET /reports/:id still does NOT expose reporterContact", async () => {
    _firebaseDecode = { uid: "pv1" };
    _pvUser = { isPaidVolunteer: true, paidVolunteerStatus: "approved" };
    const r = await fetch(`${base}/api/reports/${ID}`, {
        headers: { "Authorization": "Bearer fake-token" }
    }).then(r => r.json());
    assert.strictEqual(r.reporterContact, undefined, "reporterContact must never be exposed even to PV");
});

test("paid volunteer GET /reports/:id still does NOT expose reporterDeviceToken", async () => {
    _firebaseDecode = { uid: "pv1" };
    _pvUser = { isPaidVolunteer: true, paidVolunteerStatus: "approved" };
    const r = await fetch(`${base}/api/reports/${ID}`, {
        headers: { "Authorization": "Bearer fake-token" }
    }).then(r => r.json());
    assert.strictEqual(r.reporterDeviceToken, undefined);
});

// ── Test: regular authenticated user (not PV) — same as public ──────────

test("regular authenticated user GET /reports/:id does NOT get PV extras", async () => {
    _firebaseDecode = { uid: "regular1" };
    _pvUser = { isPaidVolunteer: false, paidVolunteerStatus: "none" };
    const r = await fetch(`${base}/api/reports/${ID}`, {
        headers: { "Authorization": "Bearer fake-token" }
    }).then(r => r.json());
    assert.strictEqual(r.assignedVolunteer?.phone, undefined, "regular user should not see volunteer phone");
    assert.strictEqual(r.assistance?.acceptedByPhone, undefined, "regular user should not see PV phone");
});
