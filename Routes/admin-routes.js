const express = require("express");
const crypto = require("crypto");
const { rateLimit } = require("express-rate-limit");

const router = express.Router();
const validateMongoId = require("../middleware/validateObjectId");
router.param("id", validateMongoId("id"));
const { validate, str, requiredStr, uidParam, pagination, body, query } = require("../middleware/validate");

// Admin request validation (reuses middleware/validate.js; handlers keep their own checks as a second line).
const REASON_MAX = 500;
const reasonRule = requiredStr("reason", REASON_MAX);
const phoneRule = body("phone").isString().withMessage("phone is required and must be a string").bail()
    .trim().notEmpty().withMessage("phone cannot be empty").bail()
    .matches(/^[0-9+()\-.\s]{1,20}$/).withMessage("phone format is invalid");
const ngoCreateRules = [
    requiredStr("name", 100),
    requiredStr("email", 254).bail().isEmail().withMessage("email is invalid"),
    phoneRule,
    str("address", 300),
    // Optional explicit password; when absent a random temporary one is generated.
    body("password").optional({ values: "falsy" }).isString().withMessage("password must be a string").bail()
        .isLength({ min: 6, max: 128 }).withMessage("password must be between 6 and 128 characters"),
    body("active").optional({ nullable: true }).isBoolean({ strict: true }).withMessage("active must be a boolean")
];
const ngoPatchRules = [
    str("name", 100),

    body("contactEmail").optional({ values: "falsy" }).isString().bail().trim().isLength({ max: 254 }).withMessage("contactEmail must be at most 254 characters").bail().isEmail().withMessage("contactEmail is invalid"),
    body("phone").optional({ nullable: true }).isString().withMessage("phone must be a string").bail()
        .trim().matches(/^[0-9+()\-.\s]{0,20}$/).withMessage("phone format is invalid"),
    str("city", 100),
    body("active").optional({ nullable: true }).isBoolean({ strict: true }).withMessage("active must be a boolean")
];
const resolveRules = [
    requiredStr("resolutionRemark", 2000),
    str("resolvedBy", 100) // accepted for backwards compatibility but ignored: the actor comes from the verified token
];

// Shared list filters (page/limit come from validate.pagination: limit max 50).
const searchRule = query("search").optional().isString().withMessage("search must be a string").bail()
    .isLength({ max: 100 }).withMessage("search must be at most 100 characters");
const inRule = (field, values) => query(field).optional().isIn(values).withMessage(`${field} is invalid`);
const listRules = [...pagination, searchRule];

const User = require("../Models/usermodel");
const Report = require("../Models/report-model");
const AbuseReport = require("../Models/abuse-report-model");
const Ngo = require("../Models/ngo-model");
const NgoTransfer = require("../Models/ngo-transfer-model");
const AuditLog = require("../Models/audit-log-model");
const AdoptionListing = require("../Models/adoption-listing-model");
const Notification = require("../Models/notification-model");
const Broadcast = require("../Models/broadcast-model");
const requireAuth = require("../middleware/requireAuth");
const requireAdmin = require("../middleware/requireAdmin");
const { sendAnnouncementMulticast } = require("../Services/notification-service");

router.use(requireAuth);
router.use(requireAdmin);

// ───────────────────────── helpers ─────────────────────────

// Unexpected errors: log details server-side, return a generic body.
function fail(res, error, what) {
    console.error(`[admin] ${what}:`, error);
    if (error?.name === "ValidationError" || error?.name === "CastError") {
        return res.status(400).json({ success: false, message: "Invalid data" });
    }
    if (error?.code === 11000) {
        return res.status(409).json({ success: false, message: "A record with these details already exists" });
    }
    return res.status(500).json({ success: false, message: "Internal server error" });
}

// Audit actor always comes from the verified admin (req.adminUser), never from the request body.
// The audited mutation has already committed, so an audit write failure is logged, not surfaced.
async function audit(req, action, targetId, reason = "") {
    try {
        await AuditLog.create({
            adminId: req.adminUser.uid,
            adminEmail: req.adminUser.email || req.adminUser.uid,
            action,
            targetId: String(targetId),
            reason: String(reason || "").trim().slice(0, REASON_MAX)
        });
    } catch (error) {
        console.error(`[admin] audit log write failed (${action}):`, error.message);
    }
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pageParams(req) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    return { page, limit, skip: (page - 1) * limit };
}

const pageMeta = (total, page, limit) => ({
    page, limit, total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasMore: page * limit < total
});

// ponytail: unanchored case-insensitive regex search; fine for admin-sized collections,
// upgrade path is a text index once collections exceed ~100k documents.
function searchFilter(req, fields) {
    const s = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (!s) return null;
    const rx = new RegExp(escapeRegex(s), "i");
    return { $or: fields.map((f) => ({ [f]: rx })) };
}

const and = (...parts) => {
    const list = parts.filter(Boolean);
    return list.length ? { $and: list } : {};
};

// ───────────────────────── dashboard ─────────────────────────

// GET /api/admin/dashboard-stats
router.get("/dashboard-stats", async (req, res) => {
    try {
        const [byStatus, users, volunteers, pendingVolunteers, paidVolunteers, pendingPaid, ngos, pendingAbuse, priority] = await Promise.all([
            Report.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
            User.countDocuments({}),
            User.countDocuments({ isVolunteer: true, volunteerStatus: "approved" }),
            User.countDocuments({ volunteerStatus: "pending" }),
            User.countDocuments({ isPaidVolunteer: true, paidVolunteerStatus: "approved" }),
            User.countDocuments({ paidVolunteerStatus: "pending" }),
            Ngo.countDocuments({ active: true }),
            AbuseReport.countDocuments({ $or: [{ status: "pending" }, { status: { $exists: false } }] }),
            Report.find({ status: "pending", severity: { $in: ["High", "Critical"] } })
                .sort({ date: -1, _id: -1 }).limit(5).select("title status severity date").lean()
        ]);

        const reports = { total: 0, pending: 0, accepted: 0, resolved: 0, fake: 0 };
        for (const row of byStatus) {
            if (row._id in reports) reports[row._id] = row.count;
            reports.total += row.count;
        }

        return res.status(200).json({
            success: true,
            stats: {
                reports, users, volunteers, pendingVolunteers,
                paidVolunteers, pendingPaidVolunteers: pendingPaid,
                ngos, pendingAbuseReports: pendingAbuse
            },
            priorityReports: priority
        });
    } catch (error) {
        return fail(res, error, "GET /dashboard-stats");
    }
});

