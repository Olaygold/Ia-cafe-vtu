require("dotenv").config();
const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const { admin, database } = require("./fire");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
    secret: "IA_CAFE_SECRET_KEY",
    resave: false,
    saveUninitialized: true
}));

// Serve login, register & terms pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(__dirname, "public", "register.html")));
app.get("/terms", (req, res) => res.sendFile(path.join(__dirname, "public", "terms.html")));

// Handle registration
app.post("/register", async (req, res) => {
    try {
        const { fullName, email, password, phone } = req.body;
        const userRecord = await admin.auth().createUser({
            email,
            password,
            displayName: fullName
        });

        // Store user info under vtu path in realtime DB
        await database.ref(`vtu/users/${userRecord.uid}`).set({
            fullName,
            email,
            phone,
            balance: 500,  // Signup bonus
            createdAt: new Date().toISOString()
        });

        res.redirect("/?success=registered");
    } catch (error) {
        console.error("Registration Error:", error);
        res.redirect("/register?error=" + encodeURIComponent(error.message));
    }
});

// Handle login
app.post("/login", async (req, res) => {
    try {
        const { email } = req.body;
        const user = await admin.auth().getUserByEmail(email);

        // In production you should use Firebase Auth client SDK for password validation
        // Here we just check if the account exists
        req.session.user = user.toJSON();
        res.redirect("/dashboard");
    } catch (error) {
        console.error("Login Error:", error);
        res.redirect("/?error=" + encodeURIComponent(error.message));
    }
});

// Dashboard route
app.get("/dashboard", async (req, res) => {
    if (!req.session.user) {
        return res.redirect("/");
    }
    res.send(`<h1>Welcome ${req.session.user.displayName} to IA Cafe!</h1>
              <p>Your email: ${req.session.user.email}</p>
              <a href="/logout">Logout</a>`);
});

// Logout
app.get("/logout", (req, res) => {
    req.session.destroy();
    res.redirect("/");
});

app.listen(PORT, () => console.log(`IA Cafe running on port ${PORT}`));