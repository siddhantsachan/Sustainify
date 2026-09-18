const express = require("express");
const router = express.Router();
const ScrapItem = require("../models/ScrapItem");

// ---------------------------------------------------------------------------
// Scrap Rates page
// ---------------------------------------------------------------------------
router.get("/ScrapRates", async (req, res, next) => {
  try {
    const scrapItems = await ScrapItem.find();
    res.render("ScrapRates", { scrapItems });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Price Calculator page
// ---------------------------------------------------------------------------
router.get("/PriceCalculator", (req, res) => {
  res.render("PriceCalculator");
});

// ---------------------------------------------------------------------------
// JSON API — consumed by PriceCalculator frontend JS
// ---------------------------------------------------------------------------
router.get("/api/scrap-items", async (req, res, next) => {
  try {
    const items = await ScrapItem.find();
    res.json(items);
  } catch (err) { next(err); }
});

module.exports = router;
