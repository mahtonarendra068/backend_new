// Load .env BEFORE anything else is imported.
//
// ESM hoists every `import` above the module body, so calling dotenv.config()
// further down runs AFTER utils/razorpay.js and utils/cloudinary.js have already
// been evaluated — and both read process.env at import time (their config()
// calls sit at module top level). Importing "dotenv/config" here runs the load
// as part of THIS import, so the env is populated before those modules are
// pulled in below.
import "dotenv/config";

import dns from "node:dns";
// Render's network can't reach Gmail SMTP over IPv6 (ENETUNREACH on :465).
// Prefer IPv4 so nodemailer connects. Must run before any DNS lookups.
dns.setDefaultResultOrder("ipv4first");

import express, { urlencoded } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import connectDb from "./utils/db.js";
import userRouter from "./routes/userRoute.js";
import addProductRouter from "./routes/postRouter.js";
import cardRouter from "./routes/cartRoute.js";
import orderRouter from "./routes/orderRoute.js";
import adminRouter from "./routes/adminRoute.js";
import paymentRouter from "./routes/paymentRoute.js"
import bannerRouter from "./routes/bannerRoute.js";
import couponRouter from "./routes/couponRoute.js";
import invoiceRouter from "./routes/invoiceRoute.js";
import agentRouter from "./routes/deliveryRoute.js";
import manualRouter from "./routes/manualRoute.js"
import xlshRouter from "./routes/xlshRoute.js"
import outletRouter from "./routes/outletRoute.js"
import marketing_agentRouter from "./routes/agentRoute.js";
import batchRouter from "./routes/batchRoute.js";
import notificationRouter from "./routes/notificationRoute.js";
import { startNotificationScheduler } from "./utils/notificationScheduler.js";
import whatsappRoute from "./routes/whatsapRoute.js"
import bulkUploadRouter from "./routes/bulkUploadRoute.js";
// import whtspotpRouter from "./routes/whtspotpRoute.js" ;
import eotpRouter from "./routes/eotpRoute.js"

const app = express();

const port = process.env.PORT || 3000;



// middlewares
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(urlencoded({ extended: true }));

const corsOptions = {

    origin: 'http://localhost:50900/',
    credentials: true
}


// all api
app.use('/vsArogya', userRouter);
app.use('/vsArogya', addProductRouter);
app.use('/vsArogya', cardRouter);
app.use('/vsArogya', orderRouter);
app.use('/vsArogya', adminRouter);
app.use('/vsArogya', paymentRouter);
app.use('/vsArogya', bannerRouter);
app.use('/vsArogya', couponRouter);
app.use('/vsArogya', invoiceRouter);
app.use('/vsArogya', agentRouter);
app.use('/vsArogya', manualRouter);
app.use('/vsArogya', xlshRouter);
app.use('/vsArogya', outletRouter);
app.use('/vsArogya', marketing_agentRouter);
app.use('/vsArogya', batchRouter);
app.use('/vsArogya' , notificationRouter ) ;
app.use('/vsArogya' , bulkUploadRouter ) ;

app.use('/vsArogya' , eotpRouter);

// WhatsApp Business webhook (Meta calls GET to verify, POST for events).
// Mounted on its own prefix because Meta owns the path shape.
app.use("/vsArogya/whatsapp", whatsappRoute);


app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "VS Arogya Backend is running 🚀",
    });
});


app.listen(port, () => {
    connectDb();
    // Scheduled sends, stuck-broadcast recovery, retry sweeps and device-token
    // hygiene for the push notification system. Timer-based and unref'd, so it
    // adds no request-path cost and never blocks shutdown.
    startNotificationScheduler();
    console.log("Server is working ", port);
})
