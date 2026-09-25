const express = require("express");
const { rateLimit } = require("express-rate-limit");

const router = express.Router();
const validateMongoId = require("../middleware/validateObjectId");
router.param("id", validateMongoId("id"));

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

// Shared fields included in all report list responses.
const REPORT_LIST_PROJECTION = {
    title: 1, description: 1, severity: 1, status: 1,
    "assignedVolunteer.uid": 1, "assignedVolunteer.fullName": 1,
    acceptedAt: 1, resolvedAt: 1, volunteerProgress: 1, progressUpdatedAt: 1,
    location: 1, address: 1, landmark: 1, date: 1,
    reporterName: 1, reporterUid: 1, imageUrls: 1,
    "assistance.status": 1, "assistance.requestedAt": 1,
    "assistance.acceptedByUid": 1, "assistance.acceptedByName": 1, "assistance.acceptedByPhone": 1
};

// Public detail projection — used by GET /:id for unauthenticated callers.
// Strips all PII: reporterContact, reporterDeviceToken, assignedVolunteer.phone, assignedVolunteer.email.
// reporterUid is retained for client-side reporter/volunteer gate logic.
const REPORT_DETAIL_PROJECTION = {
    title: 1, description: 1, severity: 1, status: 1,
    "assignedVolunteer.uid": 1, "assignedVolunteer.fullName": 1,
    acceptedAt: 1, resolvedAt: 1, volunteerProgress: 1, progressUpdatedAt: 1,
    location: 1, address: 1, landmark: 1, date: 1,
    reporterName: 1, reporterUid: 1, imageUrls: 1,
    resolutionRemark: 1, resolutionDetails: 1,
    "assistance.status": 1, "assistance.requestedAt": 1,
    "assistance.acceptedByUid": 1, "assistance.acceptedByName": 1, "assistance.acceptedByPhone": 1
};

