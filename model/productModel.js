import mongoose from "mongoose";

const productSchema = new mongoose.Schema({

    title:{
        type: String ,
        required : true ,
        trim : true 
    } ,
    description : {
        type : String ,
        default : ""
    },
    price :{
        type : Number ,
        required : true 
    },
    category :{
        type : String ,
        required : true,
        // enum:[ "", "" , ""]
    },
    cold_stored :{
        type :String
    },

    // --- Inventory / display fields (managed by the marketing team) ---
    
    batch_no:String ,
    exp_date :Date,
    mrp: { type: Number },
    brand: { type: String, default: "" },
    code: { type: String, default: "" },
    manufacturer: { type: String, default: "" },
    marketedBy: { type: String, default: "" },
    stock: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    packOf: { type: Number, default: 1 },
    hsnCode: { type: String, default: "" },
    gstPercent: { type: Number, default: 0 },
    discountPercent: { type: Number, default: 0 },
    lowThreshold: { type: Number, default: 10 },
    prescriptionRequired: { type: Boolean, default: false },
    rating: { type: Number, default: 4.5 },
    reviewCount: { type: Number, default: 0 },
    badge: { type: String },
    packInfo: { type: String, default: "" },
    // Product images. Historically a single-element array; now holds up to
    // kMaxProductImages entries (see controller). Kept as `image` — NOT renamed
    // to `images` — so every existing consumer (customer/admin/outlet/vendor)
    // that already reads `image[0].url` keeps working with no migration. The
    // FIRST entry is treated as the primary/thumbnail image everywhere.
    image:[
        {
            url : String ,
            publicId : String
        }
    ],
    // Optional single promotional video (Cloudinary, resource_type "video").
    // `publicId` is stored so the video can be deleted/replaced without leaving
    // an orphan asset behind.
    video: {
        url: { type: String },
        publicId: { type: String },
    },
    quantity:{
        type : String ,
        default :"1"
    },
 drDisPercent : {
        type : String
    },
    wholesellerPercent :{
        type : String
    },

    // --- Medicine information (display only) ---------------------------------
    // Shown on the product details screen under the name and company. Every
    // field is optional and defaults to empty, so products that predate them
    // need no migration — the app simply hides an empty section. None of these
    // affect price, stock or ordering. Normalised by utils/medicineInfo.js.
    composition: { type: String, default: "", trim: true },   // salt + strength
    uses:        { type: String, default: "", trim: true },   // "Use of Product"
    storage:     { type: String, default: "", trim: true },   // e.g. "Store 2–8°C"
    precautions: { type: String, default: "", trim: true },
    directions:  { type: String, default: "", trim: true },   // "Usage Direction"
    // A LIST, one entry per side effect — the app renders it as bullets.
    sideEffects: { type: [String], default: [] },
} ,{timestamps: true} ) ;

// --- Live expiry flag (Feature 2/4) --------------------------------------
// Computed on EVERY serialization from the CURRENT server date, so it stays
// accurate on its own — no cron, no timer, no DB write. True when the product
// carries an expiry date that is within the next 90 days (or already past).
// Only the Marketing & Outlet UIs render a warning from it; every other role
// simply ignores the field, so it is safe to expose everywhere.
productSchema.virtual("isExpiringSoon").get(function () {
    if (!this.exp_date) return false;
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysLeft = Math.ceil(
        (new Date(this.exp_date).getTime() - Date.now()) / msPerDay
    );
    return daysLeft <= 90;
});

// Emit virtuals so `isExpiringSoon` rides along in every product response
// (getAllProducts, populated order/outlet products, …) with no per-controller
// change. Only ADDS fields (isExpiringSoon + the default `id`) — existing
// consumers that read `_id`/`image`/… are unaffected.
productSchema.set("toJSON", { virtuals: true });
productSchema.set("toObject", { virtuals: true });

const product = mongoose.model('product' , productSchema ) ;

export default product ;



// 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