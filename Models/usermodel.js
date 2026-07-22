
const mongoose = require("mongoose");
const userSchema = new mongoose.Schema({

    uid: {
   type: String,
   required: true,
   unique: true
},

    email: {
        type: String,
        required: true,
        unique: true
    },

    fullName: {
        type: String,
        default: ""
    },

    age: {
        type: Number,
        default: null
    },

    phone: {
        type: String,
        default: ""
    },

    city: {
        type: String,
        default: ""
    },

    isVolunteer: {
        type: Boolean,
        default: false
    },

    role: {
        type: String,
        enum: ["user", "admin", "ngo_admin", "ngo_member"],
        default: "user"
    },

    ngoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Ngo",
        default: null
    },

    isSuspended: {
        type: Boolean,
        default: false
    },

    suspensionReason: {
        type: String,
        default: null
    },

    suspendedAt: {
        type: Date,
        default: null
    },

    suspendedBy: {
        type: String,
        default: null
    },

    volunteerStatus: {
        type: String,
        enum: ["none", "pending", "approved", "rejected", "suspended"],
        default: "none"
    },

    volunteerSuspensionReason: {
        type: String,
        default: null
    },

    volunteerSuspendedAt: {
        type: Date,
        default: null
    },

    volunteerSuspendedBy: {
        type: String,
        default: null
    },

    // ── Paid Volunteer ─────────────────────────────────────────────────────
    // isPaidVolunteer is a separate identity flag from isVolunteer.
    // A paid volunteer has their own approval lifecycle (paidVolunteerStatus)
    // that runs in parallel to the regular volunteer lifecycle.
    // IMPORTANT: Do NOT repurpose isVolunteer or volunteerStatus for this.

    isPaidVolunteer: {
        type: Boolean,
        default: false
    },

    paidVolunteerStatus: {
        type: String,
        enum: ["none", "pending", "approved", "rejected", "suspended"],
        default: "none"
    },

    rescueRadius: {
        type: Number,
        default: 10
    },

    isAvailable: {
        type: Boolean,
        default: true
    },

    // ───────────────────────────────────────────────────────────────────────

    createdAt: {
        type: Date,
        default: Date.now
    },

    lastActivityAt: {
        type: Date,
        default: Date.now
    },


    location: {

        type: {
            type: String,
            default: "Point"
        },

        coordinates: {
            type: [Number],
            required: true
        }


    },
    deviceToken: {
        type: String,
        default: null
    }

});

userSchema.index({ location: "2dsphere" });
userSchema.index({ ngoId: 1 });

const User =mongoose.model("User", userSchema);

module.exports = User;