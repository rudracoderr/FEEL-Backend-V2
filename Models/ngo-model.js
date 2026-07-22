const mongoose = require("mongoose");

const ngoSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            unique: true,
            trim: true
        },
        email: {
            type: String,
            required: true,
            unique: true,
            trim: true
        },
        phone: {
            type: String,
            required: true,
            trim: true
        },
        address: {
            type: String,
            default: "",
            trim: true
        },
        verificationStatus: {
            type: String,
            enum: ['pending', 'verified', 'rejected'],
            default: 'verified'
        },
        logoUrl: {
            type: String,
            default: ""
        },
        active: {
            type: Boolean,
            default: true
        },
        stats: {
            totalCases: { type: Number, default: 0 },
            activeCases: { type: Number, default: 0 },
            recoveredAnimals: { type: Number, default: 0 },
            closedCases: { type: Number, default: 0 }
        }
    },
    {
        timestamps: true
    }
);

const Ngo = mongoose.model("Ngo", ngoSchema);

module.exports = Ngo;
