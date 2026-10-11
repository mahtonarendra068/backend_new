import * as brevo from "@getbrevo/brevo";

let apiInstance = null;

const getClient = () => {
    const apiKey = process.env.BREVO_API_KEY;

    if (!apiKey) {
        throw new Error("BREVO_API_KEY is missing from environment variables");
    }

    // Lazy initialization using Brevo's official TransactionalEmailsApi
    if (!apiInstance) {
        apiInstance = new brevo.TransactionalEmailsApi();
        apiInstance.setApiKey(
            brevo.TransactionalEmailsApiApiKeys.apiKey,
            apiKey
        );
    }

    return apiInstance;
};

export const sendBrevoEmail = async ({
    to,
    toName,
    subject,
    htmlContent,
}) => {
    const senderEmail = process.env.BREVO_SENDER_EMAIL;

    console.log("Brevo email called from utils"); // Debugging

    if (!senderEmail) {
        throw new Error("BREVO_SENDER_EMAIL is missing from environment variables");
    }

    // Create the email object format expected by Brevo
    const sendSmtpEmail = new brevo.SendSmtpEmail();
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

    // Send the email
    return getClient().sendTransacEmail(sendSmtpEmail);
};