// ───────────────────────── users ─────────────────────────

// GET /api/admin/users?page&limit&search&status=active|suspended
router.get("/users", validate(listRules, inRule("status", ["active", "suspended"])), async (req, res) => {
    try {
        const { page, limit, skip } = pageParams(req);
        const match = and(
            searchFilter(req, ["fullName", "email", "uid"]),
            req.query.status === "suspended" ? { isSuspended: true } : null,
            req.query.status === "active" ? { isSuspended: { $ne: true } } : null
        );

        const [users, total] = await Promise.all([
            User.aggregate([
                { $match: match },
                { $sort: { _id: -1 } },
                { $skip: skip },
                { $limit: limit },
                { $lookup: { from: "reports", localField: "uid", foreignField: "reporterUid", pipeline: [{ $count: "n" }], as: "rc" } },
                { $addFields: { reportsCount: { $ifNull: [{ $first: "$rc.n" }, 0] } } },
                { $project: { rc: 0, deviceToken: 0, location: 0 } }
            ]),
            User.countDocuments(match)
        ]);

        return res.status(200).json({ success: true, count: users.length, users, pagination: pageMeta(total, page, limit) });
    } catch (error) {
        return fail(res, error, "GET /users");
    }
});

// GET /api/admin/users/:uid/reports (bounded)
router.get("/users/:uid/reports", validate(uidParam()), async (req, res) => {
    try {
        const reports = await Report.find({ reporterUid: req.params.uid })
            .sort({ date: -1, _id: -1 })
            .limit(100)
            .select("title status severity date")
            .lean();

        return res.status(200).json({ success: true, reports });
    } catch (error) {
        return fail(res, error, "GET /users/:uid/reports");
    }
});

// POST /api/admin/users/:uid/suspend
router.post("/users/:uid/suspend", validate(uidParam(), reasonRule), async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || !reason.trim()) {
            return res.status(400).json({ success: false, message: "Suspension reason is required and cannot be empty." });
        }
        if (req.params.uid === req.adminUser.uid) {
            return res.status(400).json({ success: false, message: "You cannot suspend your own account." });
        }

        const user = await User.findOneAndUpdate(
            { uid: req.params.uid },
            {
                $set: {
                    isSuspended: true,
                    suspensionReason: reason.trim(),
                    suspendedAt: new Date(),
                    suspendedBy: req.adminUser.email || "Admin"
                }
            },
            { new: true, runValidators: true }
        ).select("-deviceToken");

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        await audit(req, "User Suspended", user.uid, reason);
        return res.status(200).json({ success: true, user });
    } catch (error) {
        return fail(res, error, "POST /users/:uid/suspend");
    }
});

// POST /api/admin/users/:uid/unsuspend
router.post("/users/:uid/unsuspend", validate(uidParam()), async (req, res) => {
    try {
        const user = await User.findOneAndUpdate(
            { uid: req.params.uid },
            { $set: { isSuspended: false, suspensionReason: null, suspendedAt: null, suspendedBy: null } },
            { new: true, runValidators: true }
        ).select("-deviceToken");

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        await audit(req, "User Unsuspended", user.uid, "Account activated by admin");
        return res.status(200).json({ success: true, user });
    } catch (error) {
        return fail(res, error, "POST /users/:uid/unsuspend");
    }
});

// ───────────────────────── regular volunteers ─────────────────────────

const VOLUNTEER_STATUSES = ["pending", "approved", "rejected", "suspended"];

// GET /api/admin/volunteers?page&limit&search&status=<volunteerStatus>
router.get("/volunteers", validate(listRules, inRule("status", VOLUNTEER_STATUSES)), async (req, res) => {
    try {
        const { page, limit, skip } = pageParams(req);
        const match = and(
            { $or: [{ isVolunteer: true }, { volunteerStatus: { $ne: "none" } }] },
            req.query.status ? { volunteerStatus: req.query.status } : null,
            searchFilter(req, ["fullName", "email", "uid"])
        );

        const [volunteers, total] = await Promise.all([
            User.aggregate([
                { $match: match },
                { $sort: { _id: -1 } },
                { $skip: skip },
                { $limit: limit },
                { $lookup: { from: "reports", localField: "uid", foreignField: "assignedVolunteer.uid", pipeline: [{ $group: { _id: "$status", n: { $sum: 1 } } }], as: "rc" } },
                {
                    $addFields: {
                        assignedReportsCount: { $sum: { $map: { input: { $filter: { input: "$rc", as: "r", cond: { $eq: ["$$r._id", "accepted"] } } }, as: "r", in: "$$r.n" } } },
                        completedRescuesCount: { $sum: { $map: { input: { $filter: { input: "$rc", as: "r", cond: { $eq: ["$$r._id", "resolved"] } } }, as: "r", in: "$$r.n" } } }
                    }
                },
                { $project: { rc: 0, deviceToken: 0, location: 0 } }
            ]),
            User.countDocuments(match)
        ]);

        return res.status(200).json({ success: true, count: volunteers.length, volunteers, pagination: pageMeta(total, page, limit) });
    } catch (error) {
        return fail(res, error, "GET /volunteers");
    }
});

