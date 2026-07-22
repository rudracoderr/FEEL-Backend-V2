const mongoose = require('mongoose');
const NgoTransfer = require('./Models/ngo-transfer-model');
const Report = require('./Models/report-model');
const Ngo = require('./Models/ngo-model');
const User = require('./Models/usermodel');
const Notification = require('./Models/notification-model');
require('dotenv').config();

async function runTests() {
    try {
        await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/feel_rescue");
        console.log("Connected to DB");

        // 3. Mongo indexes verification
        console.log("\n--- 3. Mongo Indexes Verification ---");
        await NgoTransfer.init();
        const indexes = await NgoTransfer.collection.indexes();
        console.log(JSON.stringify(indexes, null, 2));
        
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}

runTests();
