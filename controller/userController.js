import Vendor from "../model/userModel.js";
import cloudinary from "../utils/cloudinary.js";
import getDatauri from "../utils/datauri.js";
import sharp from "sharp";
import multer from "multer";
import jwt from "jsonwebtoken";


import { sendBrevoEmail } from "../utils/brevoUtils.js";


export const registerVendor = async (req, res) => {
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
      drug_lic_no,
      drug_lic_ex_date,
    } = req.body;

    const gst_pdf = req.files?.gst_pdf?.[0];
    const store_pic = req.files?.store_pic?.[0];
    const drug_lic_copy = req.files?.drug_lic_copy?.[0];

    if (
      !store_name ||
      !mobile_no ||
      !email ||
      !vendor_type ||
      !shop_type ||
      !contact_person_name ||
      !full_address ||
      !city ||
      !state ||
      !pin_code ||
      !gst_status ||
      !drug_lic_ex_date ||
      !drug_lic_no
    ) {
      return res.status(400).json({
        success: false,
        message: "Required fields are missing",
      });
    }

    if (!store_pic) {
      return res.status(400).json({
        success: false,
        message: "Store image is required",
      });
    }

    let gstUpload = null;
    let drugUpload = null;

    // Store Image Upload
    const optimizedImage = await sharp(store_pic.buffer)
      .resize({
        width: 800,
        height: 800,
        fit: "inside",
      })
      .jpeg({ quality: 80 })
      .toBuffer();

    const imageUri = `data:image/jpeg;base64,${optimizedImage.toString(
      "base64"
    )}`;

    const storeUpload = await cloudinary.uploader.upload(imageUri, {
      folder: "vendors/store-images",
    });

    // GST PDF Upload
    if (gst_pdf) {
      const gstUri = getDatauri(gst_pdf); // Apne helper function ke hisab se

      gstUpload = await cloudinary.uploader.upload(gstUri, {
        folder: "vendors/gst",
        resource_type: "auto",
      });
    }

    // Drug License PDF Upload
    if (drug_lic_copy) {
      const drugUri = getDatauri(drug_lic_copy); // Apne helper function ke hisab se

      drugUpload = await cloudinary.uploader.upload(drugUri, {
        folder: "vendors/drug-license",
        resource_type: "auto",
      });
    }

    // Auto password generate karein
    const autoPassword = Math.floor(1000 + Math.random() * 9000).toString();

    // Database mein vendor save karein
    const vendor = await Vendor.create({
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
      drug_lic_no,
      drug_lic_ex_date,
      password: autoPassword,

      store_pic: {
        url: storeUpload.secure_url,
        publicId: storeUpload.public_id,
      },

      gst_pdf: {
        url: gstUpload?.secure_url,
        publicId: gstUpload?.public_id,
        fileName: gst_pdf?.originalname,
      },

      drug_lic_copy: {
        url: drugUpload?.secure_url,
        publicId: drugUpload?.public_id,
        fileName: drug_lic_copy?.originalname,
      },
    });

    // Send registration email via Brevo direct SDK
    const brevoResponse = await sendBrevoEmail({
      to: email,
      toName: contact_person_name,
      subject: "Vendor Registration Successful - VS Arogya",
      htmlContent: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; padding: 20px;">
        <h2>Hi ${contact_person_name},</h2>
        <p>🎉 Your vendor registration for <b>${store_name}</b> has been successfully done.</p>
        <p>Your application is currently under review.</p>
  

        <p>We'll notify you via email once the verification process is complete.</p>
        <p>Thank you for being part of our growing network 🚀🎉</p>
        <br>
        <p>Warm Regards,<br><b>Team VS Arogya</b></p>
      </div>
    `,
    });
    console.log("Brevo email response:", brevoResponse);

    return res.status(201).json({
      success: true,
      message: "Registration submitted successfully. Credentials & status sent to your email.",
      pdf_url: gstUpload?.secure_url,
    });

  } catch (error) {
    console.error(
      "Vendor Registration Error:",
      error?.response?.body || error.message
    );

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


export const login = async (req, res) => {

  try {

    const { mobile_no, password } = req.body;

    if (!mobile_no || !password) {

      return res.status(401)
        .json({
          message: "All field are required ",
          success: false
        });
    }

    const user = await Vendor.findOne({ mobile_no });

    if (!user) {
      return res.status(401)
        .json({
          message: "User not found ",
          success: false
        });
    }

    // NEVER log credentials. This line used to print the submitted password AND
    // the stored one on every single login attempt, which put every account's
    // password in the hosting provider's log retention in plaintext.

    if (password !== user.password) {

      return res.status(401)
        .json({
          message: "Credentials are wrong ",

          success: false
        });
    }

    // Buyers/vendors can only log in once an admin approves them. Staff
    // accounts (admin / marketing / delivery) skip this approval gate.
    const staffRoles = ["admin", "marketing", "delivery", "agent", "outlet"];
    if (!staffRoles.includes((user.role || "").toLowerCase()) &&
      user.approvalStatus !== "Approved") {
      const msg = user.approvalStatus === "Rejected"
        ? "Your registration was rejected. Please contact support."
        : "Your account is pending admin approval. You'll get your login details by email once approved.";
      return res.status(403).json({ success: false, message: msg });
    }

    // token genrate — carry the user's REAL role (admin/marketing/delivery/
    // agent/buyer), not a hardcoded "vendor", so role-guarded routes can trust
    // the token.
    const token = jwt.sign(

      {
        id: user._id,
        role: user.role || "vendor"
      },
      process.env.SECRET_KEY,
      { expiresIn: "1d" }
    );


    res.cookie("token", token, {


      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "strict"

    });

    return res.status(201)
      .json({
        message: "Login success ",
        success: true,
        role: user.role,
        token,
        // Additive fields (ignored by roles that don't need them). The Area
        // Agent role scopes its pincode-wise order/vendor calls on these.
        id: user._id,
        pincode: user.pin_code,
        name: user.contact_person_name || user.store_name,
        // Buyer type. The catalogue prices one product three ways
        // (base / drDisPercent / wholesellerPercent) and the app picks the rate
        // card from these two fields, so they have to ride along with the
        // session — there is no "my profile" endpoint to fetch them from.
        vendor_type: user.vendor_type,
        shop_type: user.shop_type,
        email: user.email,
        approvalStatus: user.approvalStatus
      });

  }
  catch (er) {

    console.log(er, "error is :");
    return res.status(500)
      .json({
        message: "Internal server error ",
        success: false
      });
  }
};

export const logout = async (req, res) => {

  try {

    res.cookie("token", "", { maxAge: 0 });

    return res.status(200)
      .json({
        message: "Logout successfuly",
        success: true
      });

  }
  catch (er) {
    console.log(er, "error is :");
  }
}



export const deleteAccount = async (req, res) => {
  try {

    const vendor = await Vendor.findById(req.id);

    const confirm = req.body;

    if (!confirm)
      return res.status(401)
        .json({
          message: "First approved account deletion",
          succes: false
        });
    console.log("vendor is :", vendor);

    if (!vendor)
      return res.status(200)
        .json({

          message: "Vendor not found ",
          success: false
        });

    await Vendor.findByIdAndDelete(req.id);


    return res.status(200)
      .json({
        message: "Account deleted success ",
        succes: true
      });
  }
  catch (er) {

    console.log("error is:", er);

    return res.status(500)
      .json({
        message: "Internal server eroor ",
        success: false
      });
  }
}


// -----------------------------------------------------------------------------
// PASSWORD UPDATE
//
// Serves BOTH app flows, because both end up proving the same thing — that the
// caller controls the account — and then set a new password:
//
//   • Change Password (signed in)  → sends currentPassword, which must match.
//   • Forgot Password (signed out) → the client first proves ownership of the
//     email via POST /eotp + /eotp-verify, which mints a token; it then calls
//     this with that token and NO currentPassword.
//
// Scoped by the JWT (req.id), so an account can only ever change its OWN
// password.
//
// NOTE ON STORAGE: the password is written in plain text because that is how
// every other path in this codebase already treats it — registerVendor saves
// the raw value and login compares with `password !== user.password`. Hashing
// here alone would lock the user out on their next sign-in. Moving the whole
// system to bcrypt is a separate migration (the dependency is already
// installed but unused).
// -----------------------------------------------------------------------------

const MIN_PASSWORD_LENGTH = 6;

export const updatePassword = async (req, res) => {
  try {
    const newPassword = String(req.body?.newPassword || "");
    const currentPassword = req.body?.currentPassword;

    if (!newPassword) {
      return res.status(400).json({
        success: false,
        message: "New password is required",
      });
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }

    const user = await Vendor.findById(req.id).select("password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    // Only enforced when the client supplies it — the forgot-password flow has
    // no current password to send, having already proved ownership by OTP.
    if (currentPassword !== undefined && currentPassword !== null) {
      if (String(currentPassword) !== String(user.password || "")) {
        return res.status(401).json({
          success: false,
          message: "Your current password is incorrect",
        });
      }
    }

    if (String(user.password || "") === newPassword) {
      return res.status(400).json({
        success: false,
        message: "The new password must be different from the current one",
      });
    }

    // updateOne, not save(): a full save would re-validate a document this
    // request never touched, so an older vendor row missing a field could fail
    // a password change that has otherwise succeeded.
    await Vendor.updateOne({ _id: req.id }, { $set: { password: newPassword } });

    return res.status(200).json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (er) {
    console.log("updatePassword error:", er);
    return res.status(500).json({
      success: false,
      message: "Could not update your password",
    });
  }
};

// -----------------------------------------------------------------------------
// ADDRESS BOOK (customer app) — the buyer's saved delivery addresses, stored on
// their own Vendor document. All four are scoped to the token's user; nobody
// can read or edit another account's addresses.
//   GET    /vsArogya/addresses            → { success, addresses }
//   POST   /vsArogya/addresses            → create   (body = address fields)
//   PUT    /vsArogya/addresses/:addressId → update / set default
//   DELETE /vsArogya/addresses/:addressId → remove
// -----------------------------------------------------------------------------

// Keeps at most one default: marking one address default unmarks the rest.
const applyDefault = (vendor, defaultId) => {
  vendor.addresses.forEach((a) => {
    a.isDefault = a._id.toString() === defaultId;
  });
};

export const getAddresses = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.id).select("addresses");
    if (!vendor) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    return res.status(200).json({ success: true, addresses: vendor.addresses });
  } catch (er) {
    console.log("getAddresses error:", er);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const addAddress = async (req, res) => {
  try {
    const { label, fullName, phone, line1, city, state, pincode, isDefault } = req.body;
    if (!line1 || !String(line1).trim()) {
      return res.status(400).json({ success: false, message: "Address line is required" });
    }

    const vendor = await Vendor.findById(req.id);
    if (!vendor) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    vendor.addresses.push({
      label: label || "Home",
      fullName: fullName || "",
      phone: phone || "",
      line1: String(line1).trim(),
      city: city || "",
      state: state || "",
      pincode: pincode || "",
      isDefault: false
    });

    const created = vendor.addresses[vendor.addresses.length - 1];
    // First address (or an explicit request) becomes the default.
    if (isDefault === true || vendor.addresses.length === 1) {
      applyDefault(vendor, created._id.toString());
    }
    await vendor.save();

    return res.status(201).json({
      success: true,
      message: "Address saved",
      address: created,
      addresses: vendor.addresses
    });
  } catch (er) {
    console.log("addAddress error:", er);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const updateAddress = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.id);
    if (!vendor) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const addr = vendor.addresses.id(req.params.addressId);
    if (!addr) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }

    const { label, fullName, phone, line1, city, state, pincode, isDefault } = req.body;
    if (line1 !== undefined) {
      if (!String(line1).trim()) {
        return res.status(400).json({ success: false, message: "Address line is required" });
      }
      addr.line1 = String(line1).trim();
    }
    if (label !== undefined) addr.label = label;
    if (fullName !== undefined) addr.fullName = fullName;
    if (phone !== undefined) addr.phone = phone;
    if (city !== undefined) addr.city = city;
    if (state !== undefined) addr.state = state;
    if (pincode !== undefined) addr.pincode = pincode;
    if (isDefault === true) applyDefault(vendor, addr._id.toString());

    await vendor.save();

    return res.status(200).json({
      success: true,
      message: "Address updated",
      address: addr,
      addresses: vendor.addresses
    });
  } catch (er) {
    console.log("updateAddress error:", er);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const deleteAddress = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.id);
    if (!vendor) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const addr = vendor.addresses.id(req.params.addressId);
    if (!addr) {
      return res.status(404).json({ success: false, message: "Address not found" });
    }

    const wasDefault = addr.isDefault === true;
    addr.deleteOne();
    // Removing the default promotes the first remaining address.
    if (wasDefault && vendor.addresses.length > 0) {
      applyDefault(vendor, vendor.addresses[0]._id.toString());
    }
    await vendor.save();

    return res.status(200).json({
      success: true,
      message: "Address removed",
      addresses: vendor.addresses
    });
  } catch (er) {
    console.log("deleteAddress error:", er);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};