async function setVolunteerStatus(req, res, { update, action, reason, notFound }) {
    try {
        const user = await User.findOneAndUpdate({ uid: req.params.uid }, { $set: update }, { new: true, runValidators: true })
            .select("-deviceToken");
        if (!user) {
            return res.status(404).json({ success: false, message: notFound });
        }
        await audit(req, action, user.uid, reason);
        return res.status(200).json({ success: true, user });
    } catch (error) {
        return fail(res, error, action);
    }
}

// POST /api/admin/volunteers/:uid/approve
router.post("/volunteers/:uid/approve", validate(uidParam()), (req, res) =>
    setVolunteerStatus(req, res, {
        update: { volunteerStatus: "approved", isVolunteer: true, volunteerSuspensionReason: null, volunteerSuspendedAt: null, volunteerSuspendedBy: null },
        action: "Volunteer Approved", reason: "Application approved by admin", notFound: "Volunteer profile not found."
    }));

// POST /api/admin/volunteers/:uid/reject
router.post("/volunteers/:uid/reject", validate(uidParam(), reasonRule), (req, res) => {
    const reason = (req.body.reason || "").trim();
    if (!reason) return res.status(400).json({ success: false, message: "Rejection reason is required." });
    return setVolunteerStatus(req, res, {
        update: { volunteerStatus: "rejected", isVolunteer: false, volunteerSuspensionReason: reason, volunteerSuspendedAt: new Date(), volunteerSuspendedBy: req.adminUser.email || "Admin" },
        action: "Volunteer Rejected", reason, notFound: "Volunteer profile not found."
    });
});

// POST /api/admin/volunteers/:uid/suspend
router.post("/volunteers/:uid/suspend", validate(uidParam(), reasonRule), (req, res) => {
    const reason = (req.body.reason || "").trim();
    if (!reason) return res.status(400).json({ success: false, message: "Suspension reason is required." });
    return setVolunteerStatus(req, res, {
        update: { volunteerStatus: "suspended", volunteerSuspensionReason: reason, volunteerSuspendedAt: new Date(), volunteerSuspendedBy: req.adminUser.email || "Admin" },
        action: "Volunteer Suspended", reason, notFound: "Volunteer profile not found."
    });
});

// POST /api/admin/volunteers/:uid/unsuspend
router.post("/volunteers/:uid/unsuspend", validate(uidParam()), (req, res) =>
    setVolunteerStatus(req, res, {
        update: { volunteerStatus: "approved", isVolunteer: true, volunteerSuspensionReason: null, volunteerSuspendedAt: null, volunteerSuspendedBy: null },
        action: "Volunteer Unsuspended", reason: "Volunteer reinstated by admin", notFound: "Volunteer profile not found."
    }));

// ───────────────────────── paid volunteers ─────────────────────────
// Separate identity/lifecycle from regular volunteers (isPaidVolunteer / paidVolunteerStatus).

const PAID_STATUSES = ["pending", "approved", "rejected", "suspended"];
const PAID_FIELDS = "uid email fullName phone city isPaidVolunteer paidVolunteerStatus paidVolunteerReason paidVolunteerReviewedAt paidVolunteerReviewedBy rescueRadius isAvailable createdAt lastActivityAt isSuspended";

// GET /api/admin/paid-volunteers?page&limit&search&status
router.get("/paid-volunteers", validate(listRules, inRule("status", PAID_STATUSES)), async (req, res) => {
    try {
        const { page, limit, skip } = pageParams(req);
        const match = and(
            { $or: [{ isPaidVolunteer: true }, { paidVolunteerStatus: { $in: ["pending", "approved", "rejected", "suspended"] } }] },
            req.query.status ? { paidVolunteerStatus: req.query.status } : null,
            searchFilter(req, ["fullName", "email", "uid"])
        );

        const [paidVolunteers, total] = await Promise.all([
            User.find(match).sort({ _id: -1 }).skip(skip).limit(limit).select(PAID_FIELDS).lean(),
            User.countDocuments(match)
        ]);

        return res.status(200).json({ success: true, count: paidVolunteers.length, paidVolunteers, pagination: pageMeta(total, page, limit) });
    } catch (error) {
        return fail(res, error, "GET /paid-volunteers");
    }
});

// Allowed source states per action (enforced atomically in the update filter).
const PAID_TRANSITIONS = {
    approve: {
        from: { $or: [{ paidVolunteerStatus: { $in: ["pending", "rejected"] } }, { isPaidVolunteer: true, paidVolunteerStatus: "none" }] },
        to: "approved", flag: true, action: "Paid Volunteer Approved", needsReason: false
    },
    reject: { from: { paidVolunteerStatus: "pending" }, to: "rejected", flag: false, action: "Paid Volunteer Rejected", needsReason: true },
    suspend: { from: { paidVolunteerStatus: "approved" }, to: "suspended", flag: null, action: "Paid Volunteer Suspended", needsReason: true },
    unsuspend: { from: { paidVolunteerStatus: "suspended" }, to: "approved", flag: true, action: "Paid Volunteer Unsuspended", needsReason: false }
};

