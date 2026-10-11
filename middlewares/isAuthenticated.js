import jwt from "jsonwebtoken";

const isAuthenticated = async (req, res, next) => {
    try {

        // Accept the JWT from the cookie (set by login) OR the
        // Authorization: Bearer header. The cookie is httpOnly + sameSite
        // strict, so it never reaches the server from the web build — the
        // Bearer header is the app's working path and must stay supported.
        const bearer = req.headers.authorization;
        const token = req.cookies.token ||
            (bearer && bearer.startsWith("Bearer ") ? bearer.split(" ")[1] : null);

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Please login first"
            });
        }

        const decode = jwt.verify(
            token,
            process.env.SECRET_KEY
        );

        // An email-OTP guest (no registered + approved account) may browse the
        // public catalogue only. Its token has no account id, so nothing behind
        // a login — cart, orders, payment, profile — is open to it.
        if (decode.role === "guest") {
            return res.status(403).json({
                success: false,
                message: "Please register as a vendor and get approved to continue."
            });
        }

        // login() signs { userId }, outlet_login() signs { outletId } — neither
        // signs `id`, so reading decode.id alone leaves req.id undefined and
        // breaks every route that scopes by it (cart, orders, payment, invoice).
         req.id = decode.id;
        req.role = decode.role;
        next();

    } catch (error) {
        console.log(error);

        return res.status(401).json({
            success: false,
            message: "Invalid token"
        });
    }
};

export default isAuthenticated;