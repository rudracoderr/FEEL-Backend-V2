const mongoose = require('mongoose');
const NgoTransfer = require('./Models/ngo-transfer-model');
const Report = require('./Models/report-model');
const Ngo = require('./Models/ngo-model');
const User = require('./Models/usermodel');
const Notification = require('./Models/notification-model');
require('dotenv').config();

const BASE_URL = "http://localhost:5000/api";

async function runTests() {
    try {
        await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/feel_rescue");
        console.log("Connected to DB");

        console.log("\n--- 3. Mongo Indexes Verification ---");
        await NgoTransfer.init();
        const indexes = await NgoTransfer.collection.indexes();
        console.log(JSON.stringify(indexes, null, 2));

        // Setup test data
        const volunteerUid = "test_volunteer_" + Date.now();
        const ngoAdminUid = "test_ngo_admin_" + Date.now();
        
        const testNgo = await Ngo.create({
            name: "Test NGO " + Date.now(),
            email: "testngo" + Date.now() + "@example.com",
            phone: "1234567890",
            verificationStatus: "verified"
        });

        await User.create({
            uid: ngoAdminUid,
            fullName: "NGO Admin",
            email: testNgo.email,
            phone: testNgo.phone,
            role: "ngo_admin",
            ngoId: testNgo._id,
            location: { type: "Point", coordinates: [72.8777, 19.0760] }
        });

        await User.create({
            uid: volunteerUid,
            fullName: "Paid Volunteer",
            email: "volunteer@example.com",
            phone: "0987654321",
            role: "user",
            location: { type: "Point", coordinates: [72.8777, 19.0760] }
        });

        const testReport = await Report.create({
            title: "Injured Dog",
            description: "Needs help",
            severity: "High",
            location: { type: "Point", coordinates: [72.8777, 19.0760] },
            reporterName: "Reporter",
            reporterContact: "1111111111",
            imageUrls: ["http://example.com/img.jpg"],
            status: "accepted",
            assistance: {
                status: "accepted",
                acceptedByUid: volunteerUid
            }
        });

        console.log(`\nCreated Test Report: ${testReport._id}`);
        console.log(`Test NGO: ${testNgo._id}`);

        // Helper for fetch
        async function fetchAPI(method, path, uid, body) {
            const options = {
                method,
                headers: {
                    'Authorization': `Mock ${uid}`,
                    'Content-Type': 'application/json'
                }
            };
            if (body) options.body = JSON.stringify(body);
            const res = await fetch(BASE_URL + path, options);
            const data = await res.json().catch(() => null);
            return { status: res.status, data };
        }

        console.log("\n--- 4. Postman Results ---");

        console.log("\n-> Create Transfer");
        let res = await fetchAPI("POST", `/reports/${testReport._id}/transfers`, volunteerUid, { ngoId: testNgo._id, remarks: "Needs shelter" });
        console.log(res.status, res.data);
        const transferId = res.data.transfer._id;

        console.log("\n-> Duplicate Create");
        res = await fetchAPI("POST", `/reports/${testReport._id}/transfers`, volunteerUid, { ngoId: testNgo._id, remarks: "Another one" });
        console.log(res.status, res.data);

        console.log("\n-> NGO List Transfers");
        res = await fetchAPI("GET", `/ngo/transfers?status=pending`, ngoAdminUid);
        console.log(res.status, res.data);

        console.log("\n-> Reject Transfer");
        res = await fetchAPI("PUT", `/ngo/transfers/${transferId}/reject`, ngoAdminUid);
        console.log(res.status, res.data);

        console.log("\n-> Cancel Pending Transfer (should fail since it's rejected)");
        res = await fetchAPI("DELETE", `/reports/${testReport._id}/transfers/${transferId}`, volunteerUid);
        console.log(res.status, res.data);

        // Recreate transfer for testing accept and concurrency
        console.log("\n-> Create New Transfer for Concurrency Test");
        res = await fetchAPI("POST", `/reports/${testReport._id}/transfers`, volunteerUid, { ngoId: testNgo._id, remarks: "Try 2" });
        const transferId2 = res.data.transfer._id;

        console.log("\n--- 5. Concurrency Test ---");
        const acceptPromise = fetchAPI("PUT", `/ngo/transfers/${transferId2}/accept`, ngoAdminUid);
        const cancelPromise = fetchAPI("DELETE", `/reports/${testReport._id}/transfers/${transferId2}`, volunteerUid);
        const [acceptRes, cancelRes] = await Promise.all([acceptPromise, cancelPromise]);
        
        console.log("Accept Response:", acceptRes.status, acceptRes.data);
        console.log("Cancel Response:", cancelRes.status, cancelRes.data);

        console.log("\n--- 6. Ownership Verification ---");
        const reportAfter = await Report.findById(testReport._id).lean();
        console.log("Report Document After (Notice status is still 'accepted' and no NGO data inside report):");
        console.log(JSON.stringify({ status: reportAfter.status, assistance: reportAfter.assistance }, null, 2));

        console.log("\n--- 7. Notifications Verification ---");
        const notifs = await Notification.find({ "data.reportId": String(testReport._id) }).select("type title recipientUid data.reportId");
        console.log(JSON.stringify(notifs, null, 2));

    } catch (e) {
        console.error(e);
    } finally {
        // Cleanup mock logic from requireAuth.js (optional)
        process.exit(0);
    }
}

runTests();