for (const [name, t] of Object.entries(PAID_TRANSITIONS)) {
    const rules = t.needsReason ? [uidParam(), reasonRule] : [uidParam()];
    router.post(`/paid-volunteers/:uid/${name}`, validate(...rules), async (req, res) => {
        try {
            const reason = t.needsReason ? (req.body.reason || "").trim() : (name === "approve" ? "Approved by admin" : "Reinstated by admin");
            if (t.needsReason && !reason) {
                return res.status(400).json({ success: false, message: "A reason is required." });
            }

            const set = {
                paidVolunteerStatus: t.to,
                paidVolunteerReason: t.needsReason ? reason : null,
                paidVolunteerReviewedAt: new Date(),
                paidVolunteerReviewedBy: req.adminUser.email || req.adminUser.uid
            };
            if (t.flag !== null) set.isPaidVolunteer = t.flag;

            const user = await User.findOneAndUpdate(
                { $and: [{ uid: req.params.uid }, t.from] },
                { $set: set },
                { new: true, runValidators: true }
            ).select(PAID_FIELDS);

            if (!user) {
                const existing = await User.findOne({ uid: req.params.uid }).select("paidVolunteerStatus").lean();
                if (!existing) return res.status(404).json({ success: false, message: "User not found." });
                return res.status(409).json({
                    success: false,
                    message: `Cannot ${name} a paid volunteer whose status is "${existing.paidVolunteerStatus}".`
                });
            }

            await audit(req, t.action, user.uid, reason);
            return res.status(200).json({ success: true, user });
        } catch (error) {
            return fail(res, error, `POST /paid-volunteers/:uid/${name}`);
        }
    });
}

// ───────────────────────── audit logs ─────────────────────────

// GET /api/admin/audit-logs?page&limit&search&action
router.get("/audit-logs", validate(listRules, inRule("action", AuditLog.schema.path("action").enumValues)), async (req, res) => {
    try {
        const { page, limit, skip } = pageParams(req);
        const match = and(
            req.query.action ? { action: req.query.action } : null,
            searchFilter(req, ["adminEmail", "targetId", "reason"])
        );

        const [logs, total] = await Promise.all([
            AuditLog.find(match).sort({ timestamp: -1, _id: -1 }).skip(skip).limit(limit).lean(),
            AuditLog.countDocuments(match)
        ]);

        return res.status(200).json({ success: true, count: logs.length, logs, pagination: pageMeta(total, page, limit) });
    } catch (error) {
        return fail(res, error, "GET /audit-logs");
    }
});

// ───────────────────────── reports ─────────────────────────

const REPORT_STATUSES = ["pending", "accepted", "resolved", "fake"];
const REPORT_ADMIN_SELECT = "-reporterDeviceToken -assistance.notifiedVolunteerUids";

// GET /api/admin/reports?page&limit&search&status&from&to
router.get("/reports", validate(
    listRules,
    inRule("status", REPORT_STATUSES),
    query("from").optional().isISO8601().withMessage("from must be an ISO date"),
    query("to").optional().isISO8601().withMessage("to must be an ISO date")
), async (req, res) => {
    try {
        const { page, limit, skip } = pageParams(req);
        const s = typeof req.query.search === "string" ? req.query.search.trim() : "";
        const dateRange = (req.query.from || req.query.to)
            ? { date: { ...(req.query.from && { $gte: new Date(req.query.from) }), ...(req.query.to && { $lte: new Date(req.query.to) }) } }
            : null;
        const idMatch = /^[a-f\d]{24}$/i.test(s) ? { _id: s } : null;
        const textMatch = s ? searchFilter(req, ["title", "reporterName", "reporterUid"]) : null;
        const match = and(
            req.query.status ? { status: req.query.status } : null,
            dateRange,
            idMatch ? { $or: [idMatch, ...textMatch.$or] } : textMatch
        );

        const [reports, total] = await Promise.all([
            Report.find(match).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).select(REPORT_ADMIN_SELECT).lean(),
            Report.countDocuments(match)
        ]);

        return res.status(200).json({ success: true, count: reports.length, reports, pagination: pageMeta(total, page, limit) });
    } catch (error) {
        return fail(res, error, "GET /reports");
    }
});

// GET /api/admin/reports/:id — full moderation detail (includes reporter contact; never the device token).
router.get("/reports/:id", async (req, res) => {
    try {
        const report = await Report.findById(req.params.id).select(REPORT_ADMIN_SELECT).lean();
        if (!report) {
            return res.status(404).json({ success: false, message: "Report not found" });
        }
        const transfer = await NgoTransfer.findOne({ reportId: report._id })
            .sort({ requestedAt: -1 })
            .select("status ngoSnapshot requestedAt acceptedAt rejectedAt cancelledAt closedAt")
            .lean();

        return res.status(200).json({ success: true, report, transfer });
    } catch (error) {
        return fail(res, error, "GET /reports/:id");
    }
});

function getAdminReportStatusUpdate(status, options = {}) {
    const clearAssistance = {
        status: status,
        "assistance.status": "none",
        "assistance.requestedByUid": null,
        "assistance.requestedAt": null,
        "assistance.acceptedByUid": null,
        "assistance.acceptedAt": null,
        "assistance.acceptedByName": "",
        "assistance.acceptedByPhone": ""
    };
    const clearHandling = { assignedVolunteer: "", acceptedAt: "", resolvedAt: "", resolutionRemark: "", resolvedBy: "" };

    if (status === "pending" || status === "fake") return { $set: clearAssistance, $unset: clearHandling };
    if (status === "resolved") {
        return {
            $set: {
                status: "resolved",
                resolutionRemark: options.resolutionRemark,
                resolvedBy: options.resolvedBy,
                resolverRole: "admin",
                resolvedAt: new Date()
            }
        };
    }
    return null;
}

