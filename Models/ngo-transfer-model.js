const mongoose = require('mongoose');

const ngoTransferSchema = new mongoose.Schema({
    // ── Core Reference Fields (existing) ────────────────────────────────────

    reportId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Report', 
        required: true 
    },
    ngoId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Ngo', 
        required: true 
    },
    requestedByUid: { 
        type: String, 
        required: true 
    },

    // ── Status & Remarks (existing) ──────────────────────────────────────────

    status: { 
        type: String, 
        enum: ['pending', 'accepted', 'rejected', 'cancelled', 'closed'], 
        default: 'pending' 
    },
    remarks: { 
        type: String, 
        default: '' 
    },
    closureRemarks: { 
        type: String, 
        default: '' 
    },

    // ── Timestamps (existing) ────────────────────────────────────────────────

    requestedAt: { 
        type: Date, 
        default: Date.now 
    },
    acceptedAt: { 
        type: Date, 
        default: null 
    },
    rejectedAt: { 
        type: Date, 
        default: null 
    },
    cancelledAt: { 
        type: Date, 
        default: null 
    },
    closedAt: { 
        type: Date, 
        default: null 
    },

    // ── Snapshot Fields (new) ────────────────────────────────────────────────
    // All snapshot sub-documents are optional at the schema level so that
    // existing transfer documents (created before this migration) remain valid.

    // Reporter at the time the transfer was initiated
    reporterSnapshot: {
        uid:   { type: String, default: null },
        name:  { type: String, default: '' },
        phone: { type: String, default: '' }
    },

    // Paid volunteer who initiated the transfer
    transferredBy: {
        uid:   { type: String, default: null },
        name:  { type: String, default: '' },
        phone: { type: String, default: '' }
    },

    // NGO at the time the transfer was initiated
    ngoSnapshot: {
        id:    { type: mongoose.Schema.Types.ObjectId, ref: 'Ngo', default: null },
        name:  { type: String, default: '' },
        phone: { type: String, default: '' }
    },

    // NGO staff member who accepted the transfer
    acceptedBy: {
        uid:   { type: String, default: null },
        name:  { type: String, default: '' },
        phone: { type: String, default: '' }
    },

    // NGO staff member who rejected the transfer (if applicable)
    rejectedBy: {
        uid:   { type: String, default: null },
        name:  { type: String, default: '' },
        phone: { type: String, default: '' }
    },

    // ── Animal Snapshot (new) ────────────────────────────────────────────────
    // Persisted at request-time so historical records are immutable even if
    // the original Report document is later edited.
    animalSnapshot: {
        imageUrls:   { type: [String], default: [] },
        animalType:  { type: String,   default: '' },
        description: { type: String,   default: '' },
        address:     { type: String,   default: '' },
        location: {
            type: {
                type: String,
                enum: ['Point'],
                default: 'Point'
            },
            coordinates: { type: [Number], default: [] }
        }
    },

    // ── Rescue Condition (new) ───────────────────────────────────────────────
    // Captured by the paid volunteer when submitting the transfer request
    // to give the NGO context before accepting.
    condition: {
        severity: {
            type: String,
            enum: ['low', 'medium', 'high', 'critical'],
            default: null
        },
        summary:        { type: String,  default: '' },
        needsShelter:   { type: Boolean, default: false },
        needsTransport: { type: Boolean, default: false },
        needsSurgery:   { type: Boolean, default: false }
    }

    // ────────────────────────────────────────────────────────────────────────
});

// Partial index to enforce only one active transfer (pending or accepted) per report natively
ngoTransferSchema.index(
    { reportId: 1 }, 
    { 
        unique: true, 
        partialFilterExpression: { status: { $in: ['pending', 'accepted'] } } 
    }
);

// Quick lookups for NGO dashboard
ngoTransferSchema.index({ ngoId: 1, status: 1 });

// Quick lookups for Volunteer dashboard
ngoTransferSchema.index({ requestedByUid: 1, status: 1 });

module.exports = mongoose.model('NgoTransfer', ngoTransferSchema);
