import SibApiV3Sdk from "sib-api-v3-sdk";

// One place that sends every transactional email (login OTP, vendor
// registration, approval / rejection) through Brevo.
//
// The API client is set up on the first send, not at import: a missing
// BREVO_API_KEY must fail that email call (which every caller catches), not
// crash the whole server at boot.
let apiInstance = null;

const getClient = () => {
    const apiKey = process.env.BREVO_API_KEY;

    if (!apiKey) {
        throw new Error("BREVO_API_KEY is missing from environment variables");
    }

    if (!apiInstance) {
        SibApiV3Sdk.ApiClient.instance.authentications["api-key"].apiKey = apiKey;
        apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    }

    return apiInstance;
};

/**
 * Sends one HTML email. Resolves to Brevo's reply ({ messageId }) and throws
 * if Brevo refuses it — callers decide whether that is fatal.
 */
export const sendBrevoEmail = async ({
    to,
    toName,
    subject,
    htmlContent,
}) => {
    const senderEmail = process.env.BREVO_SENDER_EMAIL;

    if (!senderEmail) {
        throw new Error("BREVO_SENDER_EMAIL is missing from environment variables");
    }

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = htmlContent;
    sendSmtpEmail.sender = {
        name: process.env.BREVO_SENDER_NAME || "VS Arogya",
        email: senderEmail,
    };
    sendSmtpEmail.to = [
        {
            email: to,
            ...(toName ? { name: toName } : {}),
        },
    ];

    return await getClient().sendTransacEmail(sendSmtpEmail);
};
