import express from "express";
import approvalneedUser, { confirmOrder, deliveredOrder, getAllActiveVendor, getAllOrder, getallVendors, getSingleOrder, outofDelivery, rejectApproval, shippedOrder, statusApproval, totalSell  } from "../controller/adminController.js";
import isAuthenticated from "../middlewares/isAuthenticated.js";
import requireRole from "../middlewares/requireRole.js";

const router = express.Router() ;

// Approving a vendor is what unlocks prices and ordering, so it must never be
// open to an anonymous caller. Every client that uses these routes (web admin,
// Flutter admin_api.dart) already sends the Bearer token.
const adminOnly = [isAuthenticated, requireRole("admin")];
const ordersStaff = [isAuthenticated, requireRole("admin", "marketing")];

router.get("/pending-vendor" , ...adminOnly, approvalneedUser) ;
router.put("/approval-mail/:id" , ...adminOnly, statusApproval ) ;
router.put("/reject-vendor/:id" , ...adminOnly, rejectApproval ) ;

// Still public: the Flutter delivery and marketing screens call it without a
// token. Lock it once those builds send one.
router.get("/all-orders" , getAllOrder ) ;

// Every role's order screen on the web, and Flutter admin, send the token.
router.get("/single-order/:id" , isAuthenticated, getSingleOrder ) ;

router.put("/confirm-order/:id" , ...ordersStaff, confirmOrder ) ;
router.put("/shipped-order/:id" , ...ordersStaff, shippedOrder) ;
// Still public: Flutter delivery_api.dart sends these two without a token.
router.put("/outof-delivery/:id" , outofDelivery ) ;
router.put("/delivered-prder/:id" , deliveredOrder ) ;

// Still public: Flutter marketing/outlet vendor pickers call it without a
// token. Passwords are stripped in the controller.
router.get("/all-vendors" , getallVendors ) ;
router.get("/active-vendors" , getAllActiveVendor ) ;
router.get("/total-revenue" , ...adminOnly, totalSell ) ;


export default router ;