// Atomic transition. Refuses no-op transitions (409) and reports owned by an NGO (409), so admin
// moderation cannot bypass the NGO-transfer ownership rules.
async function transitionReport(req, res, status, options, auditAction, auditReason) {
    try {
        const update = getAdminReportStatusUpdate(status, options);
        const report = await Report.findOneAndUpdate(
            { _id: req.params.id, status: { $ne: status }, currentHandlerType: { $ne: "ngo" } },
            update,
            { new: true, runValidators: true }
        ).select(REPORT_ADMIN_SELECT);

        if (!report) {
            const existing = await Report.findById(req.params.id).select("status currentHandlerType").lean();
            if (!existing) return res.status(404).json({ success: false, message: "Report not found" });
            if (existing.currentHandlerType === "ngo") {
                return res.status(409).json({ success: false, message: "This rescue is owned by an NGO. It must be closed by the NGO before an admin can change it." });
            }
            return res.status(409).json({ success: false, message: `Report is already ${status}.` });
        }

        if (status === "fake") {
            await AbuseReport.updateMany(
                { reportId: report._id, $or: [{ status: "pending" }, { status: { $exists: false } }] },
                { $set: { status: "action_taken", reviewedByUid: req.adminUser.uid, reviewedByEmail: req.adminUser.email || "", reviewedAt: new Date() } }
            );
        }

        await audit(req, auditAction, report._id, auditReason);
        return res.status(200).json({ success: true, report });
    } catch (error) {
        return fail(res, error, `report transition -> ${status}`);
    }
}

// PATCH /api/admin/reports/:id/resolve
router.patch("/reports/:id/resolve", validate(resolveRules), (req, res) => {
    const resolutionRemark = (req.body.resolutionRemark || "").trim();
    if (!resolutionRemark) {
        return res.status(400).json({ success: false, message: "Resolution remark is required." });
    }
    return transitionReport(
        req, res, "resolved",
        { resolutionRemark, resolvedBy: req.adminUser.email || req.adminUser.uid },
        "Report Resolved", resolutionRemark
    );
});

// PATCH /api/admin/reports/:id/fake
router.patch("/reports/:id/fake", (req, res) =>
    transitionReport(req, res, "fake", {}, "Report Marked Fake", "Marked fake by admin"));

// PATCH /api/admin/reports/:id/pending
router.patch("/reports/:id/pending", (req, res) =>
    transitionReport(req, res, "pending", {}, "Report Marked Pending", "Returned to pending by admin"));

// DELETE /api/admin/reports/:id
router.delete("/reports/:id", async (req, res) => {
    try {
        const report = await Report.findOneAndDelete({ _id: req.params.id, currentHandlerType: { $ne: "ngo" } });

        if (!report) {
            const existing = await Report.findById(req.params.id).select("_id").lean();
            if (!existing) return res.status(404).json({ success: false, message: "Report not found" });
            return res.status(409).json({ success: false, message: "This rescue is owned by an NGO and cannot be deleted." });
        }

        // Keep abuse records for traceability; they are resolved rather than deleted.
        await AbuseReport.updateMany(
            { reportId: report._id, $or: [{ status: "pending" }, { status: { $exists: false } }] },
            { $set: { status: "action_taken", reviewedByUid: req.adminUser.uid, reviewedByEmail: req.adminUser.email || "", reviewedAt: new Date(), reviewNote: "Report deleted" } }
        );

        await audit(req, "Report Deleted", report._id, `Deleted report "${report.title}"`);
        return res.status(200).json({ success: true, message: "Report deleted" });
    } catch (error) {
        return fail(res, error, "DELETE /reports/:id");
    }
});

// ───────────────────────── moderation (abuse flags) ─────────────────────────

const pendingAbuse = { $or: [{ status: "pending" }, { status: { $exists: false } }] };

// GET /api/admin/moderation?page&limit&status=pending|dismissed|action_taken|all (default pending)
router.get("/moderation", validate(pagination, inRule("status", ["pending", "dismissed", "action_taken", "all"])), async (req, res) => {
    try {
        const { page, limit, skip } = pageParams(req);
        const status = req.query.status || "pending";
        const match = status === "all" ? {} : status === "pending" ? pendingAbuse : { status };

        const [abuseReports, total] = await Promise.all([
            AbuseReport.find(match).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
            AbuseReport.countDocuments(match)
        ]);

        const reports = await Report.find({ _id: { $in: abuseReports.map((a) => a.reportId) } })
            .select("title status severity reporterName reporterUid date")
            .lean();
        const reportById = new Map(reports.map((r) => [String(r._id), r]));

        const items = abuseReports.map((abuseReport) => ({
            abuseReport: { ...abuseReport, status: abuseReport.status || "pending" },
            report: reportById.get(String(abuseReport.reportId)) || null
        }));

        return res.status(200).json({ success: true, count: items.length, items, pagination: pageMeta(total, page, limit) });
    } catch (error) {
        return fail(res, error, "GET /moderation");
    }
});

// PATCH /api/admin/moderation/:id/dismiss — dismiss a flag without touching the rescue report.
router.patch("/moderation/:id/dismiss", validate(str("note", 500)), async (req, res) => {
    try {
        const abuse = await AbuseReport.findOneAndUpdate(
            { _id: req.params.id, ...pendingAbuse },
            {
                $set: {
                    status: "dismissed",
                    reviewedByUid: req.adminUser.uid,
                    reviewedByEmail: req.adminUser.email || "",
                    reviewedAt: new Date(),
                    reviewNote: typeof req.body.note === "string" ? req.body.note.trim() : ""
                }
            },
            { new: true }
        ).lean();

        if (!abuse) {
            const existing = await AbuseReport.findById(req.params.id).select("status").lean();
            if (!existing) return res.status(404).json({ success: false, message: "Abuse report not found" });
            return res.status(409).json({ success: false, message: `Abuse report is already ${existing.status}.` });
        }

        await audit(req, "Abuse Report Dismissed", abuse._id, `Flag "${abuse.reason}" on report ${abuse.reportId}`);
        return res.status(200).json({ success: true, abuseReport: abuse });
    } catch (error) {
        return fail(res, error, "PATCH /moderation/:id/dismiss");
    }
});

// ───────────────────────── NGOs ─────────────────────────

