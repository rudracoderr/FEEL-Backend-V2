const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();
const validateMongoId = require("../middleware/validateObjectId");
router.param("id", validateMongoId("id"));

const User = require("../Models/usermodel");
const Report = require("../Models/report-model");
const AbuseReport = require("../Models/abuse-report-model");
const Ngo = require("../Models/ngo-model");
const AuditLog = require("../Models/audit-log-model");
const AdoptionListing = require("../Models/adoption-listing-model");
const requireAuth = require("../middleware/requireAuth");
const requireAdmin = require("../middleware/requireAdmin");

router.use(requireAuth);
router.use(requireAdmin);

function isValidObjectId(value) {
    return mongoose.Types.ObjectId.isValid(value);
}

function getAdminReportStatusUpdate(status, options = {}) {
    if (status === "pending") {
        return {
            $set: {
                status: "pending",
                "assistance.status": "none",
                "assistance.requestedByUid": null,
                "assistance.requestedAt": null,
                "assistance.acceptedByUid": null,
                "assistance.acceptedAt": null,
                "assistance.acceptedByName": "",
                "assistance.acceptedByPhone": ""
            },
            $unset: {
                assignedVolunteer: "",
                acceptedAt: "",
                resolvedAt: "",
                resolutionRemark: "",
                resolvedBy: ""
            }
        };
    }

    if (status === "resolved") {
        return {
            $set: {
                status: "resolved",
                resolutionRemark: options.resolutionRemark,
                resolvedBy: options.resolvedBy,
                resolvedAt: new Date()
            }
        };
    }

    if (status === "fake") {
        return {
            $set: {
                status: "fake",
                "assistance.status": "none",
                "assistance.requestedByUid": null,
                "assistance.requestedAt": null,
                "assistance.acceptedByUid": null,
                "assistance.acceptedAt": null,
                "assistance.acceptedByName": "",
                "assistance.acceptedByPhone": ""
            },
            $unset: {
                assignedVolunteer: "",
                acceptedAt: "",
                resolvedAt: "",
                resolutionRemark: "",
                resolvedBy: ""
            }
        };
    }

    return null;
}

async function updateAdminReportStatus(id, status, options = {}) {
    const update = getAdminReportStatusUpdate(status, options);

    if (!update) {
        throw new Error("Unsupported report status");
    }

    return Report.findByIdAndUpdate(
        id,
        update,
        { new: true, runValidators: true }
    );
}

