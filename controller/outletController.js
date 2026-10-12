import Outlet from "../model/outletregistersModel.js";
import outletStock from "../model/outletStockModel.js";
import OutletStockBatch from "../model/outletStockBatchModel.js";
import product from "../model/productModel.js";
import jwt from "jsonwebtoken"
import converter from "number-to-words"
import Vendor from "../model/userModel.js";
import { generateInvoiceHTML } from "../templates/invoiceTemplate.js";
import { generatePDF } from "../utils/generatePdf.js";
import cloudinary from "../utils/cloudinary.js";
import order from "../model/orderModel.js";
import Invoice from "../model/invoiceModel.js";
import { sendBrevoEmail } from "../utils/brevoUtils.js";
import { normalizeFreeQty } from "../utils/freeGoods.js";
import { buildInvoiceItems, invoiceRow } from "../utils/invoiceItems.js";
import {
    withInventoryTxn,
    allocateFEFO,
    creditOutletBatches,
    getSellableOutletBatches,
    previewOutletAllocation,
    allocateOutletFEFO,
    normalizeAllocations,
    InsufficientStockError,
} from "../utils/inventory.js";

/// Renders an order line's FEFO allocation for the invoice's Batch / Expiry
/// columns BEFORE the line is split into one row per lot (see
/// utils/invoiceItems.js). In practice these supply single-lot lines and the
/// fallback for legacy orders with no allocation snapshot; multi-lot lines take
/// their batch and expiry from the split instead.
const invoiceBatchNo = (allocations, product) => {
    const list = Array.isArray(allocations) ? allocations : [];
    const numbers = list.map((a) => a.batch_number).filter(Boolean);
    if (numbers.length) return numbers.join(" + ");
    return product?.batch_no || "N/A";
};

/// The expiry printed beside the batch: the FEFO-front (earliest) lot's, which
/// is the soonest-expiring stock on that line.
const invoiceExpDate = (allocations, product) => {
    const list = Array.isArray(allocations) ? allocations : [];
    return list[0]?.expiry_date || product?.exp_date || "N/A";
};


