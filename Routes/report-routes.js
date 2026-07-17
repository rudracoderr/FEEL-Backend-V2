const express = require("express");
const { rateLimit } = require("express-rate-limit");

const router = express.Router();

const Report = require("../Models/report-model");
const User = require("../Models/usermodel");
const AbuseReport = require("../Models/abuse-report-model");
const {
    notifyUsersWithinRadius,
    sendNotificationToToken,
    createNotification,
    checkNearbyPaidVolunteersExist,
    notifyNearbyPaidVolunteers,
    getPaidVolunteersInRange
} = require("../Services/notification-service");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");

// ---------------------------------------------------------------------------
// ROUTE-LEVEL RATE LIMITERS
// These are stricter than the global limiter and guard write-heavy endpoints.
// ---------------------------------------------------------------------------

// Report creation: 5 per hour per IP.
// This is a second line of defence alongside the per-user DB cooldown — it
// catches unauthenticated bursts before they ever hit the database.
const createReportLimiter = rateLimit({
    windowMs: 1000, // 1 hour
    max: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req, res) => {
        return res.status(429).json({
            success: false,
            message: "Too many reports submitted. Please try again in an hour."
        });
    }
});

// Abuse reporting: 10 per hour per IP.
// Prevents a single bad actor from flooding the moderation queue.
const abuseReportLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req, res) => {
        return res.status(429).json({
            success: false,
            message: "Too many abuse reports submitted. Please try again in an hour."
        });
    }
});

const ACCEPT_RADIUS_KM = 10;

const REPORT_LIST_PROJECTION = "title description severity status assignedVolunteer.uid assignedVolunteer.fullName acceptedAt resolvedAt volunteerProgress progressUpdatedAt location address landmark date reporterName reporterUid imageUrls assistance.status assistance.acceptedByName assistance.acceptedByPhone";

// Public detail projection — used by GET /:id.
// Excludes all PII that must not be visible to unauthenticated callers:
//   reporterContact, reporterDeviceToken, assignedVolunteer.phone, assignedVolunteer.email.
// reporterUid is retained because RescueDetailsModal uses it client-side to
// determine whether the viewer is the reporter (to gate the volunteer contact UI).
const REPORT_DETAIL_PROJECTION = "title description severity status " +
    "assignedVolunteer.uid assignedVolunteer.fullName " +
    "acceptedAt resolvedAt volunteerProgress progressUpdatedAt " +
    "location address landmark date reporterName reporterUid imageUrls " +
    "resolutionRemark resolutionDetails " +
    "assistance.status assistance.acceptedByName assistance.acceptedByPhone";

// NOTE: requireAuth is applied per-route below.
// GET /api/reports and GET /api/reports/:id are intentionally public
// so unauthenticated (guest) users can browse the rescue feed.
// All write and user-specific endpoints are individually protected.

function toRadians(value) {
    return (value * Math.PI) / 180;
}

function normalizeLocation(location) {
    const coordinates = location?.coordinates;

    if (!Array.isArray(coordinates) || coordinates.length < 2) {
        throw new Error("Report location coordinates are required.");
    }

    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);

    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        throw new Error("Report location coordinates must be valid numbers.");
    }

    return {
        type: "Point",
        coordinates: [longitude, latitude]
    };
}

function normalizeTextField(value) {
    return typeof value === "string" ? value.trim() : "";
}

