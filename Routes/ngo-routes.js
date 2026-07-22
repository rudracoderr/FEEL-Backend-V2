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

// PUT /api/ngo/transfers/:id/accept
router.put("/transfers/:id/accept", async (req, res) => {
    try {
        const transfer = await NgoTransfer.findOneAndUpdate(
            { _id: req.params.id, status: 'pending', ngoId: req.ngoUser.ngoId },
            { $set: { status: 'accepted', acceptedByUid: req.ngoUser.uid, acceptedAt: new Date() } },
            { new: true }
        ).populate('reportId', 'reporterUid');

        if (!transfer) {
            return res.status(400).json({ success: false, message: "Transfer request is no longer pending or does not exist." });
        }

        // Notify volunteer
        await createNotification({
            recipientUid: transfer.requestedByUid, // Notify the Paid Volunteer who requested it
            title: "Transfer Accepted",
            body: `An NGO has accepted your transfer request.`,
            type: "TRANSFER_ACCEPTED",
            data: { reportId: String(transfer.reportId._id || transfer.reportId) }
        });

        // Also update NGO active cases stat
        await Ngo.findByIdAndUpdate(req.ngoUser.ngoId, { $inc: { "stats.activeCases": 1 } });

        return res.status(200).json({ success: true, transfer });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// PUT /api/ngo/transfers/:id/reject
router.put("/transfers/:id/reject", async (req, res) => {
    try {
        const transfer = await NgoTransfer.findOneAndUpdate(
            { _id: req.params.id, status: 'pending', ngoId: req.ngoUser.ngoId },
            { $set: { status: 'rejected', rejectedAt: new Date() } },
            { new: true }
        );

        if (!transfer) {
            return res.status(400).json({ success: false, message: "Transfer request is no longer pending or does not exist." });
        }

        // Notify volunteer
        await createNotification({
            recipientUid: transfer.requestedByUid,
            title: "Transfer Rejected",
            body: `Your transfer request was rejected by the NGO.`,
            type: "TRANSFER_REJECTED",
            data: { reportId: String(transfer.reportId._id || transfer.reportId) }
        });

        return res.status(200).json({ success: true, transfer });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