const outletRegister = async (req, res) => {
    try {


        console.log("outlet register called ");

        const { outletName, ownerName, mobileNo,
            email, address, city, state, pincode,
            gstNumber, status, password
        } = req.body;

        console.log("req.body is :", req.body);

        if (!outletName || !ownerName || !mobileNo || !email || !address || !city || !state
            || !pincode || !gstNumber || !password
        ) {
            return res.status(400)
                .json({
                    message: "Missing fields ",
                    success: false
                });
        }

        const existing = await Outlet.findOne({ mobileNo });
        if (existing) {
            return res.status(409)
                .json({
                    message: "An outlet with this mobile number already exists",
                    success: false
                });
        }

        const outlet = await Outlet.create({
            outletName,
            ownerName,
            mobileNo,
            email,
            address,
            city,
            state,
            pincode,
            gstNumber,
            status: status || "Active",
            password
        });

        // Never echo the password back to the client.
        const { password: _pw, ...safeOutlet } = outlet.toObject();

        return res.status(201)
            .json({
                message: "Outlet registered successfully ",
                success: true,
                outlet: safeOutlet
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
};

export default outletRegister;


export const outlet_login = async (req, res) => {

    try {
        const { mobileNo, password } = req.body;

        if (!mobileNo || !password) {
            return res.status(400)
                .json({
                    message: "Field are missing ",
                    success: false
                });
        }

        const outlet_details = await Outlet.findOne({ mobileNo });

        if (!outlet_details) {
            return res.status(400)
                .json({
                    message: "Data mismatch",
                    success: false
                });
        }

        if (password !== outlet_details.password) {
            return res.status(400)
                .json({
                    message: "Somthing is wrong ",
                    success: false
                });
        }


        // token generate 
        const token = jwt.sign(

            {
                id: outlet_details._id,
                role: "outlet"
            },
            process.env.SECRET_KEY,
            { expiresIn: "7d" }
        );

        res.cookie("token", token, {
            httpOnly: true,
            maxAge: 7 * 24 * 60 * 60 * 1000,
            sameSite: "strict"
        });

        // The app captures `token` (Bearer auth, works on web + mobile) and the
        // `outlet` object (minus password) to populate its session — every
        // outlet-scoped call is keyed on the returned outlet _id.
        const { password: _pw, ...safeOutlet } = outlet_details.toObject();

        return res.status(200)
            .json({
                message: "Outlet Login success ",
                success: true,
                role: "outlet",
                token,
                outlet: safeOutlet
            });
    }
    catch (er) {
        console.log("error is ", er);

        return res.status(500)
            .json({
                message: "Internal server error ",
                success: false
            });
    }
};


export const addOutletStock = async (req, res) => {
    try {
        // `allocations` (optional) is the batch breakdown Marketing explicitly
        // chose in the Stock Assignment screen: [{ batch, batch_number,
        // quantity }]. Omitted → pure FEFO, exactly as this endpoint has always
        // behaved, so every existing caller is unaffected.
        const { productId, outletId, quantity, allocations } = req.body;

        if (!productId || !outletId || !quantity) {
            return res.status(400).json({
                success: false,
                message: "All fields are required"
            });
        }

        const Product = await product.findById(productId);
        const outlet = await Outlet.findById(outletId);

        if (!Product) {
            return res.status(404).json({
                success: false,
                message: "Product not found"
            });
        }

        if (!outlet) {
            return res.status(404).json({
                success: false,
                message: "Outlet not found"
            });
        }

        const qty = Number(quantity);
        if (!Number.isFinite(qty) || qty <= 0) {
            return res.status(400).json({
                success: false,
                message: "Quantity must be a positive number"
            });
        }

        // The catalog is the source: assigning stock to an outlet moves it OUT
        // of the global product stock. This is the point where catalog batches
        // are consumed FEFO — allocateFEFO drains the nearest-expiry lots first
        // and keeps product.stock (the SUM mirror) in sync. The whole move
        // (catalog consume + outlet credit) is one transaction so a short assign
        // can never create outlet stock from nothing.
        const existingStock = await outletStock.findOne({
            product: productId,
            outlet: outletId
        });

        let resultStock;
        try {
            resultStock = await withInventoryTxn(async (session) => {
                // Consume the catalog batches FEFO, and record the SAME batch
                // identities (number + expiry) as outlet batches so the outlet
                // knows exactly which lots it now holds (used later by POS
                // billing). recalcOutletStock keeps outletStock.quantity as the
                // synced total, so nothing below the mirror changes for readers.
                //
                // The explicitly chosen batches (when sent) are validated and
                // honoured; anything left over is filled FEFO. The SAME engine
                // enforces per-batch availability, so a stale pick can never
                // assign more than a lot holds.
                const allocated = await allocateFEFO(
                    productId,
                    qty,
                    session,
                    normalizeAllocations(allocations)
                );
                await creditOutletBatches(outletId, productId, allocated, session, {
                    purchase_price: Product.mrp || Product.price || 0,
                    selling_price: Product.price || 0,
                });

                // outletStock.quantity is now maintained by recalcOutletStock
                // (upsert) — just return the current row for the response.
                const row = await outletStock.findOne(
                    { outlet: outletId, product: productId }
                ).session(session);
                return { row, allocated };
            });
        } catch (err) {
            if (err instanceof InsufficientStockError) {
                return res.status(400).json({ success: false, message: err.message });
            }
            throw err;
        }

        return res.status(existingStock ? 200 : 201).json({
            success: true,
            message: existingStock ? "Stock updated successfully" : "Stock added successfully",
            stock: resultStock.row,
            // Audit trail: exactly which lots left the catalog for this outlet.
            allocations: resultStock.allocated.map((a) => ({
                batch: a.batch,
                batch_number: a.batch_number,
                expiry_date: a.expiry_date,
                quantity: a.quantity
            }))
        });

    }
    catch (error) {

        console.log("er is :", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

export const getOutletProducts = async (req, res) => {
    try {

        const outletId = req.params.id;

        const stocks = await outletStock
            .find({ outlet: outletId })
            .populate("product");

        console.log("stock is :", outletId);

        // Attach the batch position of the OUTLET's own stock. The populated
        // product carries the CATALOG's mirror (batch_no/exp_date = the
        // catalog's FEFO-front lot), which is not necessarily the lot this
        // outlet holds — it may have been assigned an earlier or later batch.
        // These additive fields state what the outlet will actually sell next.
        //
        // Additive only: every existing field is returned untouched, so a
        // client that ignores `batch` keeps working exactly as before.
        const batchRows = await OutletStockBatch.find({
            outlet: outletId,
            available_quantity: { $gt: 0 },
        }).sort({ expiry_date: 1, createdAt: 1 });

        // First row per product = that product's FEFO-front lot (the sort above
        // puts the nearest expiry first).
        const frontByProduct = new Map();
        const countByProduct = new Map();
        for (const b of batchRows) {
            const key = String(b.product);
            if (!frontByProduct.has(key)) frontByProduct.set(key, b);
            countByProduct.set(key, (countByProduct.get(key) || 0) + 1);
        }

        const products = stocks.map((s) => {
            const plain = s.toObject();
            const key = String(plain.product?._id || plain.product);
            const front = frontByProduct.get(key);
            plain.batch = front
                ? {
                    _id: front._id,
                    batch_number: front.batch_number,
                    expiry_date: front.expiry_date,
                    available_quantity: front.available_quantity,
                    isExpiringSoon: front.isExpiringSoon,
                }
                : null;
            plain.batch_count = countByProduct.get(key) || 0;
            return plain;
        });

        return res.status(200).json({
            success: true,
            count: products.length,
            products
        });

    } catch (error) {
        console.log(error);

        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
}


export const addToCart = async (req, res) => {
    try {

        const outletId = req.id;

        console.log("outlet id :", outletId ) ;

        // freeQty is optional free goods for this line, and allocations the
        // batches the user pinned for it; both omitted → the line's current
        // values stay as they are, so existing callers are unaffected.
        const { productId, quantity, freeQty, allocations } = req.body;

        const outlet = await Outlet.findById(outletId);

        if (!outlet) {
            return res.status(404).json({
                success: false,
                message: "Outlet not found"
            });
        }

        const get_product = await product.findById(productId);

        if (!get_product) {
            return res.status(404).json({
                success: false,
                message: "Product not found"
            });
        }

        const existingItem = outlet.cart.find(
            item => item.product.toString() === productId
        );

        if (existingItem) {

            existingItem.quantity += Number(quantity);

            if (freeQty !== undefined) {
                existingItem.freeQty = normalizeFreeQty(freeQty);
            }

            // The pinned batches describe the WHOLE line, so a later call
            // replaces them rather than appending.
            if (allocations !== undefined) {
                existingItem.allocations = normalizeAllocations(allocations);
            }

        } else {

            outlet.cart.push({
                product: productId,
                quantity,
                freeQty: normalizeFreeQty(freeQty),
                allocations: normalizeAllocations(allocations)
            });

        }

        await outlet.save();

        return res.status(200).json({
            success: true,
            message: "Product added to cart",
            cart: outlet.cart
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }

};


// cart summary
export const cartSummary = async (req, res) => {
    try {

        const outletId = req.id;

        console.log("outlet id ", outletId ) ;

        const outlet = await Outlet.findById(outletId)
            .populate("cart.product");

        if (!outlet) {
            return res.status(404).json({
                success: false,
                message: "Outlet not found"
            });
        }

        let totalAmount = 0;
        let totalItems = 0;

        outlet.cart.forEach(item => {

            totalItems += item.quantity;

            totalAmount +=
                item.product.price * item.quantity;
        });

        return res.status(200).json({
            message :"cart summary calculated" ,
            success: true,
            totalItems,
            totalAmount,
            cart: outlet.cart
        });

    } catch (error) {

        return res.status(500).json({

            success: false,
            message: error.message
        });
    }
};


export const outletManualOrder = async (req, res) => {
    try {

        const outletId = req.id;

        console.log( "outlet id is:", outletId, "user id is :", req.params.id ) ;
        const user = await Vendor.findById(req.params.id);
        const outlet = await Outlet.findById(outletId)
            .populate("cart.product");

        if (!user) {
            return res.status(404)
                .json({
                    message: "Vendor not found ",
                    success: false
                });
        }

        if (!outlet) {
            return res.status(404).json({
                success: false,
                message: "Outlet not found"
            });
        }

        if (outlet.cart.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Cart is empty"
            });
        }

        const total_qty = outlet.cart.reduce(
            (qty, item) => qty + item.quantity, 0
        );

        // 1. Totals (prices are GST-inclusive; free goods are never billed).
        let totalAmount = 0;
        for (const item of outlet.cart) {
            totalAmount += item.product.price * item.quantity;
        }

        const amountWord = converter.toWords(totalAmount);

        // Order Number
        const orderNo =
            "ORD-" +
            Date.now() +
            "-" +
            Math.floor(Math.random() * 1000);

        // 2. Deduct + create, batch-wise and atomically.
        //
        // This used to check outletStock.quantity and $inc it down directly.
        // It now allocates FEFO across the OUTLET's batches (outletStockBatch),
        // honouring any batches the user pinned on the cart line, and records
        // the exact lots on the order. outletStock.quantity is still the number
        // every existing reader sees — the engine keeps it as the auto-synced
        // total — so nothing downstream changes except that the deduction is
        // now traceable to a batch, transactional and oversell-proof.
        const cartSnapshot = [...outlet.cart];

        // The lots each line actually consumed, keyed by product id — read by
        // the invoice below so it prints the batch that was handed over rather
        // than the product's mirror. Kept beside the cart (not on it) because
        // the cart entries are mongoose subdocuments.
        const allocatedByProduct = new Map();

        let createOrder;
        try {
            createOrder = await withInventoryTxn(async (session) => {
                const orderItems = [];
                // A retry after a transient transaction abort re-runs this
                // callback, so clear anything the previous attempt recorded.
                allocatedByProduct.clear();

                for (const item of outlet.cart) {
                    const allocations = await allocateOutletFEFO(
                        outletId,
                        item.product._id,
                        item.quantity,
                        normalizeAllocations(item.allocations),
                        session
                    );
                    allocatedByProduct.set(String(item.product._id), allocations);

                    orderItems.push({
                        product: item.product._id,
                        quantity: item.quantity,
                        orderPrice: item.product.price,
                        // Free goods carried from the cart line — invoice-only,
                        // the totalAmount above bills `quantity` alone.
                        freeQty: normalizeFreeQty(item.freeQty),
                        // Snapshot the sold batch so the invoice never re-reads
                        // a later one; allocations[0] is the FEFO-front lot.
                        batch_no: allocations[0]?.batch_number ?? item.product.batch_no,
                        exp_date: allocations[0]?.expiry_date ?? item.product.exp_date,
                        allocations,
                    });
                }

                const created = await order.create([{
                    outlet: outletId,

                    orderItems,

                    shippingAddress: {
                        address: outlet.address,
                        city: outlet.city,
                        state: outlet.state,
                        pincode: outlet.pincode,
                        country: "India",
                        phoneNo: outlet.mobileNo
                    },

                    totalAmount,

                    amountWord: `${amountWord} Rupees Only`,

                    paymentMethod: "COD",

                    orderStatus: "Pending",

                    orderType: "Outlet",

                    orderNo
                }], { session });

                return created[0];
            });
        } catch (err) {
            if (err instanceof InsufficientStockError) {
                return res.status(400).json({ success: false, message: err.message });
            }
            throw err;
        }

        // 3. Clear Cart
        outlet.cart = [];
        await outlet.save();

        res.status(201).json({
            success: true,
            message: "Order created successfully",
            createOrder
        });

        let createInvoice = null;

        try {

            const invoiceNumber = `INV-${Date.now()}`;

            const gstSlabs = { 5: 0, 12: 0, 18: 0, 28: 0 };

            for (let i = 0; i < cartSnapshot.length; i++) {

                const gst = Number(cartSnapshot[i].product.gstPercent) || 0;

                const item_price = cartSnapshot[i].product.price;
                const item_qty = cartSnapshot[i].quantity;

                const itemTotal = item_price * item_qty;

                if (gstSlabs[gst] !== undefined) {
                    gstSlabs[gst] += itemTotal - itemTotal / (1 + gst / 100);
                }
            }

            const totalgst =
                gstSlabs[5] + gstSlabs[12] + gstSlabs[18] + gstSlabs[28];


            const invoiceData = {
                shop_name: user.store_name,
                shop_address: user.full_address,
                gst_in: user.gst_no,
                order_no: orderNo,
                order_date: new Date().toLocaleDateString("en-IN", {
                    day: "2-digit",
                    month: "long",
                    year: "numeric"
                }),
                invoice_no: invoiceNumber,
                invoice_date: new Date().toLocaleDateString("en-IN", {
                    day: "2-digit",
                    month: "long",
                    year: "numeric"
                }),
                // One row PER BATCH the line consumed — total_item below stays
                // the LINE count, unchanged.
                items: buildInvoiceItems(
                    cartSnapshot,
                    item => invoiceRow(item.product, {
                        quantity: item.quantity,
                        // FREE GOODS — free units on this line, never priced.
                        freeQty: normalizeFreeQty(item.freeQty),
                        price: item.product.price,
                        amount: item.product.price * item.quantity,
                        // The lot(s) this line consumed — see invoiceBatchNo.
                        batch_no: invoiceBatchNo(
                            allocatedByProduct.get(String(item.product._id)),
                            item.product
                        ),
                        exp_date: invoiceExpDate(
                            allocatedByProduct.get(String(item.product._id)),
                            item.product
                        ),
                    }),
                    item => allocatedByProduct.get(String(item.product._id))
                ),
                total_item: cartSnapshot.length,
                total_qty,
                gross_total: totalAmount,
                round_off: (Math.round(totalAmount) - totalAmount).toFixed(2),


                amount_words: amountWord,
                amount: totalAmount,

                // Keys MUST match the template placeholders read by
                // invoiceTemplate.js ({{gst_5}}, {{gst_total}}, {{total_cgst}},
                // {{total_sgst}}…). CGST and SGST are each half of total GST.
                gst_5: gstSlabs[5].toFixed(2),
                gst_12: gstSlabs[12].toFixed(2),
                gst_18: gstSlabs[18].toFixed(2),
                gst_28: gstSlabs[28].toFixed(2),
                gst_total: totalgst.toFixed(2),
                total_cgst: (totalgst / 2).toFixed(2),
                total_sgst: (totalgst / 2).toFixed(2)


            };

            const html = generateInvoiceHTML(invoiceData);
            const pdfBuffer = await generatePDF(html);

            const result = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { resource_type: "auto", folder: "invoices" },
                    (err, uploaded) => (err ? reject(err) : resolve(uploaded))
                );
                stream.end(pdfBuffer);
            });

            const pdfUrl = result.secure_url;

            const createdInvoice = await Invoice.create({
                invoiceNumber: `INV-${Date.now()}`,
                order: createOrder._id,
                vendor: user._id,
                pdfUrl
            });

            createOrder.invoice = createdInvoice._id;
            await createOrder.save();

            // user.cart = [];
            // await user.save();
            console.log(
                "Invoice generated successfully:",
                createdInvoice._id
            );

        }
        catch (er) {
            console.log(" er from invoice gen outlet order ", er);
        }

    } catch (error) {

        console.log("Outlet Manual Order Error :", error);

        return res.status(500).json({
            success: false,
            message: "Internal Server Error"
        });
    }
};


// -----------------------------------------------------------------------------
// Empties the signed-in outlet's server-side cart. Additive helper for the POS
// Billing flow: the app resets the cart before building a fresh bill so an
// earlier, interrupted bill can never contaminate the next one. Safe no-op when
// the cart is already empty. Does not touch any existing behaviour.
//   POST /vsArogya/outlet/clear-cart
// -----------------------------------------------------------------------------
export const clearOutletCart = async (req, res) => {
    try {
        const outletId = req.id;

        const outlet = await Outlet.findById(outletId);
        if (!outlet) {
            return res.status(404).json({
                success: false,
                message: "Outlet not found"
            });
        }

        outlet.cart = [];
        await outlet.save();

        return res.status(200).json({
            success: true,
            message: "Cart cleared",
            cart: outlet.cart
        });

    } catch (error) {
        console.log("clearOutletCart error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error"
        });
    }
};


// -----------------------------------------------------------------------------
// FEFO batch allocation for POS billing (read-only helpers).
//   GET  /vsArogya/outlet/product/:productId/available-batches
//   POST /vsArogya/outlet/allocate-preview  { productId, quantity, overrides? }
// The backend is the single source of truth: the app calls these to show the
// batch breakdown and validate manual overrides BEFORE the final bill.
// -----------------------------------------------------------------------------

/// The outlet's sellable batches (available > 0, not expired, FEFO order) for a
/// product — powers the manual-override picker.
///
/// `?all=1` (opt-in, additive) widens the SAME endpoint from "what can be sold
/// right now" to "every lot this outlet holds of this medicine" — expired and
/// emptied lots included — and attaches the catalog product plus the outlet's
/// totals, so the Stock → Medicine Details screen needs exactly ONE request.
/// Callers that omit the flag (the billing batch picker, allocate-preview) get
/// the byte-identical response they have always had.
export const getOutletAvailableBatches = async (req, res) => {
    try {
        const outletId = req.id;
        const { productId } = req.params;

        const wantsAll = ["1", "true", "yes", "all"].includes(
            String(req.query.all ?? "").toLowerCase()
        );

        if (wantsAll) {
            const [productDoc, rows, stockRow] = await Promise.all([
                product.findById(productId),
                // Same FEFO order the sellable read uses — nearest expiry first,
                // then oldest lot — so both views agree on what comes next.
                // manufacturing_date is never copied onto an outlet lot, so it
                // is read through the source_batch audit link to the catalog lot.
                OutletStockBatch.find({ outlet: outletId, product: productId })
                    .populate("source_batch", "manufacturing_date")
                    .sort({ expiry_date: 1, createdAt: 1 }),
                outletStock.findOne({ outlet: outletId, product: productId }),
            ]);

            if (!productDoc) {
                return res
                    .status(404)
                    .json({ success: false, message: "Product not found" });
            }

            const batches = rows.map((b) => ({
                _id: b._id,
                batch_number: b.batch_number,
                expiry_date: b.expiry_date,
                manufacturing_date: b.source_batch?.manufacturing_date ?? null,
                available_quantity: b.available_quantity,
                purchase_price: b.purchase_price,
                selling_price: b.selling_price,
                supplier: b.supplier,
                isExpiringSoon: b.isExpiringSoon,
                created_at: b.createdAt,
                updated_at: b.updatedAt,
            }));

            return res.status(200).json({
                success: true,
                product: productDoc,
                // `stock` stays the mirror every existing outlet reader uses;
                // `total_stock` is the live SUM of the lots listed below.
                stock: stockRow?.quantity ?? 0,
                total_stock: batches.reduce(
                    (sum, b) => sum + (Number(b.available_quantity) || 0),
                    0
                ),
                batch_count: batches.length,
                batches,
            });
        }

        const batches = await getSellableOutletBatches(outletId, productId);
        return res.status(200).json({
            success: true,
            batches: batches.map((b) => ({
                _id: b._id,
                batch_number: b.batch_number,
                expiry_date: b.expiry_date,
                available_quantity: b.available_quantity,
                created_at: b.createdAt,
                isExpiringSoon: b.isExpiringSoon,
            })),
        });
    } catch (error) {
        console.log("getOutletAvailableBatches error:", error);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
};

/// Non-mutating FEFO allocation for a requested quantity (respecting any manual
/// overrides). Returns the batch breakdown + remaining + the available batches.
export const outletAllocatePreview = async (req, res) => {
    try {
        const outletId = req.id;
        const { productId, quantity, overrides } = req.body;
        if (!productId) {
            return res.status(400).json({ success: false, message: "productId is required" });
        }
        const { allocations, remaining, availableBatches } =
            await previewOutletAllocation(outletId, productId, quantity, overrides);
        return res.status(200).json({
            success: true,
            allocations,
            remaining,
            availableBatches,
        });
    } catch (error) {
        if (error instanceof InsufficientStockError) {
            return res.status(400).json({ success: false, message: error.message });
        }
        console.log("outletAllocatePreview error:", error);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
};

// -----------------------------------------------------------------------------
// POS BILLING — creates a walk-in counter bill directly from inline line items +
// the customer's details, WITHOUT needing a pre-registered vendor. This lets the
// app place the bill (and generate the invoice) instantly while the customer's
// vendor registration is submitted separately in the background. It deducts
// outlet stock (FEFO across the outlet's batches) and renders the invoice from
// the same HTML template.
// Additive: does not touch outletManualOrder or any existing behaviour.
//   POST /vsArogya/outlet/bill   body: { customer, items: [{ productId, quantity, freeQty?, allocations? }] }
// `freeQty` is the free goods handed over on that line — printed in the
// invoice's FREE GOODS column, never billed. Optional: omitted → 0.
// -----------------------------------------------------------------------------
export const outletBillingOrder = async (req, res) => {
    try {
        const outletId = req.id;
        const { customer, items } = req.body;

        const outlet = await Outlet.findById(outletId);
        if (!outlet) {
            return res.status(404).json({
                success: false,
                message: "Outlet not found"
            });
        }

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No items to bill"
            });
        }

        // 1. Resolve every line + its product/price up front (no mutation yet).
        let totalAmount = 0;
        let total_qty = 0;
        const lineSnapshots = []; // { product doc, quantity, freeQty, allocations? } for the invoice

        for (const it of items) {
            const qty = Number(it.quantity);
            if (!Number.isFinite(qty) || qty <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid quantity in the bill"
                });
            }

            // Free goods are counted separately from the billed quantity: they
            // add nothing to totalAmount, total_qty or the GST slabs below.
            if (it.freeQty !== undefined &&
                (!Number.isFinite(Number(it.freeQty)) || Number(it.freeQty) < 0)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid free goods quantity in the bill"
                });
            }
            const freeQty = normalizeFreeQty(it.freeQty);

            const p = await product.findById(it.productId);
            if (!p) {
                return res.status(404).json({
                    success: false,
                    message: "A billed product no longer exists"
                });
            }

            lineSnapshots.push({ product: p, quantity: qty, freeQty, overrides: it.allocations });
            totalAmount += p.price * qty;
            total_qty += qty;
        }

        const amountWord = converter.toWords(totalAmount);

        const orderNo =
            "ORD-" + Date.now() + "-" + Math.floor(Math.random() * 1000);

        // Bill-to / ship-to: the walk-in customer's details when given, else the
        // outlet's own (so the required shippingAddress fields are always set).
        const c = customer || {};
        const shippingAddress = {
            address: c.address || outlet.address,
            city: c.city || outlet.city,
            state: c.state || outlet.state,
            pincode: c.pincode || outlet.pincode,
            country: "India",
            phoneNo: c.phone || outlet.mobileNo
        };

        // 2. Allocate FEFO across the outlet's batches (honouring any manual
        //    overrides) and create the order — ALL in one transaction. A short
        //    or invalid line rolls the whole bill back, so inventory is never
        //    left partially deducted.
        let createOrder;
        try {
            createOrder = await withInventoryTxn(async (session) => {
                const orderItems = [];
                for (const ln of lineSnapshots) {
                    const allocations = await allocateOutletFEFO(
                        outletId,
                        ln.product._id,
                        ln.quantity,
                        ln.overrides,
                        session
                    );
                    ln.allocations = allocations; // for the invoice below
                    orderItems.push({
                        product: ln.product._id,
                        quantity: ln.quantity,
                        orderPrice: ln.product.price,
                        freeQty: ln.freeQty,
                        batch_no: allocations[0]?.batch_number ?? ln.product.batch_no,
                        exp_date: allocations[0]?.expiry_date ?? ln.product.exp_date,
                        allocations,
                    });
                }

                const created = await order.create([{
                    outlet: outletId,
                    orderItems,
                    shippingAddress,
                    totalAmount,
                    amountWord: `${amountWord} Rupees Only`,
                    paymentMethod: "COD",
                    orderStatus: "Pending",
                    orderType: "Outlet",
                    orderNo
                }], { session });

                return created[0];
            });
        } catch (err) {
            if (err instanceof InsufficientStockError) {
                return res.status(400).json({ success: false, message: err.message });
            }
            throw err;
        }

        // Respond immediately — the invoice renders below without blocking.
        res.status(201).json({
            success: true,
            message: "Bill created successfully",
            createOrder
        });

        // 4. Invoice (best-effort, after the response) billed to the customer.
        try {
            const invoiceNumber = `INV-${Date.now()}`;
            const gstSlabs = { 5: 0, 12: 0, 18: 0, 28: 0 };

            for (let i = 0; i < lineSnapshots.length; i++) {
                const gst = Number(lineSnapshots[i].product.gstPercent) || 0;
                const item_price = lineSnapshots[i].product.price;
                const item_qty = lineSnapshots[i].quantity;
                const itemTotal = item_price * item_qty;
                if (gstSlabs[gst] !== undefined) {
                    gstSlabs[gst] += itemTotal - itemTotal / (1 + gst / 100);
                }
            }

            const totalgst =
                gstSlabs[5] + gstSlabs[12] + gstSlabs[18] + gstSlabs[28];

            const customerName = c.firm || c.name || "Walk-in Customer";
            const customerAddress =
                [c.address, c.city, c.state, c.pincode]
                    .filter(Boolean)
                    .join(", ") || outlet.address || "";

            const invoiceData = {
                shop_name: customerName,
                shop_address: customerAddress,
                gst_in: c.gstin || "N/A",
                order_no: orderNo,
                order_date: new Date().toLocaleDateString("en-IN", {
                    day: "2-digit",
                    month: "long",
                    year: "numeric"
                }),
                invoice_no: invoiceNumber,
                invoice_date: new Date().toLocaleDateString("en-IN", {
                    day: "2-digit",
                    month: "long",
                    year: "numeric"
                }),
                // One row PER BATCH the line consumed — total_item below stays
                // the LINE count, unchanged.
                items: buildInvoiceItems(
                    lineSnapshots,
                    item => invoiceRow(item.product, {
                        quantity: item.quantity,
                        // FREE GOODS — free units on this line, never priced.
                        freeQty: item.freeQty,
                        price: item.product.price,
                        amount: item.product.price * item.quantity,
                        // The lot(s) this line consumed — see invoiceBatchNo.
                        batch_no: invoiceBatchNo(item.allocations, item.product),
                        exp_date: invoiceExpDate(item.allocations, item.product),
                    }),
                    item => item.allocations
                ),
                total_item: lineSnapshots.length,
                total_qty,
                gross_total: totalAmount,
                round_off: (Math.round(totalAmount) - totalAmount).toFixed(2),
                amount_words: amountWord,
                amount: totalAmount,
                gst_5: gstSlabs[5].toFixed(2),
                gst_12: gstSlabs[12].toFixed(2),
                gst_18: gstSlabs[18].toFixed(2),
                gst_28: gstSlabs[28].toFixed(2),
                gst_total: totalgst.toFixed(2),
                total_cgst: (totalgst / 2).toFixed(2),
                total_sgst: (totalgst / 2).toFixed(2)
            };

            const html = generateInvoiceHTML(invoiceData);
            const pdfBuffer = await generatePDF(html);

            const result = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { resource_type: "auto", folder: "invoices" },
                    (err, uploaded) => (err ? reject(err) : resolve(uploaded))
                );
                stream.end(pdfBuffer);
            });

            const createdInvoice = await Invoice.create({
                invoiceNumber,
                order: createOrder._id,
                pdfUrl: result.secure_url
            });

            createOrder.invoice = createdInvoice._id;
            await createOrder.save();

            console.log("Billing invoice generated:", createdInvoice._id);

        } catch (er) {
            console.log("er from POS billing invoice gen:", er);
        }

    } catch (error) {
        console.log("Outlet Billing Order Error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error"
        });
    }
};


