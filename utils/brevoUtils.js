
import { BrevoClient } from "@getbrevo/brevo";

// Created on first send, not at import: a missing BREVO_API_KEY must fail the
// email call (which every caller already catches), not crash the whole server
// at boot.
let brevoClient = null;

const getClient = () => {
    const apiKey = process.env.BREVO_API_KEY;

    if (!apiKey) {
        throw new Error("BREVO_API_KEY is missing from environment variables");
    }

    if (!brevoClient) {
        brevoClient = new BrevoClient({ apiKey });
    }

    return brevoClient;
};

export const sendBrevoEmail = async ({
    to,
    toName,
    subject,
    htmlContent,
}) => {
    const senderEmail = process.env.BREVO_SENDER_EMAIL;

                console.log("brevo called  utils") ;


    if (!senderEmail) {
        throw new Error("BREVO_SENDER_EMAIL is missing from environment variables");
    }

    return await getClient().transactionalEmails.sendTransacEmail({
        sender: {
            name: process.env.BREVO_SENDER_NAME || "VS Arogya",
            email: senderEmail,
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
