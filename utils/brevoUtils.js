
import { BrevoClient } from "@getbrevo/brevo";

const apiKey = process.env.BREVO_API_KEY;

if (!apiKey) {
    throw new Error("BREVO_API_KEY is missing from environment variables");
}

const brevoClient = new BrevoClient({ apiKey });

export const sendBrevoEmail = async ({
    to,
    toName,
    subject,
    htmlContent,
}) => {
    return await brevoClient.transactionalEmails.sendTransacEmail({
        sender: {
            name: process.env.BREVO_SENDER_NAME || "VS Arogya",
            email: process.env.BREVO_SENDER_EMAIL,
        },
        to: [
            {
                email: to,
                ...(toName ? { name: toName } : {}),
            },
        ],
        subject,
        htmlContent,
    });
};