export const outletOrderHistory = async (req, res) => {
    try {

        const outletId = req.id;

        const orders = await order.find({
            outlet: outletId
        })
            .populate("orderItems.product", "title price image")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            message :"Fetched all product ",
            success: true,
            totalOrders: orders.length,
            orders
        });

    } catch (error) {

        console.log("Outlet Order History Error:", error);

        return res.status(500).json({
            success: false,
            message: "Internal Server Error"
        });
    }
};


// -----------------------------------------------------------------------------
// The marketing "Select Outlet" screen: list every outlet, or only those in a
// given pincode (?pincode=). Passwords are never included.
//   GET /vsArogya/outlets            → all outlets
//   GET /vsArogya/outlets?pincode=X  → outlets in that pincode
// -----------------------------------------------------------------------------
export const getOutlets = async (req, res) => {
    try {
        const { pincode } = req.query;
        const filter = pincode ? { pincode: String(pincode) } : {};

        const outlets = await Outlet.find(filter)
            .select("-password -cart")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            count: outlets.length,
            outlets
        });

    } catch (error) {
        console.log("getOutlets error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error"
        });
    }
};


// -----------------------------------------------------------------------------
// A single outlet's own profile, read by the signed-in outlet for its Profile
// tab. The outlet id travels in the route (the app scopes on the session's _id).
// Password and cart are never returned.
//   GET /vsArogya/outlet-profile/:id
// -----------------------------------------------------------------------------
export const getOutletProfile = async (req, res) => {
    try {
        const outletId = req.params.id;

        const outlet = await Outlet.findById(outletId).select("-password -cart");

        if (!outlet) {
            return res.status(404).json({
                success: false,
                message: "Outlet not found"
            });
        }

        return res.status(200).json({
            success: true,
            outlet
        });

    } catch (error) {
        console.log("getOutletProfile error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error"
        });
    }
};


