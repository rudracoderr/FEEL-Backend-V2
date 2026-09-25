const express = require("express");
const router = express.Router();
const Ngo = require("../Models/ngo-model");
const requireAuth = require("../middleware/requireAuth");
const requireNgo = require("../middleware/requireNgo");

router.use(requireAuth);
router.use(requireNgo); // Protects all routes to NGO roles only

// GET /api/ngo/me
router.get("/me", async (req, res) => {
    try {
        const ngoId = req.ngoUser.ngoId;
        if (!ngoId) {
            return res.status(404).json({
                success: false,
                message: "NGO profile not linked"
            });
        }

        const ngo = await Ngo.findById(ngoId).lean();

        if (!ngo) {
            return res.status(404).json({
                success: false,
                message: "NGO not found"
            });
        }

        res.set({
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
        });

        return res.status(200).json({
            success: true,
            ngo,
            user: {
                uid: req.ngoUser.uid,
                email: req.ngoUser.email,
                role: req.ngoUser.role
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

const NgoTransfer = require("../Models/ngo-transfer-model");
const { createNotification } = require("../Services/notification-service");
const Report = require("../Models/report-model");
const User   = require("../Models/usermodel");

// GET /api/ngo/transfers
router.get("/transfers", async (req, res) => {
    try {
        const { status } = req.query;
        const query = { ngoId: req.ngoUser.ngoId };

        if (status) {
            query.status = status;
        }

        const transfers = await NgoTransfer.find(query)
            .sort({ requestedAt: -1 })
            .populate('reportId', 'title description severity location imageUrls date');

        return res.status(200).json({
            success: true,
            transfers
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// PATCH /api/ngo/transfers/:id/accept
// Phase 3 — NGO accepts a pending transfer.
//
// Design decisions:
//   • requireNgo resolves req.ngoUser but only selects (uid, role, email, ngoId).
//     We need fullName + phone for the acceptedBy snapshot so we do one extra
//     User.findOne here — kept lean + projected to the minimum.
//   • NgoTransfer is updated first (atomic findOneAndUpdate) so any concurrent
//     accept call loses the race and hits the null-check guard.
//   • If the Report update subsequently fails we roll NgoTransfer back to
//     'pending' before returning 500 — manual rollback pattern (no transactions).
//   • transferStatus enum on Report is ['none','pending','completed'].
//     'completed' is the correct terminal state after NGO acceptance.
//   • assistance.status is only touched when it equals 'accepted' — otherwise
//     left untouched to avoid disturbing unrelated lifecycle states.
//   • NGO stats increment is fire-and-forget to avoid blocking the response.
router.patch("/transfers/:id/accept", async (req, res) => {
    const now = new Date();

    try {
        // ── 1. Resolve the NGO actor's full profile for snapshot ─────────────
        const actorUser = await User.findOne({ uid: req.ngoUser.uid })
            .select("uid fullName phone")
            .lean();

        const acceptedBy = {
            uid:   req.ngoUser.uid,
            name:  actorUser?.fullName || "",
            phone: actorUser?.phone    || ""
        };

        // ── 2. Atomically transition transfer: pending → accepted ────────────
        // The filter enforces:
        //   • correct transfer document (_id)
        //   • belongs to this NGO (prevents cross-NGO tampering)
        //   • currently pending (prevents double-acceptance)
        const transfer = await NgoTransfer.findOneAndUpdate(
            {
                _id:    req.params.id,
                status: "pending",
                ngoId:  req.ngoUser.ngoId
            },
            {
                $set: {
                    status:     "accepted",
                    acceptedAt: now,
                    acceptedBy
                }
            },
            { new: true }
        );

        if (!transfer) {
            return res.status(404).json({
                success: false,
                message: "Transfer not found, already processed, or does not belong to your NGO."
            });
        }

        // ── 3. Load and validate the Report ─────────────────────────────────
        const report = await Report.findById(transfer.reportId).lean();

        if (!report) {
            // Orphaned transfer — the report was deleted. Cancel the transfer
            // so it is removed from the NGO's pending queue.
            await NgoTransfer.findByIdAndUpdate(transfer._id, {
                $set: {
                    status: "cancelled",
                    cancelledAt: new Date(),
                    closureRemarks: "Auto-cancelled: associated rescue report no longer exists."
                }
            });
            return res.status(409).json({
                success: false,
                message: "Associated report no longer exists. Transfer has been cancelled."
            });
        }

        if (report.status !== "accepted") {
            // Rescue is no longer active (resolved or cancelled by volunteer).
            // Cancel the transfer so it clears out of the NGO's pending queue.
            await NgoTransfer.findByIdAndUpdate(transfer._id, {
                $set: {
                    status: "cancelled",
                    cancelledAt: new Date(),
                    closureRemarks: "Auto-cancelled: rescue is no longer active (resolved or cancelled)."
                }
            });
            return res.status(409).json({
                success: false,
                message: "Rescue is no longer active. Transfer has been cancelled."
            });
        }

        if (report.transferStatus !== "pending") {
            // Report's transferStatus no longer matches — stale transfer state.
            // Cancel so it does not persist in the NGO's pending queue.
            await NgoTransfer.findByIdAndUpdate(transfer._id, {
                $set: {
                    status: "cancelled",
                    cancelledAt: new Date(),
                    closureRemarks: "Auto-cancelled: report transfer status no longer pending."
                }
            });
            return res.status(409).json({
                success: false,
                message: "Report transfer is not in pending state. Transfer has been cancelled."
            });
        }

        // ── 4. Build Report update — ownership transfer ──────────────────────
        const reportUpdate = {
            currentHandlerType: "ngo",
            currentNgoId:       transfer.ngoId,
            transferStatus:     "completed"
        };

        // Complete the assistance lifecycle only when it was actively accepted
        if (report.assistance?.status === "accepted") {
            reportUpdate["assistance.status"]      = "completed";
            reportUpdate["assistance.completedAt"] = now;
        }

        // ── 5. Update Report (with manual rollback on failure) ───────────────
        try {
            await Report.findByIdAndUpdate(
                report._id,
                { $set: reportUpdate }
            );
        } catch (reportErr) {
            // Report update failed — roll NgoTransfer back so the volunteer
            // can retry rather than leaving the system in a split-brain state.
            await NgoTransfer.findByIdAndUpdate(transfer._id, {
                $set: { status: "pending", acceptedAt: null, acceptedBy: { uid: null, name: "", phone: "" } }
            });
            console.error("[accept] Report update failed, transfer rolled back:", reportErr.message);
            return res.status(500).json({
                success: false,
                message: "Failed to update report ownership. Transfer has been rolled back."
            });
        }

        // ── 6. NGO stats (fire-and-forget) ───────────────────────────────────
        Ngo.findByIdAndUpdate(req.ngoUser.ngoId, { $inc: { "stats.activeCases": 1, "stats.totalCases": 1 } })
            .catch(err => console.error("[accept] NGO stats update failed:", err.message));

        // ── 7. Notify Paid Volunteer (fire-and-forget) ───────────────────────
        User.findOne({ uid: transfer.requestedByUid })
            .select("uid deviceToken fullName")
            .lean()
            .then(volunteer => {
                if (!volunteer) return;
                return createNotification({
                    recipientUid: volunteer.uid,
                    type:         "TRANSFER_ACCEPTED",
                    title:        "Transfer Accepted",
                    body:         `An NGO has accepted your transfer request for "${report.title || "a rescue"}".`,
                    data:         { reportId: String(report._id) },
                    deviceToken:  volunteer.deviceToken || null,
                    context:      { uid: volunteer.uid, fullName: volunteer.fullName || "" }
                });
            })
            .catch(err => console.error("[accept] Volunteer notification failed:", err.message));

        // ── 8. Notify Reporter (fire-and-forget) ─────────────────────────────
        // Uses reporterDeviceToken stored directly on the Report at submission
        // time — no extra DB lookup required.
        if (report.reporterUid) {
            createNotification({
                recipientUid: report.reporterUid,
                type:         "RESCUE_TRANSFERRED_TO_NGO",
                title:        "Rescue Taken Over by NGO",
                body:         `Your rescue report has been officially taken over by ${transfer.ngoSnapshot?.name || "an NGO"}.`,
                data:         { reportId: String(report._id) },
                deviceToken:  report.reporterDeviceToken || null,
                context:      { uid: report.reporterUid, fullName: report.reporterName || "" }
            }).catch(err => console.error("[accept] Reporter notification failed:", err.message));
        }

        return res.status(200).json({ success: true, transfer });

    } catch (error) {
        console.error("[accept] Unexpected error:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// PATCH /api/ngo/transfers/:id/reject
// Phase 3 — NGO rejects a pending transfer.
//
// Design decisions:
//   • remarks is REQUIRED on rejection so volunteers always know why.
//   • Report.transferStatus is reset to 'none' so the volunteer can
//     request a new transfer to a different NGO.
//   • currentHandlerType and currentNgoId are NOT touched — ownership
//     has not changed.
//   • No rollback needed: the Report update is a soft reset ('none') with
//     no ownership implications, so a partial failure is self-correcting
//     (the volunteer will notice their transfer shows rejected and can retry).
router.patch("/transfers/:id/reject", async (req, res) => {
    const now = new Date();

    try {
        // ── 1. Validate required remarks ─────────────────────────────────────
        const { remarks } = req.body;
        if (!remarks || typeof remarks !== "string" || remarks.trim() === "") {
            return res.status(400).json({
                success: false,
                message: "remarks is required when rejecting a transfer."
            });
        }

        // ── 2. Resolve the NGO actor's full profile for snapshot ─────────────
        const actorUser = await User.findOne({ uid: req.ngoUser.uid })
            .select("uid fullName phone")
            .lean();

        const rejectedBy = {
            uid:   req.ngoUser.uid,
            name:  actorUser?.fullName || "",
            phone: actorUser?.phone    || ""
        };

        // ── 3. Atomically transition transfer: pending → rejected ────────────
        const transfer = await NgoTransfer.findOneAndUpdate(
            {
                _id:    req.params.id,
                status: "pending",
                ngoId:  req.ngoUser.ngoId
            },
            {
                $set: {
                    status:     "rejected",
                    rejectedAt: now,
                    rejectedBy,
                    closureRemarks: remarks.trim()
                }
            },
            { new: true }
        );

        if (!transfer) {
            return res.status(404).json({
                success: false,
                message: "Transfer not found, already processed, or does not belong to your NGO."
            });
        }

        // ── 4. Reset Report.transferStatus → 'none' ──────────────────────────
        // Allows the volunteer to submit a new transfer to a different NGO.
        // Ownership fields (currentHandlerType, currentNgoId) are untouched.
        await Report.findByIdAndUpdate(
            transfer.reportId,
            { $set: { transferStatus: "none" } }
        );

        // ── 5. Notify Paid Volunteer (fire-and-forget) ───────────────────────
        User.findOne({ uid: transfer.requestedByUid })
            .select("uid deviceToken fullName")
            .lean()
            .then(volunteer => {
                if (!volunteer) return;
                return createNotification({
                    recipientUid: volunteer.uid,
                    type:         "TRANSFER_REJECTED",
                    title:        "Transfer Rejected",
                    body:         `Your transfer request was rejected. Reason: ${remarks.trim()}`,
                    data:         { reportId: String(transfer.reportId) },
                    deviceToken:  volunteer.deviceToken || null,
                    context:      { uid: volunteer.uid, fullName: volunteer.fullName || "" }
                });
            })
            .catch(err => console.error("[reject] Volunteer notification failed:", err.message));

        return res.status(200).json({ success: true, transfer });

    } catch (error) {
        console.error("[reject] Unexpected error:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// PATCH /api/ngo/transfers/:id/close
// Phase 4 — NGO marks an accepted (active) transfer as closed.
//
// Design decisions:
//   • closureRemarks is REQUIRED — mirrors the pattern of remarks on rejection
//     so there is always a human-readable record of what happened to the animal.
//   • NgoTransfer is updated first (atomic findOneAndUpdate on status:'accepted')
//     so any concurrent close call loses the race and hits the null-check guard.
//   • If the Report update subsequently fails we roll NgoTransfer back to
//     'accepted' before returning 500 — same manual rollback pattern as accept.
//   • Report is moved to status:'resolved', resolvedAt is stamped, and
//     ownership fields (currentHandlerType, currentNgoId) are cleared back to
//     their "no handler" defaults.  This mirrors what the admin resolve route
//     does so every consumer (mobile, portal, admin) sees a consistent terminal
//     state.
//   • NGO stats decrement activeCases and increment closedCases/recoveredAnimals
//     as fire-and-forget — same pattern as the accept route's stats increment.
//   • There is no closedBy snapshot field on NgoTransfer (the schema has
//     acceptedBy/rejectedBy but not closedBy).  The actor's identity is already
//     captured in closureRemarks and is available via req.ngoUser.uid on the
//     document.  No new schema fields are added per the implementation spec.
router.patch("/transfers/:id/close", async (req, res) => {
    const now = new Date();

    try {
        // ── 1. Validate required closureRemarks ──────────────────────────────
        const { closureRemarks } = req.body;
        if (!closureRemarks || typeof closureRemarks !== "string" || closureRemarks.trim() === "") {
            return res.status(400).json({
                success: false,
                message: "closureRemarks is required when closing a transfer."
            });
        }

        // ── 2. Atomically transition transfer: accepted → closed ─────────────
        // The filter enforces:
        //   • correct transfer document (_id)
        //   • belongs to this NGO (prevents cross-NGO tampering)
        //   • currently accepted (prevents closing already-closed / rejected /
        //     cancelled / pending transfers)
        const transfer = await NgoTransfer.findOneAndUpdate(
            {
                _id:    req.params.id,
                status: "accepted",
                ngoId:  req.ngoUser.ngoId
            },
            {
                $set: {
                    status:         "closed",
                    closedAt:       now,
                    closureRemarks: closureRemarks.trim()
                }
            },
            { new: true }
        );

        if (!transfer) {
            return res.status(404).json({
                success: false,
                message: "Transfer not found, not in accepted state, or does not belong to your NGO."
            });
        }

        // ── 3. Resolve the underlying Report ────────────────────────────────
        const report = await Report.findById(transfer.reportId).lean();

        if (!report) {
            // Orphaned transfer — roll back so the NGO user can retry or
            // an admin can investigate the inconsistency.
            await NgoTransfer.findByIdAndUpdate(transfer._id, {
                $set: { status: "accepted", closedAt: null, closureRemarks: "" }
            });
            return res.status(409).json({
                success: false,
                message: "Associated report no longer exists. Transfer has been rolled back."
            });
        }

        // ── 4. Update Report to terminal resolved state ──────────────────────
        // Sets status:'resolved', stamps resolvedAt, stores who/why, and
        // clears NGO ownership fields so the report is no longer "live".
        const reportUpdate = {
            status:             "resolved",
            resolvedAt:         now,
            resolutionRemark:   closureRemarks.trim(),
            resolvedBy:         req.ngoUser.email || req.ngoUser.uid,
            currentHandlerType: "none",
            currentNgoId:       null,
            transferStatus:     "none"
        };

        try {
            await Report.findByIdAndUpdate(
                transfer.reportId,
                { $set: reportUpdate }
            );
        } catch (reportErr) {
            // Report update failed — roll NgoTransfer back to 'accepted' so the
            // NGO staff member can retry without leaving split-brain state.
            await NgoTransfer.findByIdAndUpdate(transfer._id, {
                $set: { status: "accepted", closedAt: null, closureRemarks: "" }
            });
            console.error("[close] Report update failed, transfer rolled back:", reportErr.message);
            return res.status(500).json({
                success: false,
                message: "Failed to update report status. Transfer has been rolled back."
            });
        }

        // ── 5. NGO stats (fire-and-forget) ───────────────────────────────────
        // activeCases decremented; closedCases and recoveredAnimals incremented.
        Ngo.findByIdAndUpdate(req.ngoUser.ngoId, {
            $inc: {
                "stats.activeCases":      -1,
                "stats.closedCases":       1,
                "stats.recoveredAnimals":  1
            }
        }).catch(err => console.error("[close] NGO stats update failed:", err.message));

        // ── 6. Notify Paid Volunteer (fire-and-forget) ───────────────────────
        // Inform the volunteer who requested the transfer that the NGO has
        // successfully resolved the case.
        User.findOne({ uid: transfer.requestedByUid })
            .select("uid deviceToken fullName")
            .lean()
            .then(volunteer => {
                if (!volunteer) return;
                return createNotification({
                    recipientUid: volunteer.uid,
                    type:         "TRANSFER_CLOSED",
                    title:        "Case Closed by NGO",
                    body:         `The NGO has successfully closed the rescue case for "${report.title || "a rescue"}".`,
                    data:         { reportId: String(report._id) },
                    deviceToken:  volunteer.deviceToken || null,
                    context:      { uid: volunteer.uid, fullName: volunteer.fullName || "" }
                });
            })
            .catch(err => console.error("[close] Volunteer notification failed:", err.message));

        // ── 7. Notify Reporter (fire-and-forget) ─────────────────────────────
        // Let the original reporter know their case has been resolved.
        if (report.reporterUid) {
            createNotification({
                recipientUid: report.reporterUid,
                type:         "rescue_completed_reporter",
                title:        "Your Rescue Case Has Been Resolved",
                body:         `Great news! The animal you reported has been helped. ${closureRemarks.trim()}`,
                data:         { reportId: String(report._id) },
                deviceToken:  report.reporterDeviceToken || null,
                context:      { uid: report.reporterUid, fullName: report.reporterName || "" }
            }).catch(err => console.error("[close] Reporter notification failed:", err.message));
        }

        return res.status(200).json({ success: true, transfer });

    } catch (error) {
        console.error("[close] Unexpected error:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
