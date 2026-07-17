const express = require("express");
const router = express.Router();
const validateMongoId = require("../middleware/validateObjectId");
router.param("id", validateMongoId("id"));

const AdoptionListing = require("../Models/adoption-listing-model");
const requireAuth = require("../middleware/requireAuth");

// POST /api/adoptions
// Create a new adoption listing. Status defaults to pending.
router.post("/", requireAuth, async (req, res) => {
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