// GET /api/admin/users
router.get("/users", async (req, res) => {
    try {
        const users = await User.aggregate([
            {
                $lookup: {
                    from: "reports",
                    localField: "uid",
                    foreignField: "reporterUid",
                    as: "reports"
                }
            },
            {
                $addFields: {
                    reportsCount: { $size: "$reports" }
                }
            },
            {
                $project: {
                    reports: 0
                }
            },
            {
                $sort: { _id: -1 }
            }
        ]);

        return res.status(200).json({
            success: true,
            count: users.length,
            users
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// GET /api/admin/users/:uid/reports
router.get("/users/:uid/reports", async (req, res) => {
    try {
        const reports = await Report.find({ reporterUid: req.params.uid })
            .sort({ date: -1, _id: -1 })
            .lean();

        return res.status(200).json({
            success: true,
            reports
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// POST /api/admin/users/:uid/suspend
router.post("/users/:uid/suspend", async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || !reason.trim()) {
            return res.status(400).json({
                success: false,
                message: "Suspension reason is required and cannot be empty."
            });
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
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        // Create audit log
        await AuditLog.create({
            adminId: req.adminUser.uid,
            adminEmail: req.adminUser.email,
            action: "User Suspended",
            targetId: user.uid,
            reason: reason.trim()
        });

        return res.status(200).json({
            success: true,
            user
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// POST /api/admin/users/:uid/unsuspend
router.post("/users/:uid/unsuspend", async (req, res) => {
    try {
        const user = await User.findOneAndUpdate(
            { uid: req.params.uid },
            {
                $set: {
                    isSuspended: false,
                    suspensionReason: null,
                    suspendedAt: null,
                    suspendedBy: null
                }
            },
            { new: true, runValidators: true }
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        // Create audit log
        await AuditLog.create({
            adminId: req.adminUser.uid,
            adminEmail: req.adminUser.email,
            action: "User Unsuspended",
            targetId: user.uid,
            reason: "Account activated by admin"
        });

        return res.status(200).json({
            success: true,
            user
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// GET /api/admin/volunteers
router.get("/volunteers", async (req, res) => {
    try {
        const volunteers = await User.aggregate([
            {
                $match: {
                    $or: [
                        { isVolunteer: true },
                        { volunteerStatus: { $ne: "none" } }
                    ]
                }
            },
            {
                $lookup: {
                    from: "reports",
                    let: { volunteerUid: "$uid" },
                    pipeline: [
                        {
                            $match: {
                                $expr: { $eq: ["$assignedVolunteer.uid", "$$volunteerUid"] }
                            }
                        }
                    ],
                    as: "assignedReports"
                }
            },
            {
                $addFields: {
                    assignedReportsCount: {
                        $size: {
                            $filter: {
                                input: "$assignedReports",
                                as: "r",
                                cond: { $eq: ["$$r.status", "accepted"] }
                            }
                        }
                    },
                    completedRescuesCount: {
                        $size: {
                            $filter: {
                                input: "$assignedReports",
                                as: "r",
                                cond: { $eq: ["$$r.status", "resolved"] }
                            }
                        }
                    }
                }
            },
            {
                $project: {
                    assignedReports: 0
                }
            },
            {
                $sort: { _id: -1 }
            }
        ]);

        return res.status(200).json({
            success: true,
            count: volunteers.length,
            volunteers
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// POST /api/admin/volunteers/:uid/approve
router.post("/volunteers/:uid/approve", async (req, res) => {
    try {
        const user = await User.findOneAndUpdate(
            { uid: req.params.uid },
            {
                $set: {
                    volunteerStatus: "approved",
                    isVolunteer: true,
                    volunteerSuspensionReason: null,
                    volunteerSuspendedAt: null,
                    volunteerSuspendedBy: null
                }
            },
            { new: true, runValidators: true }
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "Volunteer profile not found."
            });
        }

        // Create audit log
        await AuditLog.create({
            adminId: req.adminUser.uid,
            adminEmail: req.adminUser.email,
            action: "Volunteer Approved",
            targetId: user.uid,
            reason: "Application approved by admin"
        });

        return res.status(200).json({
            success: true,
            user
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// POST /api/admin/volunteers/:uid/reject
router.post("/volunteers/:uid/reject", async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || !reason.trim()) {
            return res.status(400).json({
                success: false,
                message: "Rejection reason is required."
            });
        }

        const user = await User.findOneAndUpdate(
            { uid: req.params.uid },
            {
                $set: {
                    volunteerStatus: "rejected",
                    isVolunteer: false,
                    volunteerSuspensionReason: reason.trim(),
                    volunteerSuspendedAt: new Date(),
                    volunteerSuspendedBy: req.adminUser.email || "Admin"
                }
            },
            { new: true, runValidators: true }
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "Volunteer profile not found."
            });
        }

        // Create audit log
        await AuditLog.create({
            adminId: req.adminUser.uid,
            adminEmail: req.adminUser.email,
            action: "Volunteer Rejected",
            targetId: user.uid,
            reason: reason.trim()
        });

        return res.status(200).json({
            success: true,
            user
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// POST /api/admin/volunteers/:uid/suspend
router.post("/volunteers/:uid/suspend", async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || !reason.trim()) {
            return res.status(400).json({
                success: false,
                message: "Suspension reason is required."
            });
        }

        const user = await User.findOneAndUpdate(
            { uid: req.params.uid },
            {
                $set: {
                    volunteerStatus: "suspended",
                    volunteerSuspensionReason: reason.trim(),
                    volunteerSuspendedAt: new Date(),
                    volunteerSuspendedBy: req.adminUser.email || "Admin"
                }
            },
            { new: true, runValidators: true }
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "Volunteer profile not found."
            });
        }

        // Create audit log
        await AuditLog.create({
            adminId: req.adminUser.uid,
            adminEmail: req.adminUser.email,
            action: "Volunteer Suspended",
            targetId: user.uid,
            reason: reason.trim()
        });

        return res.status(200).json({
            success: true,
            user
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// POST /api/admin/volunteers/:uid/unsuspend
router.post("/volunteers/:uid/unsuspend", async (req, res) => {
    try {
        const user = await User.findOneAndUpdate(
            { uid: req.params.uid },
            {
                $set: {
                    volunteerStatus: "approved",
                    isVolunteer: true,
                    volunteerSuspensionReason: null,
                    volunteerSuspendedAt: null,
                    volunteerSuspendedBy: null
                }
            },
            { new: true, runValidators: true }
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "Volunteer profile not found."
            });
        }

        // Create audit log
        await AuditLog.create({
            adminId: req.adminUser.uid,
            adminEmail: req.adminUser.email,
            action: "Volunteer Unsuspended",
            targetId: user.uid,
            reason: "Volunteer reinstated by admin"
        });

        return res.status(200).json({
            success: true,
            user
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// GET /api/admin/audit-logs
router.get("/audit-logs", async (req, res) => {
    try {
        const logs = await AuditLog.find()
            .sort({ timestamp: -1 })
            .lean();

        return res.status(200).json({
            success: true,
            count: logs.length,
            logs
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// GET /api/admin/reports
router.get("/reports", async (req, res) => {
    try {
        const reports = await Report.find()
            .sort({ date: -1, _id: -1 })
            .lean();

        return res.status(200).json({
            success: true,
            count: reports.length,
            reports
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// GET /api/admin/moderation
router.get("/moderation", async (req, res) => {
    try {
        const abuseReports = await AbuseReport.find()
            .sort({ createdAt: -1 })
            .lean();

        const reportIds = [
            ...new Set(
                abuseReports
                    .map((item) => String(item.reportId))
                    .filter((id) => isValidObjectId(id))
            )
        ];

        const reports = await Report.find({ _id: { $in: reportIds } })
            .select("title status severity reporterName reporterUid date")
            .lean();

        const reportById = new Map(reports.map((report) => [String(report._id), report]));

        const items = abuseReports.map((abuseReport) => ({
            abuseReport,
            report: reportById.get(String(abuseReport.reportId)) || null
        }));

        return res.status(200).json({
            success: true,
            count: items.length,
            items
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// GET /api/admin/ngos
router.get("/ngos", async (req, res) => {
    try {
        const ngos = await Ngo.find()
            .sort({ createdAt: -1 })
            .lean();

        return res.status(200).json({
            success: true,
            count: ngos.length,
            ngos
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// POST /api/admin/ngos
router.post("/ngos", async (req, res) => {
    try {
        const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
        const contactEmail =
            typeof req.body.contactEmail === "string" ? req.body.contactEmail.trim() : "";

        if (!name || !contactEmail) {
            return res.status(400).json({
                success: false,
                message: "name and contactEmail are required"
            });
        }

        const ngo = await Ngo.create({
            name,
            contactEmail,
            phone: typeof req.body.phone === "string" ? req.body.phone.trim() : "",
            city: typeof req.body.city === "string" ? req.body.city.trim() : "",
            active: req.body.active !== false
        });

        return res.status(201).json({
            success: true,
            ngo
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// PATCH /api/admin/ngos/:id
router.patch("/ngos/:id", async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid NGO id"
            });
        }

        const updates = {};

        if (typeof req.body.name === "string" && req.body.name.trim()) {
            updates.name = req.body.name.trim();
        }
        if (typeof req.body.contactEmail === "string" && req.body.contactEmail.trim()) {
            updates.contactEmail = req.body.contactEmail.trim();
        }
        if (typeof req.body.phone === "string") {
            updates.phone = req.body.phone.trim();
        }
        if (typeof req.body.city === "string") {
            updates.city = req.body.city.trim();
        }
        if (typeof req.body.active === "boolean") {
            updates.active = req.body.active;
        }

        if (!Object.keys(updates).length) {
            return res.status(400).json({
                success: false,
                message: "No valid fields to update"
            });
        }

        const ngo = await Ngo.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });

        if (!ngo) {
            return res.status(404).json({
                success: false,
                message: "NGO not found"
            });
        }

        return res.status(200).json({
            success: true,
            ngo
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// DELETE /api/admin/ngos/:id
router.delete("/ngos/:id", async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid NGO id"
            });
        }

        const ngo = await Ngo.findByIdAndDelete(id);

        if (!ngo) {
            return res.status(404).json({
                success: false,
                message: "NGO not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "NGO deleted"
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// PATCH /api/admin/reports/:id/resolve
router.patch("/reports/:id/resolve", async (req, res) => {
    try {
        const { id } = req.params;
        const resolutionRemark = typeof req.body.resolutionRemark === "string"
            ? req.body.resolutionRemark.trim()
            : "";
        const resolvedBy = typeof req.body.resolvedBy === "string" && req.body.resolvedBy.trim()
            ? req.body.resolvedBy.trim()
            : req.authUid || "Admin";

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid report id"
            });
        }

        if (!resolutionRemark) {
            return res.status(400).json({
                success: false,
                message: "Resolution remark is required."
            });
        }

        const report = await Report.findById(id);

        if (!report) {
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        if (report.status === "resolved") {
            return res.status(409).json({
                success: false,
                message: "Report is already resolved."
            });
        }

        const updatedReport = await updateAdminReportStatus(id, "resolved", {
            resolutionRemark,
            resolvedBy
        });

        return res.status(200).json({
            success: true,
            report: updatedReport
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// PATCH /api/admin/reports/:id/fake
router.patch("/reports/:id/fake", async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid report id"
            });
        }

        const report = await Report.findById(id);

        if (!report) {
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        if (report.status === "fake") {
            return res.status(409).json({
                success: false,
                message: "Report is already marked fake."
            });
        }

        const updatedReport = await updateAdminReportStatus(id, "fake");

        return res.status(200).json({
            success: true,
            report: updatedReport
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// PATCH /api/admin/reports/:id/pending
router.patch("/reports/:id/pending", async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid report id"
            });
        }

        const report = await Report.findById(id);

        if (!report) {
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        if (report.status === "pending") {
            return res.status(409).json({
                success: false,
                message: "Report is already pending."
            });
        }

        const updatedReport = await updateAdminReportStatus(id, "pending");

        return res.status(200).json({
            success: true,
            report: updatedReport
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// DELETE /api/admin/reports/:id
router.delete("/reports/:id", async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid report id"
            });
        }

        const report = await Report.findByIdAndDelete(id);

        if (!report) {
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        await AbuseReport.deleteMany({ reportId: id });

        return res.status(200).json({
            success: true,
            message: "Report deleted"
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// GET /api/admin/adoptions
router.get("/adoptions", async (req, res) => {
    try {
        const adoptions = await AdoptionListing.find()
            .sort({ createdAt: -1 })
            .lean();

        return res.status(200).json({
            success: true,
            count: adoptions.length,
            adoptions
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// POST /api/admin/adoptions/:id/approve
router.post("/adoptions/:id/approve", async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: "Invalid adoption id" });
        }

        const adoption = await AdoptionListing.findById(id);
        if (!adoption) {
            return res.status(404).json({ success: false, message: "Adoption listing not found" });
        }

        if (adoption.status !== "pending") {
            return res.status(409).json({ success: false, message: "Only pending listings can be approved." });
        }

        const updatedAdoption = await AdoptionListing.findByIdAndUpdate(
            id,
            { $set: { status: "approved" } },
            { new: true }
        );

        return res.status(200).json({
            success: true,
            adoption: updatedAdoption
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// POST /api/admin/adoptions/:id/reject
router.post("/adoptions/:id/reject", async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: "Invalid adoption id" });
        }

        const adoption = await AdoptionListing.findById(id);
        if (!adoption) {
            return res.status(404).json({ success: false, message: "Adoption listing not found" });
        }

        if (adoption.status !== "pending") {
            return res.status(409).json({ success: false, message: "Only pending listings can be rejected." });
        }

        const updatedAdoption = await AdoptionListing.findByIdAndUpdate(
            id,
            { $set: { status: "rejected" } },
            { new: true }
        );

        return res.status(200).json({
            success: true,
            adoption: updatedAdoption
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// POST /api/admin/adoptions/:id/adopted
router.post("/adoptions/:id/adopted", async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: "Invalid adoption id" });
        }

        const adoption = await AdoptionListing.findById(id);
        if (!adoption) {
            return res.status(404).json({ success: false, message: "Adoption listing not found" });
        }

        if (adoption.status !== "approved") {
            return res.status(409).json({ success: false, message: "Only approved listings can be marked as adopted." });
        }

        const updatedAdoption = await AdoptionListing.findByIdAndUpdate(
            id,
            { $set: { status: "adopted" } },
            { new: true }
        );

        return res.status(200).json({
            success: true,
            adoption: updatedAdoption
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;