// GET /api/admin/ngos?page&limit&search&active=true|false
router.get("/ngos", validate(listRules, inRule("active", ["true", "false"])), async (req, res) => {
    try {
        const { page, limit, skip } = pageParams(req);
        const match = and(
            searchFilter(req, ["name", "email"]),
            req.query.active ? { active: req.query.active === "true" } : null
        );

        const [ngos, total] = await Promise.all([
            Ngo.aggregate([
                { $match: match },
                { $sort: { createdAt: -1, _id: -1 } },
                { $skip: skip },
                { $limit: limit },
                { $lookup: { from: "users", localField: "_id", foreignField: "ngoId", pipeline: [{ $count: "n" }], as: "mc" } },
                { $addFields: { memberCount: { $ifNull: [{ $first: "$mc.n" }, 0] } } },
                { $project: { mc: 0 } }
            ]),
            Ngo.countDocuments(match)
        ]);

        return res.status(200).json({ success: true, count: ngos.length, ngos, pagination: pageMeta(total, page, limit) });
    } catch (error) {
        return fail(res, error, "GET /ngos");
    }
});

// GET /api/admin/ngos/:id/members
router.get("/ngos/:id/members", async (req, res) => {
    try {
        const members = await User.find({ ngoId: req.params.id })
            .sort({ createdAt: 1, _id: 1 })
            .limit(200)
            .select("uid email fullName phone role isSuspended suspensionReason createdAt lastActivityAt")
            .lean();
        return res.status(200).json({ success: true, count: members.length, members });
    } catch (error) {
        return fail(res, error, "GET /ngos/:id/members");
    }
});

// POST /api/admin/ngos — provisions Firebase account + NGO + ngo_admin user.
// Credentials are returned ONCE in this response, are never logged or stored in the audit trail.
// ponytail: no forced-password-change flag exists in the auth architecture; the admin must tell the NGO
// to change the temporary password after first login (upgrade path: Firebase password-reset link).
router.post("/ngos", validate(ngoCreateRules), async (req, res) => {
    const firebaseAdmin = require("../firebase-admin.js");
    let userRecord = null;
    let ngo = null;
    try {
        const name = req.body.name.trim();
        const email = req.body.email.trim();
        const phone = req.body.phone.trim();
        const address = typeof req.body.address === "string" ? req.body.address.trim() : "";
        const generated = !req.body.password;
        const password = req.body.password || crypto.randomBytes(12).toString("base64url");

        try {
            userRecord = await firebaseAdmin.auth().createUser({
                email,
                password,
                displayName: name,
                phoneNumber: phone.startsWith("+") ? phone : undefined // Firebase requires E.164
            });
        } catch (firebaseError) {
            console.error("[admin] POST /ngos firebase createUser failed:", firebaseError.code || firebaseError.message);
            const known = {
                "auth/email-already-exists": [409, "An account with this email already exists."],
                "auth/phone-number-already-exists": [409, "An account with this phone number already exists."],
                "auth/invalid-phone-number": [400, "Phone number must be in E.164 format (e.g. +911234567890)."],
                "auth/invalid-password": [400, "Password is not accepted."],
                "auth/invalid-email": [400, "Email is invalid."]
            }[firebaseError.code];
            return res.status(known ? known[0] : 500).json({ success: false, message: known ? known[1] : "Failed to create NGO login account." });
        }

        try {
            ngo = await Ngo.create({ name, email, phone, address, active: req.body.active !== false });
            const user = await User.create({
                uid: userRecord.uid,
                email,
                fullName: name,
                phone,
                role: "ngo_admin",
                ngoId: ngo._id,
                location: { type: "Point", coordinates: [0, 0] }
            });

            await audit(req, "NGO Created", ngo._id, `NGO "${name}" created`);
            return res.status(201).json({
                success: true,
                ngo,
                user: { uid: user.uid, email: user.email, role: user.role },
                credentials: { email, password, temporary: generated }
            });
        } catch (dbError) {
            // Roll back everything created so far so retries are clean.
            await firebaseAdmin.auth().deleteUser(userRecord.uid).catch((e) => console.error("[admin] rollback firebase failed:", e.message));
            if (ngo) await Ngo.deleteOne({ _id: ngo._id }).catch((e) => console.error("[admin] rollback ngo failed:", e.message));
            throw dbError;
        }
    } catch (error) {
        return fail(res, error, "POST /ngos");
    }
});

const NGO_ARCHIVE_REASON = "NGO partner archived by admin";

// PATCH /api/admin/ngos/:id
router.patch("/ngos/:id", validate(ngoPatchRules), async (req, res) => {
    try {
        const { id } = req.params;
        const updates = {};

        if (typeof req.body.name === "string" && req.body.name.trim()) updates.name = req.body.name.trim();
        if (typeof req.body.contactEmail === "string" && req.body.contactEmail.trim()) updates.contactEmail = req.body.contactEmail.trim();
        if (typeof req.body.phone === "string") updates.phone = req.body.phone.trim();
        if (typeof req.body.city === "string") updates.city = req.body.city.trim();
        if (typeof req.body.active === "boolean") {
            updates.active = req.body.active;
            if (req.body.active) updates.archivedAt = null; // reactivation un-archives
        }

        if (!Object.keys(updates).length) {
            return res.status(400).json({ success: false, message: "No valid fields to update" });
        }

        const ngo = await Ngo.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
        if (!ngo) {
            return res.status(404).json({ success: false, message: "NGO not found" });
        }

        // Reinstate only the members that archiving suspended (never ones suspended for other reasons).
        if (updates.active === true) {
            await User.updateMany(
                { ngoId: id, isSuspended: true, suspensionReason: NGO_ARCHIVE_REASON },
                { $set: { isSuspended: false, suspensionReason: null, suspendedAt: null, suspendedBy: null } }
            );
        }

        await audit(req, "NGO Updated", ngo._id, `Updated fields: ${Object.keys(updates).join(", ")}`);
        return res.status(200).json({ success: true, ngo });
    } catch (error) {
        return fail(res, error, "PATCH /ngos/:id");
    }
});