function calculateDistanceKm(fromCoordinates, toCoordinates) {
    if (!Array.isArray(fromCoordinates) || !Array.isArray(toCoordinates)) {
        return null;
    }

    const [fromLongitude, fromLatitude] = fromCoordinates;
    const [toLongitude, toLatitude] = toCoordinates;

    if (
        typeof fromLongitude !== "number" ||
        typeof fromLatitude !== "number" ||
        typeof toLongitude !== "number" ||
        typeof toLatitude !== "number"
    ) {
        return null;
    }

    const earthRadiusKm = 6371;
    const deltaLatitude = toRadians(toLatitude - fromLatitude);
    const deltaLongitude = toRadians(toLongitude - fromLongitude);
    const latitude1 = toRadians(fromLatitude);
    const latitude2 = toRadians(toLatitude);

    const a =
        Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
        Math.sin(deltaLongitude / 2) * Math.sin(deltaLongitude / 2) *
        Math.cos(latitude1) * Math.cos(latitude2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadiusKm * c;
}

// CREATE REPORT — protected: requires authenticated user
// createReportLimiter runs first (network edge), then auth, then active-user check.
router.post("/", createReportLimiter, requireAuth, requireActiveUser, async (req, res) => {
    try {
        const {
            title,
            description,
            severity,
            reporterName,
            reporterContact: rawReporterContact,
            address,
            landmark,
            imageUrls,
            location,
        } = req.body;

        const payload = {
            title,
            description,
            severity,
            reporterName,
            reporterContact: rawReporterContact,
            address,
            landmark,
            imageUrls,
            location,
        };

        const reporterUid = req.authUid;
        payload.reporterUid = reporterUid;
        const reporterContact = typeof payload.reporterContact === "string" ? payload.reporterContact.trim() : "";
        const isEmailContact = reporterContact.includes("@");

        payload.location = normalizeLocation(payload.location);
        payload.address = normalizeTextField(payload.address);
        payload.landmark = normalizeTextField(payload.landmark);

        if ((!reporterContact || isEmailContact) && reporterUid) {
            const reporterUser = await User.findOne({ uid: reporterUid }).select("phone");
            if (reporterUser?.phone) {
                payload.reporterContact = reporterUser.phone;
            }
        }

        // Report creation cooldown: prevent the same reporter from creating reports too frequently.
        // Uses the reporter's uid and the `date` field on saved reports. Cooldown is 5 minutes.
        try {
            if (reporterUid) {
                const COOLDOWN_MS = 5;
                const lastReport = await Report.findOne({ reporterUid }).sort({ date: -1 }).select('date');

                if (lastReport && lastReport.date) {
                    const now = Date.now();
                    const lastTime = new Date(lastReport.date).getTime();
                    const elapsed = now - lastTime;

                    if (elapsed < COOLDOWN_MS) {
                        const remainingMs = COOLDOWN_MS - elapsed;
                        const remainingSeconds = Math.ceil(remainingMs / 1000);

                        return res.status(429).json({
                            message: "Please wait before creating another report.",
                            remainingSeconds
                        });
                    }
                }
            }
        } catch (cooldownError) {
            // Don't block report creation if cooldown check itself fails; log and continue.
            console.error('Cooldown check failed:', cooldownError);
        }

        const report = await Report.create(payload);

        // Fire-and-forget background notification dispatch
        notifyUsersWithinRadius(report).catch(err => {
            console.error("Background notification dispatch failed for report:", report._id, err);
        });

        return res.status(201).json({
            report,
            notification: { status: "queued_for_background_delivery" }
        });
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }
});

// GET ALL REPORTS (optionally filtered by radius)
// Query params: lat (number), lng (number), radius (km, number)
router.get("/", async (req, res) => {
    try {
        const { lat, lng, radius } = req.query;
        const parsedLat = parseFloat(lat);
        const parsedLng = parseFloat(lng);
        const parsedRadius = parseFloat(radius);

        let query = {};
        if (
            Number.isFinite(parsedLat) &&
            Number.isFinite(parsedLng) &&
            Number.isFinite(parsedRadius) &&
            parsedRadius > 0
        ) {
            query.location = {
                $nearSphere: {
                    $geometry: { type: "Point", coordinates: [parsedLng, parsedLat] },
                    $maxDistance: parsedRadius * 1000
                }
            };
        }

        if (req.query.assistancePending === 'true') {
            query["assistance.status"] = "pending";
        }

        const reports = await Report.find(query).select(REPORT_LIST_PROJECTION).lean();
        return res.status(200).json(reports);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }
});

// GET CLAIMED REPORTS FOR A VOLUNTEER — protected
router.get("/claimed/:uid", requireAuth, async (req, res) => {
    try {
        const { uid } = req.params;

        if (!uid) {
            return res.status(400).json({
                success: false,
                message: "uid is required"
            });
        }

        if (uid !== req.authUid) {
            return res.status(403).json({
                success: false,
                message: "Forbidden"
            });
        }

        let query = { "assignedVolunteer.uid": req.authUid };
        
        if (req.query.includeAssisting === 'true') {
            query = {
                $or: [
                    { "assignedVolunteer.uid": req.authUid },
                    { "assistance.acceptedByUid": req.authUid }
                ]
            };
        }

        const reports = await Report.find(query).sort({
            resolvedAt: -1,
            acceptedAt: -1,
            date: -1,
            _id: -1
        });

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

// GET REPORTS SUBMITTED BY A SPECIFIC USER (reporter) — protected
router.get("/by-reporter/:uid", requireAuth, async (req, res) => {
    try {
        const { uid } = req.params;

        if (!uid) {
            return res.status(400).json({
                success: false,
                message: "uid is required"
            });
        }

        if (uid !== req.authUid) {
            return res.status(403).json({
                success: false,
                message: "Forbidden"
            });
        }

        const reports = await Report.find({ reporterUid: req.authUid }).sort({
            date: -1,
            _id: -1
        });

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

// GET REPORT BY ID
router.get("/:id", async (req, res) => {
    try {
        const report = await Report.findById(req.params.id).select(REPORT_DETAIL_PROJECTION).lean();

        if (!report) {
            return res.status(404).json({
                error: "Report not found"
            });
        }

        return res.status(200).json(report);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }
});

// GET NEARBY PAID VOLUNTEERS FOR A SPECIFIC REPORT
router.get("/:id/nearby-paid-volunteers", async (req, res) => {
    try {
        const report = await Report.findById(req.params.id).lean();

        if (!report) {
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        const volunteers = await getPaidVolunteersInRange(report);

        // Calculate exact distance for display
        const [rLng, rLat] = report.location.coordinates;
        
        const mappedVolunteers = volunteers.map(v => {
            const [vLng, vLat] = v.location.coordinates;
            // Haversine distance in kilometers
            const distanceKmVal = calculateDistanceKm([rLng, rLat], [vLng, vLat]);
            
            return {
                uid: v.uid,
                fullName: v.fullName,
                phone: v.phone,
                distanceKm: distanceKmVal.toFixed(1)
            };
        });

        // Sort by closest first
        mappedVolunteers.sort((a, b) => parseFloat(a.distanceKm) - parseFloat(b.distanceKm));

        return res.status(200).json({
            success: true,
            volunteers: mappedVolunteers
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


// ACCEPT REPORT BY VOLUNTEER — protected
router.patch("/:id/accept", requireAuth, async (req, res) => {
    try {
        const uid = req.authUid;

        const report = await Report.findById(req.params.id);

        if (!report) {
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        if (report.status !== "pending") {
            return res.status(409).json({
                success: false,
                message: "This rescue has already been claimed."
            });
        }

        if (report.reporterUid === req.authUid) {
            return res.status(403).json({
                success: false,
                message: "You cannot accept your own rescue request."
            });
        }

        const user = await User.findOne({ uid });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        if (!user.isVolunteer) {
            return res.status(403).json({
                success: false,
                message: "Only volunteers can accept rescue reports."
            });
        }

        if (user.isSuspended || user.volunteerStatus === "suspended") {
            return res.status(403).json({
                success: false,
                message: "Your volunteer account has been suspended."
            });
        }

        const distanceKm = calculateDistanceKm(
            user.location?.coordinates,
            report.location?.coordinates
        );

        if (distanceKm === null) {
            return res.status(400).json({
                success: false,
                message: "Unable to verify distance for this rescue."
            });
        }

        if (distanceKm > ACCEPT_RADIUS_KM) {
            return res.status(403).json({
                success: false,
                message: "You are too far away to accept this rescue."
            });
        }

        const updatedReport = await Report.findByIdAndUpdate(
            req.params.id,
            {
                $set: {
                    status: "accepted",
                    assignedVolunteer: {
                        uid: user.uid,
                        fullName: user.fullName || "",
                        phone: user.phone || "",
                        email: user.email || ""
                    },
                    acceptedAt: new Date(),
                    volunteerProgress: "Assigned",
                    progressUpdatedAt: new Date()
                }
            },
            { new: true }
        );

        console.log("Report accepted - phone snapshot:", {
            reportId: updatedReport?._id || null,
            reporterUid: updatedReport?.reporterUid || null,
            reporterContact: updatedReport?.reporterContact || null,
            assignedVolunteerUid: updatedReport?.assignedVolunteer?.uid || null,
            assignedVolunteerPhone: updatedReport?.assignedVolunteer?.phone || null
        });

        let reporterDeviceToken = updatedReport?.reporterDeviceToken || null;

        if (!reporterDeviceToken && updatedReport?.reporterUid) {
            const reporterUser = await User.findOne({ uid: updatedReport.reporterUid }).select("deviceToken");
            reporterDeviceToken = reporterUser?.deviceToken || null;
        }

        let notification = null;

        if (updatedReport.reporterUid) {
            notification = await createNotification({
                recipientUid: updatedReport.reporterUid,
                type: "rescue_progress",
                title: "Volunteer accepted your rescue request",
                body: `Volunteer accepted your rescue request for "${updatedReport.title}"`,
                data: {
                    reportId: String(updatedReport._id),
                    reportTitle: updatedReport.title || "",
                    status: updatedReport.status || "accepted"
                },
                deviceToken: reporterDeviceToken,
                context: {
                    uid: updatedReport.reporterUid,
                    fullName: updatedReport.reporterName || ""
                }
            });
        }

        // Notify admins
        try {
            const admins = await User.find({ role: "admin" });
            for (const adminUser of admins) {
                await createNotification({
                    recipientUid: adminUser.uid,
                    type: "volunteer_accepted",
                    title: "Volunteer accepted rescue",
                    body: `Volunteer ${user.fullName || "Unknown"} accepted the rescue report: ${updatedReport.title}`,
                    data: {
                        reportId: String(updatedReport._id),
                        reportTitle: updatedReport.title || "",
                        status: updatedReport.status || "accepted"
                    },
                    deviceToken: adminUser.deviceToken || null,
                    context: {
                        uid: adminUser.uid,
                        fullName: adminUser.fullName || ""
                    }
                });
            }
        } catch (adminNotifyErr) {
            console.error("Failed to notify admins on accept:", adminNotifyErr);
        }

        // Send self-accept confirmation notification to the volunteer
        const locationSummary = [report.address, report.landmark].filter(Boolean).join(" \u2022 ");

        await createNotification({
            recipientUid: uid,
            type: "self_accepted",
            title: "You accepted a rescue",
            body: `${report.title} at ${locationSummary || report.address || "Unknown location"}`,
            data: {
                reportId: String(updatedReport._id),
                reportTitle: report.title || "",
                reportAddress: locationSummary || report.address || "",
                assignmentTimestamp: new Date().toISOString()
            },
            deviceToken: user.deviceToken || null,
            context: {
                uid: user.uid,
                fullName: user.fullName || ""
            }
        });

        return res.status(200).json({
            success: true,
            report: updatedReport,
            distanceKm,
            notification
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// MARK REPORT AS RESOLVED — protected
router.patch("/:id/resolve", requireAuth, async (req, res) => {
    try {
        const uid = req.authUid;

        const user = await User.findOne({ uid });
        if (!user || !user.isVolunteer) {
            return res.status(403).json({
                success: false,
                message: "Only volunteers can resolve rescues."
            });
        }
        if (user.isSuspended || user.volunteerStatus === "suspended") {
            return res.status(403).json({
                success: false,
                message: "Your volunteer account has been suspended."
            });
        }

        const report = await Report.findById(req.params.id);

        if (!report) {
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        if (report.assignedVolunteer?.uid !== uid) {
            return res.status(403).json({
                success: false,
                message: "Only the assigned volunteer can resolve this rescue."
            });
        }

        if (report.status !== "accepted") {
            return res.status(409).json({
                success: false,
                message: "Only accepted rescues can be resolved."
            });
        }

        // Require resolution details
        const resolutionDetails = req.body.resolutionDetails;
        const resolutionPhotoUrl = typeof resolutionDetails?.photoUrl === "string" ? resolutionDetails.photoUrl.trim() : "";
        const resolutionNote = typeof resolutionDetails?.note === "string" ? resolutionDetails.note.trim() : "";

        if (!resolutionPhotoUrl) {
            return res.status(400).json({
                success: false,
                message: "A resolution photo is required."
            });
        }

        if (!resolutionNote) {
            return res.status(400).json({
                success: false,
                message: "A resolution note is required."
            });
        }

        const updatedReport = await Report.findByIdAndUpdate(
            req.params.id,
            {
                $set: {
                    status: "resolved",
                    resolvedAt: new Date(),
                    volunteerProgress: "Resolved",
                    progressUpdatedAt: new Date(),
                    resolutionRemark: resolutionNote,
                    resolvedBy: uid,
                    resolutionDetails: {
                        photoUrl: resolutionPhotoUrl,
                        note: resolutionNote,
                        resolvedAt: new Date(),
                        resolvedByUid: uid
                    },
                    "assistance.status": "none",
                    "assistance.requestedByUid": null,
                    "assistance.requestedAt": null,
                    "assistance.acceptedByUid": null,
                    "assistance.acceptedAt": null,
                    "assistance.acceptedByName": "",
                    "assistance.acceptedByPhone": ""
                }
            },
            { new: true }
        );

        // Notify reporter and admins
        if (updatedReport.reporterUid) {
            try {
                const reporterUser = await User.findOne({ uid: updatedReport.reporterUid }).select("deviceToken");
                await createNotification({
                    recipientUid: updatedReport.reporterUid,
                    type: "rescue_progress",
                    title: "Rescue completed",
                    body: `Your rescue request "${updatedReport.title}" has been completed.`,
                    data: {
                        reportId: String(updatedReport._id),
                        reportTitle: updatedReport.title || "",
                        status: "resolved"
                    },
                    deviceToken: reporterUser?.deviceToken || null,
                    context: {
                        uid: updatedReport.reporterUid,
                        fullName: updatedReport.reporterName || ""
                    }
                });
            } catch (repNotifyErr) {
                console.error("Failed to notify reporter on resolve:", repNotifyErr);
            }
        }

        try {
            const admins = await User.find({ role: "admin" });
            for (const adminUser of admins) {
                await createNotification({
                    recipientUid: adminUser.uid,
                    type: "rescue_completed",
                    title: "Rescue completed",
                    body: `Rescue report "${updatedReport.title}" has been completed.`,
                    data: {
                        reportId: String(updatedReport._id),
                        reportTitle: updatedReport.title || "",
                        status: "resolved"
                    },
                    deviceToken: adminUser.deviceToken || null,
                    context: {
                        uid: adminUser.uid,
                        fullName: adminUser.fullName || ""
                    }
                });
            }
        } catch (adminNotifyErr) {
            console.error("Failed to notify admins on resolve:", adminNotifyErr);
        }

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

// CANCEL RESCUE BY VOLUNTEER (release back to pending) — protected
router.patch("/:id/cancel", requireAuth, async (req, res) => {
    try {
        const uid = req.authUid;

        const user = await User.findOne({ uid });
        if (!user || !user.isVolunteer) {
            return res.status(403).json({
                success: false,
                message: "Only volunteers can cancel rescues."
            });
        }
        if (user.isSuspended || user.volunteerStatus === "suspended") {
            return res.status(403).json({
                success: false,
                message: "Your volunteer account has been suspended."
            });
        }

        const report = await Report.findById(req.params.id);

        if (!report) {
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        if (report.assignedVolunteer?.uid !== uid) {
            return res.status(403).json({
                success: false,
                message: "Only the assigned volunteer can cancel this rescue."
            });
        }

        if (report.status !== "accepted") {
            return res.status(409).json({
                success: false,
                message: "Only active (accepted) rescues can be cancelled."
            });
        }

        const updatedReport = await Report.findByIdAndUpdate(
            req.params.id,
            {
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
                    volunteerProgress: "",
                    progressUpdatedAt: ""
                }
            },
            { new: true }
        );

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

// UPDATE RESCUE PROGRESS BY VOLUNTEER — protected
router.patch("/:id/progress", requireAuth, async (req, res) => {
    try {
        const uid = req.authUid;
        const { progress } = req.body;

        const validProgress = ["Assigned", "On The Way", "Reached Location", "Resolved"];
        if (!validProgress.includes(progress)) {
            return res.status(400).json({
                success: false,
                message: "Invalid progress state."
            });
        }

        const report = await Report.findById(req.params.id);

        if (!report) {
            return res.status(404).json({
                success: false,
                message: "Report not found"
            });
        }

        if (report.assignedVolunteer?.uid !== uid) {
            return res.status(403).json({
                success: false,
                message: "Only the assigned volunteer can update progress."
            });
        }

        if (report.status !== "accepted") {
            return res.status(409).json({
                success: false,
                message: "Progress can only be updated on accepted rescues."
            });
        }

        // Volunteers can only move forward through the workflow.
        const currentProgress = report.volunteerProgress || "Assigned";
        const currentIndex = validProgress.indexOf(currentProgress);
        const nextIndex = validProgress.indexOf(progress);

        if (nextIndex <= currentIndex) {
            return res.status(400).json({
                success: false,
                message: "Cannot move backward or repeat the same progress state."
            });
        }

        const updateFields = {
            volunteerProgress: progress,
            progressUpdatedAt: new Date()
        };

        if (progress === "Resolved") {
            // Require resolution details when marking as Resolved via progress
            const resolutionDetails = req.body.resolutionDetails;
            const resolutionPhotoUrl = typeof resolutionDetails?.photoUrl === "string" ? resolutionDetails.photoUrl.trim() : "";
            const resolutionNote = typeof resolutionDetails?.note === "string" ? resolutionDetails.note.trim() : "";

            if (!resolutionPhotoUrl) {
                return res.status(400).json({
                    success: false,
                    message: "A resolution photo is required."
                });
            }

            if (!resolutionNote) {
                return res.status(400).json({
                    success: false,
                    message: "A resolution note is required."
                });
            }

            updateFields.status = "resolved";
            updateFields.resolvedAt = new Date();
            updateFields.resolutionRemark = resolutionNote;
            updateFields.resolvedBy = uid;
            updateFields["resolutionDetails.photoUrl"] = resolutionPhotoUrl;
            updateFields["resolutionDetails.note"] = resolutionNote;
            updateFields["resolutionDetails.resolvedAt"] = new Date();
            updateFields["resolutionDetails.resolvedByUid"] = uid;
        }

        const updatedReport = await Report.findByIdAndUpdate(
            req.params.id,
            {
                $set: updateFields
            },
            { new: true }
        );

        // Notifications
        let title = "";
        let body = "";

        if (progress === "On The Way") {
            title = "Volunteer is on the way";
            body = `Volunteer is on the way for your rescue request "${updatedReport.title}"`;
        } else if (progress === "Reached Location") {
            title = "Volunteer reached the location";
            body = `Volunteer reached the location for your rescue request "${updatedReport.title}"`;
        } else if (progress === "Resolved") {
            title = "Rescue completed";
            body = `Your rescue request "${updatedReport.title}" has been completed.`;
        }

        if (title && updatedReport.reporterUid) {
            try {
                let reporterDeviceToken = updatedReport.reporterDeviceToken || null;
                if (!reporterDeviceToken) {
                    const reporterUser = await User.findOne({ uid: updatedReport.reporterUid }).select("deviceToken");
                    reporterDeviceToken = reporterUser?.deviceToken || null;
                }

                // Use a unique type per progress step so the deduplication check
                // in createNotification doesn't swallow subsequent notifications.
                let notifType = "rescue_progress";
                if (progress === "On The Way") notifType = "rescue_on_the_way";
                else if (progress === "Reached Location") notifType = "rescue_reached_location";
                else if (progress === "Resolved") notifType = "rescue_completed_reporter";

                await createNotification({
                    recipientUid: updatedReport.reporterUid,
                    type: notifType,
                    title,
                    body,
                    data: {
                        reportId: String(updatedReport._id),
                        reportTitle: updatedReport.title || "",
                        status: updatedReport.status || "accepted"
                    },
                    deviceToken: reporterDeviceToken,
                    context: {
                        uid: updatedReport.reporterUid,
                        fullName: updatedReport.reporterName || ""
                    }
                });
            } catch (repNotifyErr) {
                console.error("Failed to notify reporter on progress update:", repNotifyErr);
            }
        }

        if (progress === "Resolved") {
            try {
                const admins = await User.find({ role: "admin" });
                for (const adminUser of admins) {
                    await createNotification({
                        recipientUid: adminUser.uid,
                        type: "rescue_completed",
                        title: "Rescue completed",
                        body: `Rescue report "${updatedReport.title}" has been completed.`,
                        data: {
                            reportId: String(updatedReport._id),
                            reportTitle: updatedReport.title || "",
                            status: "resolved"
                        },
                        deviceToken: adminUser.deviceToken || null,
                        context: {
                            uid: adminUser.uid,
                            fullName: adminUser.fullName || ""
                        }
                    });
                }
            } catch (adminNotifyErr) {
                console.error("Failed to notify admins on progress update:", adminNotifyErr);
            }
        }

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

// UPDATE REPORT — protected
router.put("/:id", requireAuth, requireActiveUser, async (req, res) => {
    try {
        const existingReport = await Report.findById(req.params.id);

        if (!existingReport) {
            return res.status(404).json({
                error: "Report not found"
            });
        }

        if (existingReport.reporterUid !== req.authUid) {
            return res.status(403).json({
                error: "Forbidden"
            });
        }

        const { title, description, address, landmark, imageUrls } = req.body;
        const allowedUpdates = {};
        if (title !== undefined) allowedUpdates.title = typeof title === 'string' ? title.trim() : title;
        if (description !== undefined) allowedUpdates.description = typeof description === 'string' ? description.trim() : description;
        if (address !== undefined) allowedUpdates.address = typeof address === 'string' ? address.trim() : address;
        if (landmark !== undefined) allowedUpdates.landmark = typeof landmark === 'string' ? landmark.trim() : landmark;
        if (imageUrls !== undefined) allowedUpdates.imageUrls = imageUrls;

        const report = await Report.findByIdAndUpdate(
            req.params.id,
            { $set: allowedUpdates },
            { new: true, runValidators: true }
        );

        return res.status(200).json(report);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }
});

// DELETE REPORT — protected
router.delete("/:id", requireAuth, requireActiveUser, async (req, res) => {
    try {
        const existingReport = await Report.findById(req.params.id);

        if (!existingReport) {
            return res.status(404).json({
                error: "Report not found"
            });
        }

        if (existingReport.reporterUid !== req.authUid) {
            return res.status(403).json({
                error: "Forbidden"
            });
        }

        await Report.findByIdAndDelete(req.params.id);

        return res.status(200).json({
            message: "Report deleted"
        });
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }
});

// REPORT ABUSE / MODERATE REPORT — protected
router.post("/:id/abuse", abuseReportLimiter, requireAuth, requireActiveUser, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const reportedByUid = req.authUid;

        if (!id) {
            return res.status(400).json({
                success: false,
                message: "reportId is required."
            });
        }

        if (!reportedByUid) {
            return res.status(400).json({
                success: false,
                message: "reportedByUid is required."
            });
        }

        if (!reason) {
            return res.status(400).json({
                success: false,
                message: "reason is required."
            });
        }

        const validReasons = ["Fake Report", "Spam", "Wrong Location", "Duplicate Report", "Other"];
        if (!validReasons.includes(reason)) {
            return res.status(400).json({
                success: false,
                message: "Invalid reason provided."
            });
        }

        // Verify report exists
        const report = await Report.findById(id);
        if (!report) {
            return res.status(404).json({
                success: false,
                message: "Rescue report not found."
            });
        }

        // Check if user has already reported this rescue
        const existingReport = await AbuseReport.findOne({
            reportId: id,
            reportedByUid
        });

        if (existingReport) {
            return res.status(409).json({
                success: false,
                message: "You have already reported this rescue report."
            });
        }

        // Save abuse report
        const abuseReport = await AbuseReport.create({
            reportId: id,
            reportedByUid,
            reason
        });

        return res.status(201).json({
            success: true,
            message: "Thank you. This report has been flagged for review.",
            abuseReport
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// REQUEST ASSISTANCE — protected (assigned volunteer only)
router.patch("/:id/request-assistance", requireAuth, async (req, res) => {
    try {
        const uid = req.authUid;
        const report = await Report.findById(req.params.id);

        if (!report) {
            return res.status(404).json({ success: false, message: "Report not found" });
        }

        if (report.status !== "accepted") {
            return res.status(409).json({ success: false, message: "Report is not active." });
        }

        if (report.assignedVolunteer?.uid !== uid) {
            return res.status(403).json({ success: false, message: "Only the assigned volunteer can request assistance." });
        }

        if (report.assistance?.status === "pending" || report.assistance?.status === "accepted") {
            return res.status(409).json({ success: false, message: "Assistance is already requested or accepted." });
        }

        const volunteersExist = await checkNearbyPaidVolunteersExist(report);
        if (!volunteersExist) {
            return res.status(404).json({ success: false, message: "No approved paid volunteers are available nearby." });
        }

        const updatedReport = await Report.findByIdAndUpdate(
            req.params.id,
            {
                $set: {
                    "assistance.status": "pending",
                    "assistance.requestedByUid": uid,
                    "assistance.requestedAt": new Date()
                }
            },
            { new: true }
        );

        await notifyNearbyPaidVolunteers(updatedReport);

        return res.status(200).json({ success: true, report: updatedReport });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ACCEPT ASSISTANCE — protected (paid volunteer only)
router.patch("/:id/accept-assistance", requireAuth, async (req, res) => {
    try {
        const uid = req.authUid;
        const user = await User.findOne({ uid });

        if (!user || !user.isPaidVolunteer || user.paidVolunteerStatus !== "approved" || !user.isAvailable) {
            return res.status(403).json({ success: false, message: "Only available and approved paid volunteers can accept assistance." });
        }

        if (user.isSuspended || user.paidVolunteerStatus === "suspended") {
            return res.status(403).json({ success: false, message: "Your paid volunteer account is suspended." });
        }

        const report = await Report.findById(req.params.id);
        if (!report) {
            return res.status(404).json({ success: false, message: "Report not found" });
        }

        if (report.assistance?.requestedByUid === uid) {
            return res.status(403).json({ success: false, message: "You cannot accept your own assistance request." });
        }

        const distanceKm = calculateDistanceKm(
            user.location?.coordinates,
            report.location?.coordinates
        );

        if (distanceKm === null) {
            return res.status(400).json({ success: false, message: "Unable to verify distance." });
        }

        const rRadius = user.rescueRadius || 10;
        if (distanceKm > rRadius) {
            return res.status(403).json({ success: false, message: "You are outside your rescue radius for this report." });
        }

        const updatedReport = await Report.findOneAndUpdate(
            { _id: req.params.id, "assistance.status": "pending" },
            {
                $set: {
                    "assistance.status": "accepted",
                    "assistance.acceptedByUid": uid,
                    "assistance.acceptedAt": new Date(),
                    "assistance.acceptedByName": user.fullName,
                    "assistance.acceptedByPhone": user.phone
                }
            },
            { new: true }
        );

        if (!updatedReport) {
            return res.status(409).json({ success: false, message: "This assistance request has already been claimed or is no longer available." });
        }

        if (updatedReport.assistance?.requestedByUid) {
            const requesterUser = await User.findOne({ uid: updatedReport.assistance.requestedByUid }).select("deviceToken");
            
            await createNotification({
                recipientUid: updatedReport.assistance.requestedByUid,
                type: "assistance_accepted",
                title: "Assistance Accepted",
                body: `Paid volunteer ${user.fullName} is on their way to help you.`,
                data: {
                    reportId: String(updatedReport._id),
                    reportTitle: updatedReport.title || "",
                    status: updatedReport.status || "accepted"
                },
                deviceToken: requesterUser?.deviceToken || null,
                context: {
                    uid: updatedReport.assistance.requestedByUid,
                    fullName: ""
                }
            });
        }

        return res.status(200).json({ success: true, report: updatedReport });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;