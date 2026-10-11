import Eotp from "../model/emailLoginModel.js";
import Vendor from "../model/userModel.js";
// import { BrevoClient } from "@getbrevo/brevo";
import SibApiV3Sdk from 'sib-api-v3-sdk';
import dotenv from 'dotenv';

dotenv.config();

// Brevo Client Configuration
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// In-memory storage (Production mein Redis ya Database use karein)
export const otpStorage = {};


export const sendOtp = async (req, res) => {
  try {
    const { email } = req.body;

    console.log("email is", email);

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email address is required.' });
    }

    // 1. 6-digit random OTP generate karein
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes expiry

    // 2. Database me email aur OTP save (ya update) karein
    // Agar pehle se email hoga toh naya OTP overwrite ho jayega, nahi toh naya row ban jayega.
    await Eotp.findOneAndUpdate(
      { email },
      { otp, expiresAt },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 3. Email parameters setup karein
    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    
    sendSmtpEmail.sender = { 
      email: process.env.SENDER_EMAIL, 
      name: process.env.SENDER_NAME 
    };
    sendSmtpEmail.to = [{ email: email }];
    sendSmtpEmail.subject = 'Your Verification OTP Code -VS Arogya';
    sendSmtpEmail.htmlContent = `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Email Verification</h2>
        <p>Your One-Time Password (OTP) for verification is:</p>
        <h1 style="color: #4F46E5; letter-spacing: 2px;">${otp}</h1>
        <p>This OTP is valid for 5 minutes. Do not share it with anyone.</p>
      </div>
    `;

    // 4. Brevo API ke through email bhejein
    await apiInstance.sendTransacEmail(sendSmtpEmail);

    return res.status(200).json({
      success: true,
      message: 'OTP sent successfully to your email and saved in DB.'
    });

  } catch (error) {
    console.error('Error sending email via Brevo:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send OTP. Please try again later.',
      error: error.message
    });
  }
};
// import Eotp from '../models/eotpModel.js';
// import Vendor from '../models/vendorModel.js';

export const verifyOtpAndLogin = async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ success: false, message: 'Missing fields' });
        }

        // Database me OTP check karein
        const otpRecord = await Eotp.findOne({ email, otp });

        if (!otpRecord) {
            return res.status(400).json({ success: false, message: 'Invalid OTP' });
        }

        // Optional Expiry Check (Agar aapne schema me TTL index nahi lagaya hai)
        const isExpired = Date.now() - new Date(otpRecord.createdAt).getTime() > 5 * 60 * 1000;
        if (isExpired) {
            await Eotp.deleteOne({ _id: otpRecord._id });
            return res.status(400).json({ success: false, message: 'OTP has expired' });
        }

        // Verification ke baad OTP ko immediately delete kar dein
        await Eotp.deleteOne({ _id: otpRecord._id });

        // Check karein user DB me pehle se hai ya naya hai
        let user = await Vendor.findOne({ email });

        if (!user) {
            user = await Vendor.create({ email });
        } else {
            user.lastLogin = Date.now();
            await user.save();
        }

        return res.status(200).json({
            success: true,
            message: 'Login successful!',
            user: {
                id: user._id,
                email: user.email,
                lastLogin: user.lastLogin,
            },
        });
    } catch (error) {
        console.error('Verify OTP Error:', error);
        return res.status(500).json({ success: false, message: 'Server error, login failed' });
    }
};