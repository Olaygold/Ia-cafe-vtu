require("dotenv").config();
const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const fetch = require("node-fetch"); // required for API calls
const { admin, database } = require("./fire");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(bodyParser.json()); // For webhooks
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
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// Generate PluzzPay Virtual Account
app.post("/generate-account", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.json({ success: false, message: "Not logged in" });

    const response = await fetch("https://pluzzpay.com/api/v1/paga-virtual-account.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": process.env.PLUZZYPAY
      },
      body: JSON.stringify({
        email: user.email,
        name: user.displayName,
        phone: "08012345678" // ideally from DB
      })
    });

    const result = await response.json();

    if (result.status) {
      await database.ref(`vtu/users/${user.uid}/accountDetails`).set({
        bank: result.data.bank_name,
        accountNumber: result.data.account_number,
        accountName: result.data.account_name,
        accountReference: result.data.account_reference
      });
      return res.json({ success: true, message: result.message });
    } else {
      return res.json({ success: false, message: result.message });
    }
  } catch (error) {
    console.error("Generate Account Error:", error);
    return res.json({ success: false, message: "Internal Server Error" });
  }
});

// PluzzPay Webhook - Handles deposits with 2.5% fee deduction
app.post("/pluzzpay/webhook", async (req, res) => {
  try {
    console.log("📩 PluzzPay Webhook:", req.body);

    const { account_reference, amount, status } = req.body;

    if (status === "SUCCESS") {
      // Match the account_reference with user
      const usersRef = database.ref("vtu/users");
      const snapshot = await usersRef.get();

      let targetUserId = null;
      snapshot.forEach(child => {
        const userData = child.val();
        if (userData.accountDetails && userData.accountDetails.accountReference === account_reference) {
          targetUserId = child.key;
        }
      });

      if (!targetUserId) {
        console.warn("⚠️ User not found for account_reference:", account_reference);
        return res.sendStatus(404);
      }

      const userRef = database.ref(`vtu/users/${targetUserId}`);
      const userSnap = await userRef.get();
      const currentBalance = userSnap.exists() ? userSnap.val().balance || 0 : 0;

      // Deduct 2.5% fee
      const fee = Number(amount) * 0.025;
      const netAmount = Number(amount) - fee;
      const newBalance = Number(currentBalance) + netAmount;

      // Update user balance
      await userRef.update({ balance: newBalance });

      // Save transaction record
      await database.ref(`vtu/users/${targetUserId}/transactions`).push({
        type: "deposit",
        grossAmount: Number(amount),
        fee,
        netAmount,
        status: "SUCCESS",
        date: new Date().toISOString()
      });

      console.log(`✅ Balance updated for user ${targetUserId}: Deposited ₦${amount}, Fee ₦${fee}, Net ₦${netAmount}`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook Error:", error);
    res.sendStatus(500);
  }
});

// API endpoint to fetch logged-in user info
app.get("/api/user", async (req, res) => {
  if (!req.session.user) {
    return res.json({ success: false });
  }
  try {
    const userRef = database.ref(`vtu/users/${req.session.user.uid}`);
    const snapshot = await userRef.get();

    if (!snapshot.exists()) {
      return res.json({ success: false, message: "User not found" });
    }

    return res.json({ success: true, user: snapshot.val() });
  } catch (error) {
    console.error("API User Error:", error);
    return res.json({ success: false, message: "Internal Server Error" });
  }
});

// Serve logged-in user data
app.get("/api/user", async (req, res) => {
  if (!req.session.user) {
    return res.json({ success: false, message: "Not logged in" });
  }
  try {
    const userId = req.session.user.uid;
    const snapshot = await database.ref(`vtu/users/${userId}`).get();
    if (snapshot.exists()) {
      return res.json({ success: true, user: snapshot.val() });
    } else {
      return res.json({ success: false, message: "User not found" });
    }
  } catch (error) {
    console.error("User API Error:", error);
    return res.json({ success: false, message: "Internal Server Error" });
  }
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

app.listen(PORT, () => console.log(`IA Cafe running on port ${PORT}`));
