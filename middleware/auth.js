/**
 * Auth Middleware
 *
 * Design decision: Centralising role checks here replaces 20+ duplicated
 * if (req.session.X) blocks spread across every route handler.
 *
 * Benefits vs inline checks:
 *  - Single place to change auth logic (e.g. switch from session to JWT later)
 *  - Routes are self-documenting — requireUserAuth signals protection at a glance
 *  - Prevents accidentally skipping the check when adding new routes
 *
 * Trade-off: Slightly more indirection. Acceptable for any app with > 3 routes.
 */

function requireUserAuth(req, res, next) {
  if (req.session.Name) return next();
  res.redirect("/LoginPage");
}

function requirePickupAuth(req, res, next) {
  if (req.session.pickupName) return next();
  res.redirect("/pickupBoyLoginPage");
}

function requireAdminAuth(req, res, next) {
  if (req.session.adminName) return next();
  res.redirect("/AdministratorLoginPage");
}

module.exports = { requireUserAuth, requirePickupAuth, requireAdminAuth };
