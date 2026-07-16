const mongoose = require("mongoose");

const reportSchema = new mongoose.Schema({
// add deviecetoken
    title: {
        type: String,
        required: true
    },

    description: {
        type: String,
        required: true
    },

    severity: {
        type: String,
        enum: ["Low", "Medium", "High", "Critical"],
        default: "Low"
    },

    status: {
        type: String,
        enum: ["pending", "accepted", "resolved", "fake"],
        default: "pending"
    },

    assignedVolunteer: {
        uid: {
            type: String,
            default: null
        },
        fullName: {
            type: String,
            default: ""
        },
        phone: {
            type: String,
            default: ""
        },
        email: {
            type: String,
            default: ""
        }
    },

    acceptedAt: {
        type: Date,
        default: null
    },

    resolvedAt: {
        type: Date,
        default: null
    },

    volunteerProgress: {
        type: String,
        enum: ["Assigned", "On The Way", "Reached Location", "Resolved"],
        default: null
    },

    progressUpdatedAt: {
        type: Date,
        default: null
    },

    resolutionDetails: {
        photoUrl: {
            type: String,
            trim: true,
            default: null
        },
        note: {
            type: String,
            trim: true,
            default: null
        },
        resolvedAt: {
            type: Date,
            default: null
        },
        resolvedByUid: {
            type: String,
            trim: true,
            default: null
        }
    },

    resolutionRemark: {
        type: String,
        trim: true,
        default: ""
    },

    resolvedBy: {
        type: String,
        trim: true,
        default: ""
    },

    location: {
        type: {
            type: String,
            enum: ["Point"],
            default: "Point"
        },

        coordinates: {
            type: [Number],
            required: true
        }

    },

    address: {
        type: String,
        default: ""
    },

    landmark: {
        type: String,
        default: ""
    },

    date: {
        type: Date,
        default: Date.now
    },


    reporterName: {
        type: String,
        required: true
    },

    reporterUid: {
        type: String,
        default: null
    },

    reporterContact: {
        type: String,
        required: true
    },

    reporterDeviceToken: {
        type: String,
        default: null
    },

    imageUrls: {
        type: [String],
        required: true,
        validate: {
            validator: function(imageUrls) {
                return Array.isArray(imageUrls) && imageUrls.length > 0;
            },
            message: "At least one report image is required"
        }
    },

    // ── Paid Volunteer Assistance ───────────────────────────────────────────
    // A single paid volunteer may assist the assigned regular volunteer.
    // Only one paid volunteer can accept per report (enforced at the API layer
    // via an atomic findOneAndUpdate filter on assistance.status === "pending").
    //
    // status lifecycle:
    //   none → pending (volunteer requests) → accepted (paid volunteer accepts)
    //                                        → cancelled (volunteer cancels request)
    //
    // Contact snapshot fields mirror the assignedVolunteer pattern so the
    // assigned volunteer can display paid volunteer contact without a DB lookup.

    assistance: {

        status: {
            type: String,
            enum: ["none", "pending", "accepted"],
            default: "none"
        },

        requestedByUid: {
            type: String,
            default: null
        },

        requestedAt: {
            type: Date,
            default: null
        },

        acceptedByUid: {
            type: String,
            default: null
        },

        acceptedAt: {
            type: Date,
            default: null
        },

        // Contact snapshots — stored at accept-time, mirrors assignedVolunteer pattern
        acceptedByName: {
            type: String,
            default: ""
        },

        acceptedByPhone: {
            type: String,
            default: ""
        }

    }

    // ───────────────────────────────────────────────────────────────────────

});

reportSchema.index({ location: "2dsphere" });

const Report = mongoose.model("Report", reportSchema);

module.exports = Report;
