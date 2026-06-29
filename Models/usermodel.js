
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
        enum: ["user", "admin"],
        default: "user"
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

const User =mongoose.model("User", userSchema);

module.exports = User;