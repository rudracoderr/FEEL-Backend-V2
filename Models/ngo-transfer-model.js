const mongoose = require('mongoose');

const ngoTransferSchema = new mongoose.Schema({
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
    acceptedByUid: { 
        type: String, 
        default: null 
    },
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
    }
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