// DELETE /api/admin/ngos/:id — SOFT delete (archive). Nothing is deleted; Firebase accounts are untouched.
// Steps are individually idempotent so a failed call can simply be retried.
router.delete("/ngos/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const ngo = await Ngo.findById(id);
        if (!ngo) {
            return res.status(404).json({ success: false, message: "NGO not found" });
        }

        const activeCases = await NgoTransfer.countDocuments({ ngoId: id, status: "accepted" });
        if (activeCases > 0) {
            return res.status(409).json({
                success: false,
                message: `This NGO still owns ${activeCases} active rescue case(s). They must be closed before the NGO can be archived.`
            });
        }

        // 1. Deactivate (first, so no new transfers can target it).
        await Ngo.updateOne({ _id: id }, { $set: { active: false, archivedAt: ngo.archivedAt || new Date() } });

        // 2. Cancel pending transfers and release their reports.
        const pending = await NgoTransfer.find({ ngoId: id, status: "pending" }).select("_id reportId").lean();
        if (pending.length) {
            await Report.updateMany(
                { _id: { $in: pending.map((t) => t.reportId) }, transferStatus: "pending" },
                { $set: { transferStatus: "none" } }
            );
            await NgoTransfer.updateMany(
                { _id: { $in: pending.map((t) => t._id) }, status: "pending" },
                { $set: { status: "cancelled", cancelledAt: new Date(), remarks: "NGO archived by admin" } }
            );
        }

        // 3. Block member logins (requireNgo rejects suspended users).
        const suspended = await User.updateMany(
            { ngoId: id, role: { $in: ["ngo_admin", "ngo_member"] }, isSuspended: { $ne: true } },
            { $set: { isSuspended: true, suspensionReason: NGO_ARCHIVE_REASON, suspendedAt: new Date(), suspendedBy: req.adminUser.email || "Admin" } }
        );

        await audit(req, "NGO Archived", id, `Archived "${ngo.name}"; ${suspended.modifiedCount} member(s) suspended, ${pending.length} pending transfer(s) cancelled`);
        return res.status(200).json({
            success: true,
            message: "NGO archived",
            membersSuspended: suspended.modifiedCount,
            transfersCancelled: pending.length
        });
    } catch (error) {
        return fail(res, error, "DELETE /ngos/:id");
    }
});

// GET /api/admin/ngo-transfers?page&limit&status&ngoId — read-only view of the existing transfer workflow.
router.get("/ngo-transfers", validate(
    pagination,
    inRule("status", ["pending", "accepted", "rejected", "cancelled", "closed"]),
    query("ngoId").optional().isMongoId().withMessage("ngoId must be a valid id")
), async (req, res) => {
    try {
        const { page, limit, skip } = pageParams(req);
        const match = and(
            req.query.status ? { status: req.query.status } : null,
            req.query.ngoId ? { ngoId: req.query.ngoId } : null
        );

        const [transfers, total] = await Promise.all([
            NgoTransfer.find(match)
                .sort({ requestedAt: -1, _id: -1 }).skip(skip).limit(limit)
                .select("-animalSnapshot")
                .populate("reportId", "title status severity currentHandlerType transferStatus currentNgoId")
                .populate("ngoId", "name active")
                .lean(),
            NgoTransfer.countDocuments(match)
        ]);

        return res.status(200).json({ success: true, count: transfers.length, transfers, pagination: pageMeta(total, page, limit) });
    } catch (error) {
        return fail(res, error, "GET /ngo-transfers");
    }
});

// ───────────────────────── adoptions ─────────────────────────

// GET /api/admin/adoptions?page&limit&search&status
router.get("/adoptions", validate(listRules, inRule("status", ["pending", "approved", "rejected", "adopted"])), async (req, res) => {
    try {
        const { page, limit, skip } = pageParams(req);
        const match = and(
            req.query.status ? { status: req.query.status } : null,
            searchFilter(req, ["animalName", "species", "location.city", "location.state"])
        );

        const [adoptions, total] = await Promise.all([
            AdoptionListing.find(match).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
            AdoptionListing.countDocuments(match)
        ]);

        return res.status(200).json({ success: true, count: adoptions.length, adoptions, pagination: pageMeta(total, page, limit) });
    } catch (error) {
        return fail(res, error, "GET /adoptions");
    }
});

async function adoptionTransition(req, res, from, to, label) {
    try {
        const adoption = await AdoptionListing.findOneAndUpdate(
            { _id: req.params.id, status: from },
            { $set: { status: to } },
            { new: true }
        );
        if (!adoption) {
            const existing = await AdoptionListing.findById(req.params.id).select("_id").lean();
            if (!existing) return res.status(404).json({ success: false, message: "Adoption listing not found" });
            return res.status(409).json({ success: false, message: `Only ${from} listings can be ${label}.` });
        }
        return res.status(200).json({ success: true, adoption });
    } catch (error) {
        return fail(res, error, `adoption -> ${to}`);
    }
}

// POST /api/admin/adoptions/:id/approve | reject | adopted
router.post("/adoptions/:id/approve", (req, res) => adoptionTransition(req, res, "pending", "approved", "approved"));
router.post("/adoptions/:id/reject", (req, res) => adoptionTransition(req, res, "pending", "rejected", "rejected"));
router.post("/adoptions/:id/adopted", (req, res) => adoptionTransition(req, res, "approved", "adopted", "marked as adopted"));

// ───────────────────────── push announcements ─────────────────────────

const AUDIENCES = ["all", "volunteers", "paid_volunteers", "ngo_members", "user"];
const MAX_BROADCAST_RECIPIENTS = 5000;
const DUPLICATE_WINDOW_MS = 60 * 1000;

const audienceRules = [
    body("audience").isIn(AUDIENCES).withMessage(`audience must be one of ${AUDIENCES.join(", ")}`),
    body("uid").if(body("audience").equals("user")).isString().bail().isLength({ min: 1, max: 128 }).bail()
        .matches(/^[^\s\x00-\x1f\x7f]+$/).withMessage("uid is required for a single-user audience")
];

