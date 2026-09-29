const mongoose = require("mongoose");

const adoptionApplicationSchema = new mongoose.Schema(
    {
        listingId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AdoptionListing",
            required: true,
            index: true
        },
        applicantUid: {
            type: String,
            required: true,
            index: true
        },
        formAnswers: {
            reason: {
                type: String,
                required: true,
                trim: true
            },
            experience: {
                type: String,
                required: true,
                trim: true
            },
            livingSituation: {
                type: String,
                required: true,
                trim: true
            },
            phone: {
                type: String,
                required: true,
                trim: true
            }
        },
        status: {
            type: String,
            enum: ["pending", "approved", "rejected", "cancelled"],
            default: "pending"
        }
    },
    { timestamps: true }
);

// Prevent multiple active applications from the same user for the same listing
// Using a partial index so a user can re-apply if their previous application was cancelled or rejected (optional, but good practice).
// The requirement: "Prevent duplicate active/submitted applications from the same applicant for the same listing."
adoptionApplicationSchema.index(
    { listingId: 1, applicantUid: 1 },
    { 
        unique: true, 
        partialFilterExpression: { status: { $in: ["pending", "approved"] } } 
    }
);

const AdoptionApplication = mongoose.model("AdoptionApplication", adoptionApplicationSchema);

module.exports = AdoptionApplication;
