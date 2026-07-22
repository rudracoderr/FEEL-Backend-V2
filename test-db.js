require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./Models/usermodel');

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    const user = await User.findOne({ uid: '0u9kQnbxKPbRlyE1vqPlyjjGOFC2' });
    console.log(user);
    console.log("Role:", user?.role);
    process.exit(0);
}
run().catch(console.error);