// Eligible = not suspended. Audience semantics mirror the existing notification eligibility rules.
function audienceFilter(audience, uid) {
    const base = { isSuspended: { $ne: true } };
    switch (audience) {
        case "volunteers": return { ...base, isVolunteer: true, volunteerStatus: "approved" };
        case "paid_volunteers": return { ...base, isPaidVolunteer: true, paidVolunteerStatus: "approved" };
        case "ngo_members": return { ...base, role: { $in: ["ngo_admin", "ngo_member"] }, ngoId: { $ne: null } };
        case "user": return { ...base, uid };
        default: return base;
    }
}

const hasToken = { deviceToken: { $exists: true, $nin: [null, ""] } };

// POST /api/admin/notifications/preview
router.post("/notifications/preview", validate(audienceRules), async (req, res) => {
    try {
        const filter = audienceFilter(req.body.audience, req.body.uid);
        const [recipientCount, tokenCount] = await Promise.all([
            User.countDocuments(filter),
            User.countDocuments({ ...filter, ...hasToken })
        ]);
        return res.status(200).json({ success: true, recipientCount, tokenCount, maxRecipients: MAX_BROADCAST_RECIPIENTS });
    } catch (error) {
        return fail(res, error, "POST /notifications/preview");
    }
});

const broadcastLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => req.authUid || "anonymous",
    validate: { keyGeneratorIpFallback: false },
    handler: (req, res) => res.status(429).json({ success: false, message: "Too many broadcasts. Try again in a few minutes." })
});

// POST /api/admin/notifications/broadcast
router.post("/notifications/broadcast", broadcastLimiter, validate(
    audienceRules,
    requiredStr("title", 100),
    requiredStr("body", 500),
    body("confirm").custom((v) => v === true).withMessage("confirm must be true to send a broadcast")
), async (req, res) => {
    let broadcast = null;
    try {
        const firebaseAdmin = require("../firebase-admin");
        if (!firebaseAdmin.isFirebaseAdminInitialized()) {
            return res.status(503).json({ success: false, message: "Push service is not available." });
        }

        const { audience, title, body: message } = req.body;
        const targetUid = audience === "user" ? req.body.uid : null;

        // Double-submit guard (non-atomic; the rate limit bounds the remaining race).
        const dup = await Broadcast.exists({
            sentByUid: req.adminUser.uid, audience, targetUid, title, body: message,
            createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) }
        });
        if (dup) {
            return res.status(409).json({ success: false, message: "An identical broadcast was just sent." });
        }

        const filter = audienceFilter(audience, targetUid);
        const count = await User.countDocuments(filter);
        if (count === 0) return res.status(400).json({ success: false, message: "No eligible recipients for this audience." });
        if (count > MAX_BROADCAST_RECIPIENTS) {
            return res.status(400).json({ success: false, message: `Audience too large (${count}). Maximum is ${MAX_BROADCAST_RECIPIENTS}.` });
        }

        const users = await User.find(filter).select("uid deviceToken").lean();
        const byUid = new Map(users.map((u) => [u.uid, u])); // dedupe recipients
        const tokens = [...new Set([...byUid.values()].map((u) => u.deviceToken).filter(Boolean))]; // dedupe tokens

        broadcast = await Broadcast.create({
            sentByUid: req.adminUser.uid,
            sentByEmail: req.adminUser.email || "",
            audience, targetUid, title, body: message,
            recipientCount: byUid.size,
            tokenCount: tokens.length
        });
        const broadcastId = String(broadcast._id);

        // In-app inbox records (type is separate from automated workflow notifications).
        await Notification.insertMany(
            [...byUid.keys()].map((recipientUid) => ({ recipientUid, type: "admin_announcement", title, body: message, broadcastId })),
            { ordered: false }
        );

        const push = tokens.length
            ? await sendAnnouncementMulticast(tokens, { title, body: message, data: { type: "admin_announcement", broadcastId } })
            : { accepted: 0, failed: 0, staleTokens: [] };

        let staleCleared = 0;
        if (push.staleTokens.length) {
            const r = await User.updateMany({ deviceToken: { $in: push.staleTokens } }, { $set: { deviceToken: null } });
            staleCleared = r.modifiedCount || 0;
        }

        const status = tokens.length && push.accepted === 0 ? "failed" : push.failed > 0 ? "partial" : "completed";
        broadcast = await Broadcast.findByIdAndUpdate(broadcast._id, {
            $set: { status, fcmAccepted: push.accepted, fcmFailed: push.failed, staleTokensCleared: staleCleared, completedAt: new Date() }
        }, { new: true });

        await audit(req, "Notification Broadcast", broadcastId, `${audience}${targetUid ? `:${targetUid}` : ""} | "${title}" | recipients=${byUid.size} fcmAccepted=${push.accepted} fcmFailed=${push.failed}`);

        return res.status(200).json({ success: true, broadcast });
    } catch (error) {
        if (broadcast) {
            await Broadcast.updateOne({ _id: broadcast._id }, { $set: { status: "failed", completedAt: new Date() } }).catch(() => {});
        }
        return fail(res, error, "POST /notifications/broadcast");
    }
});

// GET /api/admin/notifications/history?page&limit
router.get("/notifications/history", validate(pagination), async (req, res) => {
    try {
        const { page, limit, skip } = pageParams(req);
        const [items, total] = await Promise.all([
            Broadcast.find({}).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
            Broadcast.countDocuments({})
        ]);
        return res.status(200).json({ success: true, count: items.length, items, pagination: pageMeta(total, page, limit) });
    } catch (error) {
        return fail(res, error, "GET /notifications/history");
    }
});

module.exports = router;