// Extended detail projection for approved paid volunteers.
// Adds assignedVolunteer.phone so they can call the responding volunteer.
// Phone is intentionally NOT in the public projection.
const REPORT_DETAIL_PROJECTION_PAID_VOLUNTEER = {
    ...REPORT_DETAIL_PROJECTION,
    "assignedVolunteer.phone": 1
};

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
                const COOLDOWN_MS = 5 * 60 * 1000;
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
// Query params:
//   page      (integer >= 1, default 1)
//   limit     (integer 1–50, default 20)
//   status    (string: pending | accepted | resolved | fake)
//   lat       (number) — required for geospatial filtering
//   lng       (number) — required for geospatial filtering
//   radius    (number, km) — required for geospatial filtering
//   assistancePending (boolean string "true")
//   assistanceAcceptedBy (uid string)
//
// NOTE: $nearSphere is incompatible with countDocuments().
// When a geospatial filter is active, total/totalPages are omitted and
// hasMore is determined conservatively: reports.length === limit.
router.get("/", async (req, res) => {
    try {
        // ── Pagination params ────────────────────────────────────────────────
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const skip  = (page - 1) * limit;

        // ── Build filter query ───────────────────────────────────────────────
        let query = {};

        // Geospatial — $nearSphere requires a 2dsphere index on `location`.
        const parsedLat    = parseFloat(req.query.lat);
        const parsedLng    = parseFloat(req.query.lng);
        const parsedRadius = parseFloat(req.query.radius);
        const isGeospatial = (
            Number.isFinite(parsedLat) &&
            Number.isFinite(parsedLng) &&
            Number.isFinite(parsedRadius) &&
            parsedRadius > 0
        );
        if (isGeospatial) {
            query.location = {
                $nearSphere: {
                    $geometry: { type: "Point", coordinates: [parsedLng, parsedLat] },
                    $maxDistance: parsedRadius * 1000
                }
            };
        }

        // Status filter — validated against allowlist to prevent injection.
        const ALLOWED_STATUSES = ["pending", "accepted", "resolved", "fake"];
        if (req.query.status && ALLOWED_STATUSES.includes(req.query.status)) {
            query.status = req.query.status;
        }

        // Assistance filters (existing behaviour, preserved as-is).
        if (req.query.assistancePending === "true") {
            query["assistance.status"] = "pending";
        }
        if (req.query.assistanceAcceptedBy) {
            query["assistance.status"]      = "accepted";
            query["assistance.acceptedByUid"] = req.query.assistanceAcceptedBy;
        }

        // ── Execute paginated query ──────────────────────────────────────────
        // Sort deterministically: newest first, with _id as tiebreaker so that
        // concurrent inserts between pages never cause a document to appear twice.
        const reports = await Report.find(query)
            .select(REPORT_LIST_PROJECTION)
            .sort({ date: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        // ── Pagination metadata ──────────────────────────────────────────────
        // $nearSphere is NOT compatible with countDocuments(); skip it for geo
        // requests and fall back to the conservative hasMore heuristic instead.
        let total      = null;
        let totalPages = null;
        let hasMore;

        if (isGeospatial) {
            // Conservative: if we got a full page, assume there might be more.
            hasMore = reports.length === limit;
        } else {
            // Optimization: countDocuments({}) is O(N). For empty filters (global feed),
            // use estimatedDocumentCount() which is O(1) using collection metadata.
            if (Object.keys(query).length === 0) {
                total = await Report.estimatedDocumentCount();
            } else {
                total = await Report.countDocuments(query);
            }
            totalPages = Math.ceil(total / limit);
            hasMore    = page < totalPages;
        }

        return res.status(200).json({
            reports,
            pagination: {
                page,
                limit,
                total,       // null for geospatial requests
                totalPages,  // null for geospatial requests
                hasMore,
            },
        });
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

// GET NGO LIST — authenticated, paid-volunteer accessible.
// Returns minimal { _id, name } so the transfer picker can render options.
// ponytail: one read-only route, no new model/middleware.
// MUST be defined before /:id so router.param validateMongoId does not intercept "ngos".
router.get("/ngos", requireAuth, async (req, res) => {
    try {
        const Ngo = require("../Models/ngo-model");
        const ngos = await Ngo.find({}).select("_id name").sort({ name: 1 }).lean();
        return res.status(200).json({ success: true, ngos });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// GET REPORT BY ID
// Public route — but optionally reads the Bearer token to decide projection.
// Approved paid volunteers receive assignedVolunteer.phone; all other callers do not.
router.get("/:id", async (req, res) => {
    try {
        let isPaidVolunteer = false;
        const authHeader = req.headers.authorization || "";

        // ── DIAGNOSTIC LOG 1: raw Authorization header ─────────────────────
        console.log("[GET /:id] Authorization header:", authHeader ? authHeader.substring(0, 30) + "…" : "(none)");

        const tokenMatch = /^Bearer\s+(.+)$/i.exec(authHeader);

        if (tokenMatch) {
            try {
                const admin = require("../firebase-admin");
                if (admin.isFirebaseAdminInitialized()) {
                    const decoded = await admin.auth().verifyIdToken(tokenMatch[1]);
                    if (decoded?.uid) {
                        const caller = await User.findOne({ uid: decoded.uid })
                            .select({ isPaidVolunteer: 1, paidVolunteerStatus: 1 })
                            .lean();

                        // ── DIAGNOSTIC LOG 2: user lookup result ───────────────────────
                        console.log("[GET /:id] User lookup result:", {
                            uid: decoded.uid,
                            isPaidVolunteer: caller?.isPaidVolunteer,
                            status: caller?.paidVolunteerStatus
                        });

                        if (caller?.isPaidVolunteer === true && caller?.paidVolunteerStatus === "approved") {
                            isPaidVolunteer = true;
                        }
                    }
                }
            } catch (authErr) {
                // Missing/expired token — treat as unauthenticated
                console.log(`[GET /:id] optional auth skipped: ${authErr.message}`);
            }
        }

        const projection = isPaidVolunteer
            ? REPORT_DETAIL_PROJECTION_PAID_VOLUNTEER
            : REPORT_DETAIL_PROJECTION;

        // ── DIAGNOSTIC LOG 3: projection chosen ────────────────────────────
        console.log("[GET /:id] Projection chosen:", { isPaidVolunteer, projection });

        const report = await Report.findById(req.params.id).select(projection).lean();

        if (!report) {
            return res.status(404).json({ error: "Report not found" });
        }

        // ── DIAGNOSTIC LOG 4: raw Mongo document assignedVolunteer ─────────
        console.log("[GET /:id] Mongo report.assignedVolunteer:", JSON.stringify(report.assignedVolunteer));

        // ── DIAGNOSTIC LOG 5: full response payload ─────────────────────────
        console.log("[GET /:id] Final response assignedVolunteer keys:", Object.keys(report.assignedVolunteer || {}));

        return res.status(200).json(report);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

// GET NEARBY PAID VOLUNTEERS FOR A SPECIFIC REPORT
router.get("/:id/nearby-paid-volunteers",
    requireAuth,
    requireActiveUser, async (req, res) => {
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

        const isApprovedPaidVolunteer = user.isPaidVolunteer === true && user.paidVolunteerStatus === "approved";
        if (!user.isVolunteer && !isApprovedPaidVolunteer) {
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

        // Atomic update: the status:'pending' filter means only one volunteer can ever
        // win this race. If the report was already accepted by a concurrent request,
        // findOneAndUpdate returns null and we return 409 instead of overwriting.
        const updatedReport = await Report.findOneAndUpdate(
            { _id: req.params.id, status: "pending" },
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

        if (!updatedReport) {
            return res.status(409).json({
                success: false,
                message: "This rescue has already been claimed by another volunteer."
            });
        }

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
        const updateFields = {
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
            }
        };

        if (report.assistance?.status === "accepted") {
            updateFields["assistance.status"] = "completed";
            updateFields["assistance.completedAt"] = new Date();
        } else if (report.assistance?.status === "pending") {
            updateFields["assistance.status"] = "none";
            updateFields["assistance.requestedByUid"] = null;
            updateFields["assistance.requestedAt"] = null;
        }

        const updatedReport = await Report.findByIdAndUpdate(
            req.params.id,
            { $set: updateFields },
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

        if (report.assistance?.status === "accepted" && report.assistance?.acceptedByUid) {
            try {
                const paidVolunteer = await User.findOne({ uid: report.assistance.acceptedByUid }).select("deviceToken");
                await createNotification({
                    recipientUid: report.assistance.acceptedByUid,
                    type: "rescue_completed",
                    title: "🎉 Rescue Resolved",
                    body: `The volunteer has successfully resolved the rescue you were assisting with.`,
                    data: {
                        reportId: String(updatedReport._id),
                        reportTitle: updatedReport.title || "",
                        status: "resolved"
                    },
                    deviceToken: paidVolunteer?.deviceToken || null,
                    context: {
                        uid: report.assistance.acceptedByUid,
                        fullName: report.assistance.acceptedByName || ""
                    }
                });
            } catch (err) {
                console.error("Failed to notify paid volunteer on resolve:", err);
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

            // Reset transferStatus so the report is no longer flagged as pending
            // a transfer. The NGO transfer document itself is cancelled below.
            updateFields.transferStatus = "none";

            // Auto-cancel any pending NGO transfer for this report.
            // A volunteer resolving in the field preempts a pending NGO handoff.
            // Without this, the transfer stays "pending" indefinitely and the
            // NGO accept route returns a permanent 409 when they try to action it.
            const NgoTransferModel = require("../Models/ngo-transfer-model");
            await NgoTransferModel.updateMany(
                { reportId: req.params.id, status: "pending" },
                {
                    $set: {
                        status: "cancelled",
                        cancelledAt: new Date(),
                        closureRemarks: "Auto-cancelled: rescue resolved by volunteer before NGO acceptance."
                    }
                }
            );
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

        const volunteers = await getPaidVolunteersInRange(report);
        if (!volunteers || volunteers.length === 0) {
            return res.status(404).json({ success: false, message: "No approved paid volunteers are available nearby." });
        }

        const notifiedUids = volunteers.map(v => v.uid);

        const updatedReport = await Report.findByIdAndUpdate(
            req.params.id,
            {
                $set: {
                    "assistance.status": "pending",
                    "assistance.requestedByUid": uid,
                    "assistance.requestedAt": new Date(),
                    "assistance.notifiedVolunteerCount": notifiedUids.length,
                    "assistance.notifiedVolunteerUids": notifiedUids
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

const NgoTransfer = require("../Models/ngo-transfer-model");

// ============================================================================
// NGO TRANSFER ROUTES (Volunteer Facing)
// ============================================================================

// POST /api/reports/:id/transfers
// Create an NGO transfer request — Paid Volunteer only.
//
// Design decisions:
//   • requireActiveUser already resolved req.activeUser so we avoid a second
//     User.findOne() for the volunteer's own data.
//   • All snapshot data is captured at request-time so the historical record
//     is immutable even if Report/User/Ngo documents change later.
//   • transferStatus on the Report is set to "pending" here; ownership fields
//     (currentHandlerType, currentNgoId) are NOT touched until NGO acceptance.
//   • No transactions — the project uses no transactions anywhere. The partial
//     unique index on { reportId, status ∈ [pending, accepted] } is the
//     atomicity guard. A duplicate key (11000) is handled gracefully.
//   • Notifications are fire-and-forget for NGO users only (reporter/volunteer
//     notifications are a later phase).
router.post("/:id/transfers", requireAuth, requireActiveUser, async (req, res) => {
    try {
        const reportId = req.params.id;
        const uid = req.authUid;
        const caller = req.activeUser; // resolved by requireActiveUser

        // ── 1. Validate caller is an approved paid volunteer ─────────────────
        if (!caller || !caller.isPaidVolunteer || caller.paidVolunteerStatus !== "approved") {
            return res.status(403).json({
                success: false,
                message: "Only approved paid volunteers can create transfer requests."
            });
        }

        // ── 2. Parse & validate body ─────────────────────────────────────────
        const { ngoId, remarks, condition } = req.body;

        if (!ngoId) {
            return res.status(400).json({ success: false, message: "ngoId is required." });
        }

        // ── 3. Load the report ───────────────────────────────────────────────
        const report = await Report.findById(reportId).lean();
        if (!report) {
            return res.status(404).json({ success: false, message: "Report not found." });
        }

        // Report must be actively accepted (not pending/resolved/fake)
        if (report.status !== "accepted") {
            return res.status(409).json({
                success: false,
                message: "Transfer requests can only be made for active (accepted) rescues."
            });
        }

        // Caller must be the paid volunteer currently handling this report.
        // Two valid paths:
        //   1. They directly accepted the rescue → report.assignedVolunteer.uid
        //   2. They accepted an assistance request → report.assistance.acceptedByUid
        const isDirectlyAssigned = report.assignedVolunteer?.uid === uid;
        const isAssisting = report.assistance?.acceptedByUid === uid;

        if (!isDirectlyAssigned && !isAssisting) {
            return res.status(403).json({
                success: false,
                message: "Forbidden: You are not the paid volunteer currently handling this rescue."
            });
        }

        // Block if a transfer is already in a terminal-complete state
        if (report.transferStatus === "completed") {
            return res.status(409).json({
                success: false,
                message: "This rescue has already been transferred to an NGO."
            });
        }

        // ── 4. Load the NGO ──────────────────────────────────────────────────
        const Ngo = require("../Models/ngo-model");
        const ngo = await Ngo.findById(ngoId).lean();
        if (!ngo) {
            return res.status(404).json({ success: false, message: "NGO not found." });
        }

        // ── 5. Load reporter user (for phone snapshot) ───────────────────────
        // reporterUid may be null for guest reports — handle gracefully.
        let reporterUser = null;
        if (report.reporterUid) {
            reporterUser = await User.findOne({ uid: report.reporterUid })
                .select("uid fullName phone")
                .lean();
        }

        // ── 6. Build immutable snapshots ─────────────────────────────────────
        const reporterSnapshot = {
            uid: report.reporterUid || null,
            name: report.reporterName || "",
            phone: reporterUser?.phone || report.reporterContact || ""
        };

        const transferredBy = {
            uid: caller.uid || null,
            name: caller.fullName || "",
            phone: caller.phone || ""
        };

        const ngoSnapshot = {
            id: ngo._id,
            name: ngo.name || "",
            phone: ngo.phone || ""
        };

        const animalSnapshot = {
            imageUrls: report.imageUrls || [],
            animalType: report.title || "",   // title is closest proxy for animal type
            description: report.description || "",
            address: report.address || "",
            location: report.location || { type: "Point", coordinates: [] }
        };

        // condition is optional — caller supplies it to give NGO context
        const conditionPayload = {
            severity: condition?.severity || null,
            summary: condition?.summary || "",
            needsShelter: Boolean(condition?.needsShelter),
            needsTransport: Boolean(condition?.needsTransport),
            needsSurgery: Boolean(condition?.needsSurgery)
        };

        // ── 7. Create NgoTransfer document ───────────────────────────────────
        // The partial unique index throws code 11000 if a pending/accepted
        // transfer already exists for this reportId — caught below.
        const transfer = await NgoTransfer.create({
            reportId: report._id,
            ngoId: ngo._id,
            requestedByUid: uid,
            remarks: typeof remarks === "string" ? remarks.trim() : "",
            status: "pending",

            // snapshots
            reporterSnapshot,
            transferredBy,
            ngoSnapshot,
            animalSnapshot,
            condition: conditionPayload
        });

        // ── 8. Mark report transferStatus = "pending" ────────────────────────
        // Do NOT touch currentHandlerType or currentNgoId — those update on NGO acceptance.
        await Report.findByIdAndUpdate(
            report._id,
            { $set: { transferStatus: "pending" } }
        );

        // ── 9. Notify NGO users (fire-and-forget) ────────────────────────────
        // Notify reporter and volunteer in later phases per the spec.
        User.find({
            ngoId: ngo._id,
            isSuspended: { $ne: true }
        })
            .select("uid deviceToken")
            .lean()
            .then(async (ngoUsers) => {
                for (const ngoUser of ngoUsers) {
                    try {
                        await createNotification({
                            recipientUid: ngoUser.uid,
                            title: "New Transfer Request",
                            body: `A paid volunteer has requested a case transfer: "${report.title || "Unknown rescue"}".`,
                            type: "TRANSFER_REQUESTED",
                            data: {
                                transferId: String(transfer._id),
                                reportId: String(report._id)
                            },
                            deviceToken: ngoUser.deviceToken || null,
                            context: { uid: ngoUser.uid, fullName: "" }
                        });
                    } catch (notifErr) {
                        console.error("[transfers] Failed to notify NGO user:", ngoUser.uid, notifErr.message);
                    }
                }
            })
            .catch(err => console.error("[transfers] NGO user lookup failed:", err.message));

        return res.status(201).json({ success: true, transfer });

    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({
                success: false,
                message: "An active transfer request already exists for this rescue."
            });
        }
        return res.status(500).json({ success: false, message: error.message });
    }
});


// DELETE /api/reports/:id/transfers/:transferId
// Cancel a pending transfer
router.delete("/:id/transfers/:transferId", requireAuth, requireActiveUser, async (req, res) => {
    try {
        const { id, transferId } = req.params;
        const uid = req.authUid;

        // Use findOneAndUpdate to ensure atomic transition only if it's pending
        const transfer = await NgoTransfer.findOneAndUpdate(
            { _id: transferId, reportId: id, requestedByUid: uid, status: 'pending' },
            { $set: { status: 'cancelled', cancelledAt: new Date() } },
            { new: true }
        );

        if (!transfer) {
            return res.status(400).json({ success: false, message: "Transfer request is no longer pending or does not exist, or you lack permission." });
        }

        // Fix #3: Reset Report.transferStatus so the rescue is no longer stuck in
        // 'pending' state after the volunteer cancels. Without this, the Report
        // document would never return to 'none', breaking the UI workflow.
        await Report.findByIdAndUpdate(transfer.reportId, {
            $set: { transferStatus: "none" }
        });

        // Notify NGO users
        const ngoUsers = await User.find({ ngoId: transfer.ngoId });
        for (const ngoUser of ngoUsers) {
            await createNotification({
                recipientUid: ngoUser.uid,
                title: "Transfer Cancelled",
                body: `A paid volunteer cancelled their transfer request.`,
                type: "TRANSFER_CANCELLED",
                data: { reportId: String(transfer.reportId) }
            });
        }

        return res.status(200).json({ success: true, transfer });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
