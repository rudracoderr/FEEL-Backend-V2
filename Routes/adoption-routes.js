const express = require("express");
const router = express.Router();
const validateMongoId = require("../middleware/validateObjectId");
router.param("id", validateMongoId("id"));
const { validate, str, body } = require("../middleware/validate");

const AdoptionListing = require("../Models/adoption-listing-model");
const AdoptionApplication = require("../Models/adoption-application-model");
const requireAuth = require("../middleware/requireAuth");
const { createNotification } = require("../Services/notification-service");
const mongoose = require("mongoose");
const User = require("../Models/usermodel");
router.param("applicationId", validateMongoId("applicationId"));

// POST /api/adoptions
// Create a new adoption listing. Status defaults to pending.
router.post("/", requireAuth, validate(
    str("animalName", 100), str("species", 50), str("breed", 100), str("age", 50), str("gender", 30),
    str("description", 3000),
    body("photos").optional().isArray({ max: 10 }),
    body("photos.*").isString().isLength({ max: 2048 }),
    body("location").optional().isObject(),
    str("location.state", 100), str("location.city", 100), str("location.area", 100),
    body("health").optional().isObject(),
    body("health.vaccinated").optional().isBoolean(),
    body("health.sterilized").optional().isBoolean()
), async (req, res) => {
    try {
        const {
            animalName,
            species,
            breed,
            age,
            gender,
            photos,
            description,
            location,
            health
        } = req.body;

        const payload = {
            animalName,
            species,
            breed,
            age,
            gender,
            photos,
            description,
            location,
            health,
            ownerUid: req.authUid,
            status: "pending"
        };

        const adoptionListing = await AdoptionListing.create(payload);

        return res.status(201).json({
            success: true,
            adoptionListing
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// GET /api/adoptions
// Returns only approved listings
router.get("/", async (req, res) => {
    try {
        const adoptionListings = await AdoptionListing.find({ status: "approved" }).sort({ createdAt: -1 });
        return res.status(200).json({
            success: true,
            adoptionListings
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// GET /api/adoptions/my-listings
// Returns listings created by the authenticated user
router.get("/my-listings", requireAuth, async (req, res) => {
    try {
        const adoptionListings = await AdoptionListing.find({ ownerUid: req.authUid }).sort({ createdAt: -1 });
        return res.status(200).json({ success: true, adoptionListings });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// GET /api/adoptions/my-applications
// Returns applications created by the authenticated user
router.get("/my-applications", requireAuth, async (req, res) => {
    try {
        const applications = await AdoptionApplication.find({ applicantUid: req.authUid })
            .populate("listingId")
            .sort({ createdAt: -1 });
        return res.status(200).json({ success: true, applications });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// POST /api/adoptions/:id/apply
// Submit an application for an adoption listing
router.post("/:id/apply", requireAuth, validate(
    str("reason", 2000), str("experience", 2000), str("livingSituation", 2000),
    body("phone").optional().isString().bail().matches(/^[0-9+()\-.\s]{0,20}$/).withMessage("phone format is invalid")
), async (req, res) => {
    try {
        const listing = await AdoptionListing.findById(req.params.id);
        if (!listing) return res.status(404).json({ success: false, message: "Listing not found" });
        if (listing.status !== "approved") return res.status(403).json({ success: false, message: "Listing is not available for adoption" });
        if (listing.ownerUid === req.authUid) return res.status(403).json({ success: false, message: "You cannot apply to your own listing" });

        const { reason, experience, livingSituation, phone } = req.body;
        if (!reason || !experience || !livingSituation || !phone) {
            return res.status(400).json({ success: false, message: "All form fields are required" });
        }

        const application = await AdoptionApplication.create({
            listingId: listing._id,
            applicantUid: req.authUid,
            formAnswers: { reason, experience, livingSituation, phone },
            status: "pending"
        });

        const owner = await User.findOne({ uid: listing.ownerUid });
        await createNotification({
            recipientUid: listing.ownerUid,
            type: "adoption_application",
            title: "New Adoption Application",
            body: `Someone applied to adopt ${listing.animalName}.`,
            data: { reportId: String(listing._id), reportTitle: listing.animalName },
            deviceToken: owner?.deviceToken
        });

        return res.status(201).json({ success: true, application });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ success: false, message: "You have already applied for this listing." });
        }
        return res.status(400).json({ success: false, message: error.message });
    }
});

// GET /api/adoptions/:id/applications
// Owner only: view applications for a specific listing
router.get("/:id/applications", requireAuth, async (req, res) => {
    try {
        const listing = await AdoptionListing.findById(req.params.id);
        if (!listing) return res.status(404).json({ success: false, message: "Listing not found" });
        if (listing.ownerUid !== req.authUid) return res.status(403).json({ success: false, message: "Not authorized to view applications for this listing" });

        const applications = await AdoptionApplication.find({ listingId: listing._id }).sort({ createdAt: -1 });
        return res.status(200).json({ success: true, applications });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// PATCH /api/adoptions/applications/:applicationId/approve
router.patch("/applications/:applicationId/approve", requireAuth, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const application = await AdoptionApplication.findById(req.params.applicationId).session(session);
        if (!application) throw new Error("Application not found");
        if (application.status !== "pending") throw new Error("Application is already decided");

        const listing = await AdoptionListing.findById(application.listingId).session(session);
        if (!listing) throw new Error("Listing not found");
        if (listing.ownerUid !== req.authUid) throw new Error("Not authorized");
        if (listing.status === "adopted") throw new Error("Listing is already adopted");

        application.status = "approved";
        await application.save({ session });

        listing.status = "adopted";
        await listing.save({ session });

        await AdoptionApplication.updateMany(
            { listingId: listing._id, _id: { $ne: application._id }, status: "pending" },
            { $set: { status: "rejected" } },
            { session }
        );

        await session.commitTransaction();
        session.endSession();

        const winner = await User.findOne({ uid: application.applicantUid });
        await createNotification({
            recipientUid: application.applicantUid,
            type: "adoption_approved",
            title: "Adoption Approved!",
            body: `Your application for ${listing.animalName} was approved!`,
            data: { reportId: String(listing._id) },
            deviceToken: winner?.deviceToken
        });

        const rejectedApps = await AdoptionApplication.find({ listingId: listing._id, _id: { $ne: application._id }, status: "rejected" });
        for (const app of rejectedApps) {
            const rejectedUser = await User.findOne({ uid: app.applicantUid });
            await createNotification({
                recipientUid: app.applicantUid,
                type: "adoption_rejected",
                title: "Adoption Update",
                body: `${listing.animalName} has been adopted by someone else.`,
                data: { reportId: String(listing._id) },
                deviceToken: rejectedUser?.deviceToken
            });
        }

        return res.status(200).json({ success: true, application, listing });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        const status = (error.message.includes("Not authorized")) ? 403 : (error.message.includes("not found") ? 404 : 409);
        return res.status(status).json({ success: false, message: error.message });
    }
});

// PATCH /api/adoptions/applications/:applicationId/reject
router.patch("/applications/:applicationId/reject", requireAuth, async (req, res) => {
    try {
        const application = await AdoptionApplication.findById(req.params.applicationId);
        if (!application) return res.status(404).json({ success: false, message: "Application not found" });
        if (application.status !== "pending") return res.status(409).json({ success: false, message: "Application already decided" });

        const listing = await AdoptionListing.findById(application.listingId);
        if (!listing) return res.status(404).json({ success: false, message: "Listing not found" });
        if (listing.ownerUid !== req.authUid) return res.status(403).json({ success: false, message: "Not authorized" });

        application.status = "rejected";
        await application.save();

        const applicantUser = await User.findOne({ uid: application.applicantUid });
        await createNotification({
            recipientUid: application.applicantUid,
            type: "adoption_rejected",
            title: "Adoption Update",
            body: `Your application for ${listing.animalName} was declined.`,
            data: { reportId: String(listing._id) },
            deviceToken: applicantUser?.deviceToken
        });

        return res.status(200).json({ success: true, application });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// PATCH /api/adoptions/applications/:applicationId/cancel
router.patch("/applications/:applicationId/cancel", requireAuth, async (req, res) => {
    try {
        const application = await AdoptionApplication.findById(req.params.applicationId);
        if (!application) return res.status(404).json({ success: false, message: "Application not found" });
        if (application.applicantUid !== req.authUid) return res.status(403).json({ success: false, message: "Not authorized" });
        if (application.status !== "pending") return res.status(409).json({ success: false, message: "Cannot cancel a decided application" });

        application.status = "cancelled";
        await application.save();

        return res.status(200).json({ success: true, application });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// GET /api/adoptions/:id
// Returns a single listing
router.get("/:id", async (req, res) => {
    try {
        const adoptionListing = await AdoptionListing.findById(req.params.id);

        if (!adoptionListing) {
            return res.status(404).json({
                success: false,
                message: "Adoption listing not found"
            });
        }

        return res.status(200).json({
            success: true,
            adoptionListing
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;
