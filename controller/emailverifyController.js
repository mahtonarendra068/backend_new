import Eotp from "../model/emailLoginModel.js";
import jwt from "jsonwebtoken";
import Vendor from "../model/userModel.js";
import Outlet from "../model/outletregistersModel.js";
import { sendBrevoEmail } from "../utils/brevoUtils.js";

// How long a mailed code stays usable. Mongo's TTL index on the Eotp document
// is the primary enforcement; this is the exact check so a code can't slip
// through in the window before the TTL sweeper runs.
const OTP_TTL_MS = 10 * 60 * 1000;

// A 6-digit code is only 1,000,000 possibilities — without a cap an attacker
// could simply submit them all. After MAX_OTP_ATTEMPTS wrong tries the code is burned.
const MAX_OTP_ATTEMPTS = 5;

// Any address can now ask for a code, so one address may not be used to burn
// through the Brevo daily quota. Matches the app's 30 s "Resend" timer.
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;

const STAFF_ROLES = ["admin", "marketing", "delivery", "agent", "outlet"];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

/**
 * POST /vsArogya/eotp   { email }
 *
 * Mails a 6-digit login code to ANY valid address. A registered + approved
 * account signs in normally with it; anyone else (no account yet, or a vendor
 * still pending / rejected) gets a browse-only guest session — see
 * verifyOtpAndLogin.
 */
export const sendOtp = async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email required",
            });
        }

        if (!EMAIL_PATTERN.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Enter a valid email address",
            });
        }

        const lastOtp = await Eotp.findOne({ email })
            .sort({ createdAt: -1 })
            .select("createdAt");

        if (lastOtp) {
            const waitMs = OTP_RESEND_COOLDOWN_MS
                - (Date.now() - new Date(lastOtp.createdAt).getTime());

            if (waitMs > 0) {
                return res.status(429).json({
                    success: false,
                    message: `Please wait ${Math.ceil(waitMs / 1000)} seconds before requesting a new OTP.`,
                });
            }
        }

        // Generate six-digit OTP
        const generatedOtp = Math.floor(
            100000 + Math.random() * 900000
        ).toString();

        // Only the newest code is valid
        await Eotp.deleteMany({ email });

        await Eotp.create({
            email,
            otp: generatedOtp,
        });

        await sendBrevoEmail({
            to: email,
            subject: "Login OTP - VS Arogya",
            htmlContent: `
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2>Email Verification</h2>

                    <p>Your verification OTP is:</p>

                    <h1 style="letter-spacing: 5px;">
                        ${generatedOtp}
                    </h1>

                    <p>Your OTP will expire in 10 minutes. Do not share it with anyone.</p>

                    <p>
                        If you did not request this OTP, please ignore this email.
                    </p>
                </div>
            `,
        });

        return res.status(200).json({
            success: true,
            message: "OTP sent in given email.",
        });

    } catch (error) {
        const providerText = error?.response?.text || error?.message || "";

        console.error("Send OTP Error:", error?.status, providerText);

        // The code never reached the inbox, so it must not hold the 30 s
        // resend cooldown against the next attempt.
        const failedEmail = normalizeEmail(req.body?.email);
        if (failedEmail) {
            await Eotp.deleteMany({ email: failedEmail }).catch(() => {});
        }

        // Without a reason every mail failure looks the same from outside the
        // host's logs. None of these reveal anything about the address.
        let reason = "EMAIL_SEND_FAILED";
        if (/missing from environment/i.test(providerText)) {
            reason = "EMAIL_NOT_CONFIGURED";
        } else if (error?.status === 401 || error?.status === 403) {
            reason = "EMAIL_PROVIDER_UNAUTHORIZED";
        } else if (error?.status === 400) {
            reason = "EMAIL_PROVIDER_BAD_REQUEST";
        }

        return res.status(500).json({
            success: false,
            message: "Unable to send OTP. Please try again.",
            reason,
            ...(error?.status ? { providerMessage: String(providerText).slice(0, 300) } : {}),
        });
    }
};

/**
 * Browse-only session for an address with no usable account.
 *
 * The token carries role "guest" and NO account id, and isAuthenticated refuses
 * it on every protected route — so a guest can look at the public catalogue
 * but cannot reach cart, orders, payment or any account data. Nothing is
 * written to the Vendor collection: a guest becomes a vendor only through the
 * normal /register-vendor flow.
 */
