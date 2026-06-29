const mongoose = require("mongoose");

const adoptionListingSchema = new mongoose.Schema(
    {
        animalName: {
            type: String,
            required: true,
            trim: true
        },
        species: {
            type: String,
            required: true,
            trim: true
        },
        breed: {
            type: String,
            trim: true
        },
        age: {
            type: String,
            required: true,
            trim: true
        },
        gender: {
            type: String,
            required: true,
            trim: true
        },
        photos: {
            type: [String],
            default: []
        },
        description: {
            type: String,
            required: true,
            trim: true
        },
        location: {
            state: {
                type: String,
                required: true,
                trim: true
            },
            city: {
                type: String,
                required: true,
                trim: true
            },
            area: {
                type: String,
                trim: true
            }
        },
        latitude: {
            type: Number
        },
        longitude: {
            type: Number
        },
        health: {
            vaccinated: {
                type: Boolean,
                default: false
            },
            sterilized: {
                type: Boolean,
                default: false
            }
        },
        ownerUid: {
            type: String,
            required: true
        },
        status: {
            type: String,
            enum: ["pending", "approved", "adopted", "rejected"],
            default: "pending"
        }
    },
    { timestamps: true }
);

const AdoptionListing = mongoose.model("AdoptionListing", adoptionListingSchema);

module.exports = AdoptionListing;
