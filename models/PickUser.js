const mongoose = require('mongoose');
// Connection is managed centrally in app.js — not here

const userSchema = new mongoose.Schema({
    Name: { type: String, required: true },
    Email: { type: String, required: true, unique: true },
    Password: { type: String, required: true },
    Address: { type: String, required: true },
    Pincode: { type: Number, required: true, min: 100000, max: 999999999 },
    Aadhar: { type: Number, required: true, unique: true, min: 100000000000, max: 999999999999 },
    pickups: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: "pickup"
        }
    ],
    approved: { type: Boolean, default: false } // Added field
});

module.exports = mongoose.model("pickupboy", userSchema);