const guestLogin = (res, email, vendor) => {
    const token = jwt.sign(
        { role: "guest", email },
        process.env.SECRET_KEY,
        { expiresIn: "1d" }
    );

    // A guest never gets the session cookie; drop any stale one so an earlier
    // account's cookie cannot outlive this sign-in.
    res.clearCookie("token");

    return res.status(200).json({
        message: "Login success",
        success: true,
        role: "guest",
        token,
        id: null,
        email,
        name: vendor?.contact_person_name || vendor?.store_name || "",
        pincode: vendor?.pin_code,
        // The app hides prices and ordering for anything but "Approved", and
        // shows "Register" / "Registration status" from this value.
        approvalStatus: vendor
            ? (vendor.approvalStatus || "Pending")
            : "Not Registered",
    });
};

/**
 * POST /vsArogya/eotp-verify   { email, otp }
 *
 * Verifies the code and signs the account in.
 *
 * For a registered account the reply deliberately mirrors POST
 * /vsArogya/login and POST /vsArogya/outlet-login field for field — `token`,
 * `role`, `id`, `name`, `pincode` (plus `outlet` for an outlet account). The
 * app feeds the body of whichever login it used into the same session/role
 * routing, so any drift here would silently break OTP sign-in for some roles.
 *
 * No account, or a vendor not yet approved → guest session (guestLogin).
 */
export const verifyOtpAndLogin = async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const otp = String(req.body?.otp || "").trim();

        if (!email || !otp) {
            return res.status(400).json({
                success: false,
                message: "Missing field",
            });
        }

        const otpRecord = await Eotp.findOne({ email })
            .sort({ createdAt: -1 });

        if (!otpRecord) {
            return res.status(400).json({
                success: false,
                message: "Invalid OTP",
            });
        }

        if (
            Date.now() - new Date(otpRecord.createdAt).getTime()
            > OTP_TTL_MS
        ) {
            await Eotp.deleteOne({ _id: otpRecord._id });

            return res.status(400).json({
                success: false,
                message: "This OTP has expired. Please request a new one.",
            });
        }

        if (otpRecord.attempts >= MAX_OTP_ATTEMPTS) {
            await Eotp.deleteOne({ _id: otpRecord._id });

            return res.status(429).json({
                success: false,
                message: "Too many incorrect attempts. Please request a new OTP.",
            });
        }

        if (otpRecord.otp !== otp) {
            await Eotp.updateOne(
                { _id: otpRecord._id },
                { $inc: { attempts: 1 } }
            );

            return res.status(400).json({
                success: false,
                message: "Invalid OTP",
            });
        }

        // OTP is single-use
        await Eotp.deleteOne({ _id: otpRecord._id });

        // Outlet account first
        const outlet = await Outlet.findOne({ email });

        if (outlet) {
            const token = jwt.sign(
                { id: outlet._id, role: "outlet" },
                process.env.SECRET_KEY,
                { expiresIn: "7d" }
            );

            res.cookie("token", token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                maxAge: 7 * 24 * 60 * 60 * 1000,
                sameSite: "strict",
            });

            const { password: _pw, ...safeOutlet } =
                outlet.toObject();

            return res.status(200).json({
                message: "Login success",
                success: true,
                role: "outlet",
                token,
                id: outlet._id,
                name: outlet.outletName,
                pincode: outlet.pincode,
                outlet: safeOutlet,
            });
        }

        const user = await Vendor.findOne({ email });

        // No account yet → browse-only until they register
        if (!user) {
            return guestLogin(res, email, null);
        }

        // Same approval policy as POST /login: staff skip it, a vendor must be
        // Approved. Pending / rejected vendors may still browse.
        const role = String(user.role || "").toLowerCase();

        if (
            !STAFF_ROLES.includes(role) &&
            user.approvalStatus !== "Approved"
        ) {
            return guestLogin(res, email, user);
        }

        await Vendor.updateOne(
            { _id: user._id },
            { $set: { lastLogin: new Date() } }
        );

        const token = jwt.sign(
            {
                id: user._id,
                role: user.role || "vendor",
            },
            process.env.SECRET_KEY,
            { expiresIn: "1d" }
        );

        res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            maxAge: 24 * 60 * 60 * 1000,
            sameSite: "strict",
        });

        return res.status(200).json({
            message: "Login success",
            success: true,
            role: user.role,
            token,
            id: user._id,
            pincode: user.pin_code,
            name: user.contact_person_name || user.store_name,
            email: user.email,
            approvalStatus: user.approvalStatus,
            vendor_type: user.vendor_type,
            shop_type: user.shop_type,
        });

    } catch (error) {
        console.error(
            "Verify OTP Error:",
            error?.message
        );

        return res.status(500).json({
            success: false,
            message: "Server error, login failed",
        });
    }
};
