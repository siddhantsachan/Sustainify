const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");
const rateLimit = require("express-rate-limit");
const pickupboy = require("../models/PickUser");
const pickmodel = require("../models/pickup");
const { requirePickupAuth } = require("../middleware/auth");
const { sendMail } = require("../utils/mailer");

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: "Too many OTP requests. Please try again after 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many login attempts. Please try again after 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
router.get("/pickupBoySignUpPage", (req, res) => {
  res.render("pickupboysignup", { errorMessage: " " });
});

router.get("/pickupBoyLoginPage", (req, res) => {
  res.render("pickupboylogin", { errorMessage: " " });
});

router.get("/pickboyotp", (req, res) => {
  res.render("pickboyotp", { errorMessage: "" });
});

router.get("/pickupNewPass", (req, res) => {
  res.render("pickupNewPass");
});

router.get("/PickUpBoyPage", requirePickupAuth, async (req, res, next) => {
  try {
    const user = await pickupboy.findOne({ Email: req.session.pickupEmail });
    const pickups = await pickmodel.find({ pincode: user.Pincode, status: "Pending" });
    res.render("PickupBoyPage", { user, pickups });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------
router.post(
  "/PickUpSignup",
  otpLimiter,
  [
    body("email").isEmail().withMessage("Invalid email address"),
    body("name").trim().isLength({ min: 2 }).withMessage("Name must be at least 2 characters"),
    body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
    body("pincode").isNumeric().isLength({ min: 6, max: 6 }).withMessage("Pincode must be 6 digits"),
    body("aadhar").isNumeric().isLength({ min: 12, max: 12 }).withMessage("Aadhar must be 12 digits"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render("pickupboysignup", { errorMessage: errors.array()[0].msg });
    }

    const { email, name, password, confpassword, pincode, address, aadhar } = req.body;

    if (password !== confpassword) {
      return res.render("pickupboysignup", { errorMessage: "Passwords do not match" });
    }

    // Use _tmp* prefix so unapproved signup state doesn't trigger requirePickupAuth
    req.session._tmpPickupName = name;
    req.session._tmpPickupEmail = email;
    req.session._tmpPickupPassword = password;
    req.session._tmpPickupPin = pincode;
    req.session._tmpPickupAddress = address;
    req.session._tmpPickupAadhar = aadhar;
    req.session.otp = Math.floor(Math.random() * 9000) + 1000;
    req.session.redirect = 1;

    console.log(`[OTP] Pickup signup OTP for ${email}: ${req.session.otp}`);
    sendMail(email, "Confirm your Sustainify pickup boy signup", `Your sign-up code is ${req.session.otp}`);

    res.redirect("/pickboyotp");
  }
);

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------
router.post("/pickotp", async (req, res, next) => {
  const { otp } = req.body;

  if (String(otp) !== String(req.session.otp)) {
    return res.render("pickboyotp", { errorMessage: "Wrong OTP. Please try again." });
  }

  if (req.session.redirect === 1) {
    try {
      const hashedPassword = await bcrypt.hash(req.session._tmpPickupPassword, 10);
      await new pickupboy({
        Name: req.session._tmpPickupName,
        Email: req.session._tmpPickupEmail,
        Password: hashedPassword,
        Address: req.session._tmpPickupAddress,
        Aadhar: req.session._tmpPickupAadhar,
        Pincode: req.session._tmpPickupPin,
      }).save();

      // Clean up temp session keys
      delete req.session._tmpPickupName;
      delete req.session._tmpPickupEmail;
      delete req.session._tmpPickupPassword;
      delete req.session._tmpPickupPin;
      delete req.session._tmpPickupAddress;
      delete req.session._tmpPickupAadhar;
      delete req.session.otp;
      delete req.session.redirect;

      res.redirect("/pickupBoyLoginPage");
    } catch (err) { next(err); }
  } else {
    delete req.session.otp;
    delete req.session.redirect;
    res.redirect("/pickupNewPass");
  }
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
router.post("/PickUpLogin", loginLimiter, async (req, res, next) => {
  const { email, password, forgetemail } = req.body;

  if (forgetemail) {
    try {
      const user = await pickupboy.findOne({ Email: forgetemail });
      if (!user) return res.render("pickupboylogin", { errorMessage: "User not found" });

      req.session.otp = Math.floor(Math.random() * 9000) + 1000;
      req.session.redirect = 0;
      req.session.forgotEmail = forgetemail;

      console.log(`[OTP] Pickup reset OTP for ${forgetemail}: ${req.session.otp}`);
      sendMail(forgetemail, "Sustainify password reset", `Your reset code is ${req.session.otp}`);

      return res.redirect("/pickboyotp");
    } catch (err) { return next(err); }
  }

  try {
    const user = await pickupboy.findOne({ Email: email });
    if (!user) return res.render("pickupboylogin", { errorMessage: "User not found" });

    const isMatch = await bcrypt.compare(password, user.Password);
    if (!isMatch) return res.render("pickupboylogin", { errorMessage: "Incorrect Password" });

    if (!user.approved) {
      return res.render("pickupboylogin", {
        errorMessage: "Account not approved yet. Please contact admin.",
      });
    }

    // Auth session keys written ONLY here, after approval check passes
    req.session.pickupEmail = user.Email;
    req.session.pickupName = user.Name;

    const pickups = await pickmodel.find({ pincode: user.Pincode, status: "Pending" });
    res.render("PickupBoyPage", { user, pickups });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// New Password (after forgot-password OTP)
// ---------------------------------------------------------------------------
router.post("/pickupNewPass", async (req, res, next) => {
  try {
    const user = await pickupboy.findOne({ Email: req.session.forgotEmail });
    if (!user) return res.status(404).send("User not found");

    user.Password = await bcrypt.hash(req.body.newpass, 10);
    await user.save();

    delete req.session.forgotEmail;
    res.redirect("/pickupBoyLoginPage");
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Mark Completed
// Pincode scope fix: pickup boy can only complete pickups in their own area
// ---------------------------------------------------------------------------
router.get("/MarkCompleted/:id", requirePickupAuth, async (req, res, next) => {
  try {
    const user = await pickupboy.findOne({ Email: req.session.pickupEmail });
    if (!user) return next(new Error("Session invalid — pickup boy not found"));

    const updated = await pickmodel.findOneAndUpdate(
      { _id: req.params.id, pincode: user.Pincode },
      { status: "Completed" },
      { new: true }
    );

    if (!updated) {
      return res.status(403).send("Cannot complete this pickup — not in your area or already completed.");
    }

    const pickups = await pickmodel.find({ pincode: user.Pincode, status: "Pending" });
    res.render("PickupBoyPage", { pickups, user });
  } catch (err) { next(err); }
});

module.exports = router;
