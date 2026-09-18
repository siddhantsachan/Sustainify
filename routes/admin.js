const express = require("express");
const router = express.Router();
const pickmodel = require("../models/pickup");
const pickupboy = require("../models/PickUser");
const ScrapItem = require("../models/ScrapItem");
const { requireAdminAuth } = require("../middleware/auth");

// Design decision: Admin credentials in .env, not hardcoded in source.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
router.get("/AdministratorLoginPage", (req, res) => {
  res.render("AdministratorLoginPage", { errorMessage: "" });
});

router.post("/AdminLogin", (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    req.session.adminName = "Admin";
    res.redirect("/AdminDashboard");
  } else {
    res.render("AdministratorLoginPage", { errorMessage: "Invalid login credentials!" });
  }
});

// ---------------------------------------------------------------------------
// Dashboard & Profile
// ---------------------------------------------------------------------------
router.get("/AdminDashboard", requireAdminAuth, async (req, res, next) => {
  try {
    const allpickups = await pickmodel.find();
    res.render("AdminDashboard", { pickups: allpickups, Account: req.session.adminName });
  } catch (err) { next(err); }
});

router.get("/AdminProfile", requireAdminAuth, (req, res) => {
  res.render("AdminProfile", {
    user: { Name: req.session.adminName, Email: ADMIN_EMAIL },
  });
});

// ---------------------------------------------------------------------------
// Pickup boy applications
// ---------------------------------------------------------------------------
router.get("/CheckPickupApplications", requireAdminAuth, async (req, res, next) => {
  try {
    const requests = await pickupboy.find({ approved: false });
    res.render("CheckPickupApplications", { requests });
  } catch (err) { next(err); }
});

router.get("/Verify/:_id", requireAdminAuth, async (req, res, next) => {
  try {
    const updated = await pickupboy.findByIdAndUpdate(
      req.params._id,
      { approved: true },
      { new: true }
    );
    if (!updated) return res.status(404).send("User not found");

    const requests = await pickupboy.find({ approved: false });
    res.render("CheckPickupApplications", { requests });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Pickups overview
// ---------------------------------------------------------------------------
router.get("/CheckPickups", requireAdminAuth, async (req, res, next) => {
  try {
    const allpickups = await pickmodel.find();
    res.render("CheckPickups", { pickups: allpickups });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Scrap item management
// ---------------------------------------------------------------------------
router.get("/admin/add-scrap-item", requireAdminAuth, (req, res) => {
  res.render("addScrapItem");
});

router.post("/admin/add-scrap-item", requireAdminAuth, async (req, res, next) => {
  const { category, name, price, unit, imageUrl } = req.body;
  try {
    await new ScrapItem({ category, name, price, unit, imageUrl }).save();
    res.redirect("/ScrapRates");
  } catch (err) { next(err); }
});

module.exports = router;