// -----------------------------------------------------------------------------
// Orders placed by a specific outlet, newest first. The outlet id travels in the
// route (the app scopes on the signed-in outlet's _id). order.user is the VENDOR
// the order was placed for, so both product and user are populated for display.
//   GET /vsArogya/outlet-orders/:id
// -----------------------------------------------------------------------------
export const getOutletOrders = async (req, res) => {
    try {
        const outletId = req.params.id;

        const orders = await order.find({ outlet: outletId })
            .populate("orderItems.product", "title packInfo price image")
            .populate("user", "store_name contact_person_name mobile_no")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            count: orders.length,
            orders
        });

    } catch (error) {
        console.log("getOutletOrders error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error"
        });
    }
};

// =============================================================================
// Outlet Billing → Vendor registration request (JSON, NO file uploads)
//
// The Outlet Billing (POS) flow used to reuse the multipart /register-vendor
// endpoint, which demanded a store photo + drug-license/GST PDFs. Outlet counters
// only capture the GST + drug-license NUMBERS, so this endpoint accepts a plain
// JSON body — no multer, no Cloudinary — and files a normal PENDING vendor for
// the existing Admin approval workflow (adminController.statusApproval), tagged
// registrationSource:"outlet". After the admin approves, the vendor logs in
// through the unchanged /vsArogya/login (approvalStatus gate + emailed password),
// exactly like an admin-registered vendor.
//
// The billing invoice is generated separately (outletBillingOrder) and never
// depends on this call, so a registration failure never blocks the bill.
// =============================================================================
export const registerOutletVendor = async (req, res) => {
    try {
        const {
            vendor_type,
            shop_type,
            store_name,
            contact_person_name,
            mobile_no,
            email,
            full_address,
            city,
            state,
            pin_code,
            gst_status,
            gst_no,
            drug_lic_no,
            drug_lic_ex_date,
        } = req.body || {};

        // --- Validation (Req 10) — required fields, meaningful messages -------
        const missing = [];
        if (!contact_person_name) missing.push("Vendor Name");
        if (!store_name) missing.push("Firm Name");
        if (!gst_no) missing.push("GST Number");
        if (!drug_lic_no) missing.push("Drug License Number");
        if (!mobile_no) missing.push("Mobile Number");
        if (!email) missing.push("Email");
        if (!full_address) missing.push("Address");
        if (!pin_code) missing.push("PIN Code");
        if (!city) missing.push("City");
        if (!state) missing.push("State");

        if (missing.length) {
            return res.status(400).json({
                success: false,
                message: `Please provide: ${missing.join(", ")}.`,
            });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const normalizedMobile = String(mobile_no).trim();

        // --- Duplicate guards (Req 9 / Req 13 → 409) --------------------------
        const existing = await Vendor.findOne({
            $or: [{ email: normalizedEmail }, { mobile_no: normalizedMobile }],
        });
        if (existing) {
            const dupField =
                existing.email === normalizedEmail ? "email address" : "mobile number";
            return res.status(409).json({
                success: false,
                message: `A vendor with this ${dupField} already exists.`,
            });
        }

        // Credentials are generated now and emailed by the admin on approval —
        // mirrors the existing registerVendor flow so login keeps working.
        const autoPassword = String(Math.floor(1000 + Math.random() * 9000));

        const vendor = await Vendor.create({
            vendor_type,
            shop_type,
            store_name,
            contact_person_name,
            mobile_no: normalizedMobile,
            email: normalizedEmail,
            full_address,
            city,
            state,
            pin_code,
            // Keep the enum valid: a GST number implies a registered vendor.
            gst_status: gst_status === "no" ? "no" : "yes",
            gst_no,
            drug_lic_no,
            drug_lic_ex_date: drug_lic_ex_date || undefined,
            password: autoPassword,
            approvalStatus: "Pending",
            registrationSource: "outlet",
        });

        // Confirmation email — non-fatal, exactly like the other register flows.
        try {
            await sendBrevoEmail({
                to: normalizedEmail,
                toName: contact_person_name,
                subject: "Vendor Registration - VS Arogya",
                htmlContent: `
        <h1>Hi ${contact_person_name}</h1>
        <p>🎉 Your vendor registration has been received at a VS Arogya outlet counter.</p>
        <p>Your application is currently under review.</p>
        <p>We'll notify you via email once the verification process is complete.</p>
        <p>Warm Regards,<br>Team: VS Arogya</p>
        `,
            });
        } catch (mailErr) {
            console.log("registerOutletVendor: email skipped:", mailErr?.message);
        }

        return res.status(201).json({
            success: true,
            message:
                "Registration submitted for admin approval. Login details will be emailed once approved.",
            vendor: {
                _id: vendor._id,
                store_name: vendor.store_name,
                contact_person_name: vendor.contact_person_name,
                mobile_no: vendor.mobile_no,
                email: vendor.email,
                approvalStatus: vendor.approvalStatus,
                registrationSource: vendor.registrationSource,
            },
        });
    } catch (error) {
        console.log("registerOutletVendor error:", error);
        // Mongo duplicate-key safety net (unique index race) → 409, not 500.
        if (error && error.code === 11000) {
            return res.status(409).json({
                success: false,
                message: "A vendor with this email or mobile number already exists.",
            });
        }
        return res.status(500).json({
            success: false,
            message: "Could not submit the registration. Please try again.",
        });
    }
};