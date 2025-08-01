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

    // Fetch phone from DB instead of hardcoding
    const userSnapshot = await database.ref(`vtu/users/${user.uid}`).get();
    const phone = userSnapshot.exists() ? userSnapshot.val().phone : "08012345678";

    const response = await fetch("https://pluzzpay.com/api/v1/paga-virtual-account.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": process.env.PLUZZYPAY
      },
      body: JSON.stringify({
        email: user.email,
        name: user.displayName,
        phone
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

// PluzzPay Webhook - Handles deposits
app.post("/pluzzpay/webhook", async (req, res) => {
  try {
    console.log("📩 Raw Webhook Payload:", JSON.stringify(req.body, null, 2));

    const { event, data } = req.body;

    if (event === "paga.payment.received" && data) {
      const {
        account_number,
        amount_paid,
        settled_amount,
        transaction_reference,
        timestamp
      } = data;

      // Find user by account_number
      const usersRef = database.ref("vtu/users");
      const snapshot = await usersRef.get();

      let targetUserId = null;
      snapshot.forEach(child => {
        const userData = child.val();
        if (
          userData.accountDetails &&
          userData.accountDetails.accountNumber === account_number
        ) {
          targetUserId = child.key;
        }
      });

      if (!targetUserId) {
        console.warn("⚠️ User not found for account_number:", account_number);
        return res.sendStatus(404);
      }

      const userRef = database.ref(`vtu/users/${targetUserId}`);
      const userSnap = await userRef.get();
      const currentBalance = userSnap.exists() ? userSnap.val().balance || 0 : 0;

      const netAmount = Number(settled_amount);
      const newBalance = Number(currentBalance) + netAmount;

      // Update balance
      await userRef.update({ balance: newBalance });

      // Record transaction
      await database.ref(`vtu/users/${targetUserId}/transactions`).push({
        type: "deposit",
        grossAmount: Number(amount_paid),
        fee: Number(amount_paid) - netAmount,
        netAmount,
        status: "SUCCESS",
        transactionRef: transaction_reference,
        date: new Date(timestamp * 1000).toISOString()
      });

      console.log(
        `✅ Balance updated for user ${targetUserId}: Deposited ₦${amount_paid}, Net ₦${netAmount}`
      );
    } else {
      console.warn("⚠️ Ignored webhook, unexpected event or missing data.");
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Webhook Error:", error);
    res.sendStatus(500);
  }
});

// API endpoint to fetch logged-in user info
app.get("/api/user", async (req, res) => {
  if (!req.session.user) {
    return res.json({ success: false, message: "Not logged in" });
  }
  try {
    const userId = req.session.user.uid;
    const snapshot = await database.ref(`vtu/users/${userId}`).get();
    if (snapshot.exists()) {
      const userData = snapshot.val();
      return res.json({
        success: true,
        user: userData,
        transactions: userData.transactions || {}
      });
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
