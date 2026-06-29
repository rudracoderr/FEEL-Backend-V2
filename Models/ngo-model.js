const mongoose = require("mongoose");

const ngoSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },
        contactEmail: {
            type: String,
            required: true,
            trim: true
        },
        phone: {
            type: String,
            default: "",
            trim: true
        },
        city: {
            type: String,
            default: "",
            trim: true
        },
        active: {
            type: Boolean,
            default: true
        }
    },
    {
        timestamps: true
    }
);

const Ngo = mongoose.model("Ngo", ngoSchema);

module.exports = Ngo;
