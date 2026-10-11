import order from "../model/orderModel.js";
import Vendor from "../model/userModel.js";
import nodemailer from "nodemailer";
import generateInvoiceForOrder from "../utils/invoiceGenerator.js";
import { sendBrevoEmail } from "../utils/brevoUtils.js";

const approvalneedUser = async (req, res) => {

    try {

        const pendingUser = await Vendor.find({

            approvalStatus: "Pending"
        });

        console.log(" pending user ", pendingUser);

        // Empty list is not an error — let the admin screen show "no requests".
        return res.status(200)
            .json({
                message: "vendor fetched ",
                success: true,
                pendingUser
            });

    }
    catch (er) {
        console.log("error is :", er);
        return res.status(500)
            .json({
                message: "Internal server error ",
                success: false
            });
    }
}

export default approvalneedUser;




export const statusApproval = async (req, res) => {
    try {
        const vendorId = req.params.id;

        const pendingVendor = await Vendor.findById(vendorId);

        if (!pendingVendor) {
            return res.status(404).json({
                message: "Vendor not found",
                success: false
            });
        }

        // Status update karke save karein
        pendingVendor.approvalStatus = "Approved";
        await pendingVendor.save();

        // Email sending (Best-effort: agar mail fail bhi ho toh approval cancel nahi hoga)
        try {
            const brevoResponse = await sendBrevoEmail({
      to: pendingVendor.email,
      toName: pendingVendor.contact_person_name,
      subject: "Account Approved - VS Arogya",
      htmlContent: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; padding: 20px;">
                    <h2>Registration Approved! 🎉</h2>
                    <p>Hello <b>${pendingVendor.contact_person_name}</b>,</p>
                    <p>Your vendor account for <b>${pendingVendor.store_name}</b> has been successfully approved by the admin.</p>
                    
                    <div style="background: #f4f4f4; padding: 15px; border-radius: 5px; margin: 20px 0;">
                        <p style="margin: 0;"><b>Your Login ID / Mobile No:</b> ${pendingVendor.mobile_no}</p>
                    </div>

                    <p>You can now log in to the application and start managing your store.</p>
                    <br>
                    <p>Warm Regards,<br><b>Team VS Arogya</b></p>
                </div>
            `,
    });
            console.log("Approval email sent via Brevo:", brevoResponse?.messageId || brevoResponse);

        } catch (mailErr) {
            console.error(
                "Approval mail failed (non-fatal):",
                mailErr?.response?.body || mailErr?.message
            );
        }

        return res.status(200).json({
            message: "Vendor approved successfully and notification sent.",
            success: true
        });

    } catch (error) {
        console.error("Status Approval Error:", error);

        return res.status(500).json({
            message: "Internal server error",
            success: false,
            error: error.message
        });
    }
};


export const rejectApproval = async (req, res) => {
    try {
        const vendor_id = req.params.id;

        const vendor = await Vendor.findById(vendor_id);

        if (!vendor) {
            return res.status(401).json({
                message: "Vendor not found ",
                success: false
            });
        }

        vendor.approvalStatus = "Rejected";
        await vendor.save();

        // Best-effort email using Brevo API
        // Rejection is already saved, so email failure is non-fatal.
        try {
            const info = await sendBrevoEmail({
                to: vendor.email,
                toName: vendor.contact_person_name,
                subject: "Account Rejected",
                htmlContent: `
                    <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                        <h2>Registration Rejected</h2>

                        <p>Hello ${vendor.contact_person_name},</p>

                        <p>
                            Your account has been rejected by the admin.
                        </p>

                        <p>
                            If you have questions regarding this decision,
                            please contact our support team.
                        </p>

                        <p>
                            Warm Regards,<br>
                            Team: VS Arogya
                        </p>
                    </div>
                `,
            });

            console.log(
                "Rejection email sent via Brevo:",
                info?.messageId
            );

        } catch (mailErr) {
            console.error(
                "Rejection mail failed (non-fatal):",
                mailErr?.response?.body || mailErr?.message
            );
        }

        return res.status(200).json({
            message: "Vendor rejected",
            success: true
        });

    } catch (er) {
        console.log("error from reject Approval ", er);

        return res.status(500).json({
            message: "Internal server error ",
            success: false
        });
    }
};

export const getAllOrder = async (req, res) => {

    try {

        const allOrders = await order.find()
            .populate("user")
            .populate("orderItems.product")
            .sort({ createdAt: -1 });

        if (!allOrders) {
            return res.status(401)
                .json({
                    message: "orders not found ",
                    success: false
                });
        }

        return res.status(200)
            .json({

                message: "all orders fetched ",
                success: true,
                allOrders
            });

    }
    catch (er) {

        console.log(" error from get all order ", er);

        return res.status(500)
            .json({
                message: "Internal server error ",
                success: false
            });
    }
}

export const getSingleOrder = async (req, res) => {

    try {

        const single_order_id = req.params.id;

        const single_order = await order.findById(single_order_id).populate("orderItems.product");

        //  console.log( "address of order is :" ,  single_order.orderItems[0] );


        if (!single_order) {

            return res.status(401)
                .json({
                    message: "Order not found ",
                    success: false
                });
        }

        return res.status(200)
            .json({
                message: "fetched success ",
                success: true,
                details: single_order.orderItems[0],
                amount: single_order.totalAmount
            });

    }
    catch (er) {

        console.log("error from single order ", er);

        return res.status(500)
            .json({

                message: "Internal server error ",
                success: false
            });
    }
}

export const confirmOrder = async (req, res) => {

    try {

        const order_id = req.params.id;

        const confirm_order = await order.findById(order_id);

        if (!confirm_order) {
            return res.status(404)
                .json({
                    message: "Order not found ",
                    success: false
                });
        }

        confirm_order.orderStatus = "Confirm Order";

        await confirm_order.save();

        // Render the official invoice (templates/invoice.html) NOW — before we
        // reply — so it is guaranteed to exist the instant the app shows the
        // order as Confirmed. This means the app never falls back to its
        // on-device invoice: it fetches GET /prev-invoice/:id and the PDF is
        // already linked. Generation is idempotent (vendor-placed orders that
        // already have one are skipped) and non-fatal (returns null only if the
        // PDF engine truly fails, in which case the order is still confirmed).
        //
        // Because we await Puppeteer here, the client gives this endpoint a
        // longer timeout (see confirm-order calls in marketing_api / admin_api).
        const createdInvoice = await generateInvoiceForOrder(confirm_order._id);

        return res.status(200)
            .json({
                message: "order confirmed ",
                success: true,
                order: {
                    _id: confirm_order._id,
                    orderStatus: confirm_order.orderStatus,
                    ...(createdInvoice
                        ? {
                            invoice: {
                                invoiceNumber: createdInvoice.invoiceNumber,
                                pdfUrl: createdInvoice.pdfUrl
                            }
                        }
                        : {})
                }
            });

    }
    catch (er) {
        console.log("error from confirm order is :", er);

        return res.status(500)
            .json({
                message: "Internal server error ",
                success: false
            });
    }
}

export const shippedOrder = async (req, res) => {

    try {

        const order_id = req.params.id;

        const order_details = await order.findById(order_id);

        if (!order_details) {
            return res.status(401)
                .json({

                    message: "order not found ",
                    success: false
                });
        }
        order_details.orderStatus = "Shipped";
        await order_details.save();

        return res.status(201)
            .json({

                message: "Order status changed successfylly ",
                success: true,
                status: order_details.orderStatus
            });

    }
    catch (er) {
        console.log("error from update order ", er);

        return res.status(500)
            .json({
                message: "Internal server error ",
                success: false
            });
    }
}


export const outofDelivery = async (req, res) => {

    try {

        const order_id = req.params.id;

        const order_details = await order.findById(order_id);

        if (!order_details)
            return res.status(401)
                .json({
                    message: "Order not found ",
                    success: false
                });

        order_details.orderStatus = "Out for Delivery";
        await order_details.save();

        return res.status(200)
            .json({

                message: "Order out of delivery ",
                success: true
            });
    }
    catch (er) {
        console.log("error is :", er);
        return res.status(500)
            .json({
                message: "Internal server error ",
                success: false
            });
    }
}

export const deliveredOrder = async (req, res) => {

    try {

        const order_id = req.params.id;

        const order_details = await order.findById(order_id)

        if (!order_details) {
            return res.status(401)
                .json({
                    message: "Order not found ",
                    success: false
                });
        }

        order_details.orderStatus = "Delivered";
        await order_details.save();

        return res.status(201)
            .json({
                message: "Order deliverd successfully ",
                success: true
            });

    }
    catch (er) {

        console.log("error from delivered order ", er);
        return res.status(500)
            .json({
                message: "Internal server error ",
                success: false
            });
    }
}

export const getallVendors = async (req, res) => {

    try {

        const all_vendors = await Vendor.find().select("-password");

        if (all_vendors.length == 0)
            return res.status(402)
                .json({
                    message: "Vendors are missing",
                    success: false
                });

        return res.status(201)
            .json({
                message: "all vendors are fetched successfully ",
                success: true,
                all_vendors
            });
    }
    catch (er) {

        console.log(" error from allVendor", er);
        return res.status(500)
            .json({

                message: "Internal server error ",
                success: false
            });

    }
}

export const getAllActiveVendor = async (req, res) => {

    try {

        const active_vendor = await Vendor.find({
            approvalStatus: "Approved"
        }).select("-password");

        // Empty list is not an error — reply 200 so callers (admin count,
        // outlet vendor picker) can render "none yet" instead of failing.
        return res.status(200)
            .json({
                message: "active vendors fetched successfully ",
                success: true,
                count: active_vendor.length,
                active_vendor
            });
    }
    catch (er) {

        console.log("error from get all acitvevendor ", er);

        return res.status(500)
            .json({
                message: "Internal Server error ",
                success: false
            });
    }
}

export const totalSell = async (req, res) => {

    try {
        const all_orders = await order.aggregate([
            {
                $match: {
                    orderStatus: "Delivered"
                },
            },
            {
                $group: {
                    _id: null,
                    totalRevenue: { $sum: "$totalAmount" },
                    count: { $sum: 1 }
                }
            }
        ]);

        const totalRevenue = all_orders.length > 0 ? all_orders[0].totalRevenue : 0;
        const deliveredCount = all_orders.length > 0 ? all_orders[0].count : 0;

        return res.status(200)
            .json({
                message: "Total revenue fetched successfully ",
                success: true,
                totalRevenue,
                deliveredCount,
                all_orders
            });

    }
    catch (er) {
        console.log(" error from total sell", er);
        return res.status(500)
            .json({

                message: "Internal server error ",
                success: false
            });
    }
}



