// user routes for adding data to the collection and fetching data from the collection when a report is created or fetched by the user
const express = require("express");

const router = express.Router();
const User = require("../Models/usermodel");
const requireAuth = require("../middleware/requireAuth");

router.use(requireAuth);

// CREATE USER
router.post("/", async (req, res) => {
    try {
        const { uid, email, fullName, age, phone, city, isVolunteer, location, deviceToken } = req.body;

        if (uid && uid !== req.authUid) {
            return res.status(403).json({
                error: "uid must match authenticated user"
            });
        }

        if (!email) {
            return res.status(400).json({
                error: "email is required"
            });
        }

        if (!location || !Array.isArray(location.coordinates) || location.coordinates.length !== 2) {
            return res.status(400).json({
                error: "location with coordinates [longitude, latitude] is required"
            });
        }

        const existingUser = await User.findOne({ uid: req.authUid });

        // Enforce user suspension check
        if (existingUser && existingUser.isSuspended) {
            if (isVolunteer) {
                return res.status(403).json({
                    error: "Suspended users cannot create volunteer applications."
                });
            }
        }

        // Determine volunteer status transitions
        let nextIsVolunteer = existingUser ? existingUser.isVolunteer : false;
        let nextVolunteerStatus = existingUser ? (existingUser.volunteerStatus || "none") : "none";

        if (isVolunteer !== undefined) {
            const requestedVolunteer = Boolean(isVolunteer);
            if (requestedVolunteer) {
                // Suspended users checked above, now handle normal transitions
                if (nextVolunteerStatus === "none" || nextVolunteerStatus === "rejected") {
                    nextVolunteerStatus = "pending";
                    nextIsVolunteer = false; // Admin must approve first
                }
            } else {
                nextVolunteerStatus = "none";
                nextIsVolunteer = false;
            }
        }

        const user = await User.findOneAndUpdate(
            { uid: req.authUid },
            {
                $set: {
                    uid: req.authUid,
                    email,
                    fullName,
                    age,
                    phone,
                    city,
                    isVolunteer: nextIsVolunteer,
                    volunteerStatus: nextVolunteerStatus,
                    location,
                    deviceToken: typeof deviceToken === "string" && deviceToken.trim() ? deviceToken.trim() : null
                },
                $setOnInsert: {
                    role: "user"
                }
            },
            {
                new: true,
                upsert: true,
                runValidators: true,
                setDefaultsOnInsert: true
            }
        );

        res.status(201).json(user);
    }
    catch (error) {
        res.status(400).json({
            error: error.message
        });
    }
});

// UPDATE DEVICE TOKEN
router.patch("/:uid/device-token", async (req, res) => {
    try {
        const { uid } = req.params;
        const { deviceToken } = req.body;

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

        if (typeof deviceToken !== "string" || !deviceToken.trim()) {
            return res.status(400).json({
                success: false,
                message: "deviceToken is required"
            });
        }

        const updatedUser = await User.findOneAndUpdate(
            { uid: req.authUid },
            {
                $set: {
                    deviceToken: deviceToken.trim()
                }
            },
            {
                new: true,
                runValidators: true
            }
        );

        if (!updatedUser) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Device token updated successfully",
            user: updatedUser
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});
// UPDATE AVAILABILITY
router.patch("/:uid/availability", async (req, res) => {
    try {
        const { uid } = req.params;
        const { isAvailable, location } = req.body;

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

        if (typeof isAvailable !== "boolean") {
            return res.status(400).json({
                success: false,
                message: "isAvailable must be a boolean"
            });
        }

        const updateData = { isAvailable };
        if (location && Array.isArray(location.coordinates) && location.coordinates.length === 2) {
            updateData.location = location;
        }

        const updatedUser = await User.findOneAndUpdate(
            { uid: req.authUid },
            { $set: updateData },
            {
                new: true,
                runValidators: true
            }
        );

        if (!updatedUser) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Availability updated successfully",
            user: updatedUser
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// GET USER BY FIREBASE UID
router.get("/:uid", async (req, res) => {
    try {
        const { uid } = req.params;

        if (!uid) {
            return res.status(400).json({
                error: "uid is required"
            });
        }

        if (uid !== req.authUid) {
            return res.status(403).json({
                error: "Forbidden"
            });
        }

        const user = await User.findOne({ uid: req.authUid });

        if (!user) {
            return res.status(404).json({
                error: "User not found"
            });
        }

        res.set({
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
        });

        return res.status(200).json(user);
    } catch (error) {
        console.error("Get user by uid failed:", error);
        return res.status(500).json({
            error: "Failed to fetch user",
            details: error.message
        });
    }
});

module.exports = router;