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
      balance: 2.5,  // Signup bonus
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

      // Apply 2.5% charges
const grossAmount = Number(amount_paid);
const fee = +(grossAmount * 0.025).toFixed(2);
const netAmount = grossAmount - fee;

// Update balance
const newBalance = Number(currentBalance) + netAmount;
await userRef.update({ balance: newBalance });

// Record transaction
await database.ref(`vtu/users/${targetUserId}/transactions`).push({
  type: "deposit",
  grossAmount,
  fee,
  netAmount,
  status: "SUCCESS",
  transactionRef: transaction_reference,
  date: new Date(timestamp * 1000).toISOString()
});

console.log(
  `✅ Balance updated for user ${targetUserId}: Deposited ₦${grossAmount}, Fee ₦${fee}, Net ₦${netAmount}`
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

// ===== WITHDRAWAL ROUTES WITH PLUZZPAY =====

// 1. Get Bank List
app.get("/getBanks", async (req, res) => {
  try {
    const response = await fetch("https://pluzzpay.com/api/v1/bank-transfer.php?action=getBanks", {
      method: "GET",
      headers: {
        "X-API-KEY": process.env.PLUZZPAY
      }
    });

    const result = await response.json();
    if (result.status) {
      res.json({ success: true, banks: result.data.banks });
    } else {
      res.json({ success: false, message: result.message });
    }
  } catch (error) {
    console.error("Get Banks Error:", error);
    res.json({ success: false, message: "Failed to load banks" });
  }
});

// 2. Account Lookup
app.post("/lookupAccount", async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;
    const response = await fetch("https://pluzzpay.com/api/v1/bank-transfer.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": process.env.PLUZZPAY
      },
      body: JSON.stringify({
        action: "lookup",
        accountNumber,
        bankCode
      })
    });

    const result = await response.json();
    if (result.status) {
      res.json({ success: true, accountName: result.data.accountName });
    } else {
      res.json({ success: false, message: result.message });
    }
  } catch (error) {
    console.error("Account Lookup Error:", error);
    res.json({ success: false, message: "Lookup failed" });
  }
});

// 3. Withdraw Funds (Send Bank Transfer)
app.post("/withdraw", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.json({ success: false, message: "Not logged in" });

    const { accountNumber, bankCode, amount } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (!accountNumber || !bankCode || isNaN(withdrawAmount) || withdrawAmount < 500) {
      return res.json({ success: false, message: "Invalid withdrawal details" });
    }

    // Fetch user balance
    const userRef = database.ref(`vtu/users/${user.uid}`);
    const snapshot = await userRef.get();
    if (!snapshot.exists()) return res.json({ success: false, message: "User not found" });

    const userData = snapshot.val();
    const currentBalance = userData.balance || 0;

    if (withdrawAmount > currentBalance) {
      return res.json({ success: false, message: "Insufficient balance" });
    }

    // Apply 4.5% service charge
    const fee = +(withdrawAmount * 0.045).toFixed(2);
    const net = +(withdrawAmount - fee).toFixed(2);

    // Send withdrawal request to PluzzPay
    const response = await fetch("https://pluzzpay.com/api/v1/bank-transfer.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": process.env.PLUZZPAY
      },
      body: JSON.stringify({
        action: "transfer",
        accountNumber,
        bankCode,
        amount: net,
        narration: "IA Cafe Withdrawal"
      })
    });

    const result = await response.json();

    if (!result.status) {
      return res.json({ success: false, message: result.message });
    }

    // Deduct full amount (gross) from balance
    const newBalance = +(currentBalance - withdrawAmount).toFixed(2);
    await userRef.update({ balance: newBalance });

    // Record withdrawal in DB
    await database.ref(`vtu/users/${user.uid}/withdrawals`).push({
      amount: withdrawAmount,
      fee,
      net,
      accountNumber,
      bankCode,
      bankName: result.data.bankName,
      accountName: result.data.accountName,
      transactionId: result.data.transactionId,
      reference: result.data.reference,
      status: result.data.status || "PENDING",
      date: new Date().toISOString()
    });

    return res.json({
      success: true,
      message: "Withdrawal initiated successfully!",
      transaction: result.data
    });
  } catch (error) {
    console.error("Withdrawal Error:", error);
    res.json({ success: false, message: "Internal Server Error" });
  }
});

// 4. Get Withdrawal History
app.get("/getWithdrawals", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.json({ success: false, withdrawals: [] });

    const snapshot = await database.ref(`vtu/users/${user.uid}/withdrawals`).get();
    if (!snapshot.exists()) return res.json({ success: true, withdrawals: [] });

    const withdrawals = Object.values(snapshot.val());
    res.json({ success: true, withdrawals });
  } catch (error) {
    console.error("Get Withdrawals Error:", error);
    res.json({ success: false, withdrawals: [] });
  }
});

// Airtime Page Route (Protected)


// Airtime Page Route (Protected)
app.get("/airtime", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/?error=Please login first");
  }
  res.sendFile(path.join(__dirname, "public", "airtime.html"));
});

// Airtime Purchase Route
app.post("/airtime", async (req, res) => {
  try {
    const { serviceID, amount, mobileNumber } = req.body;
    const userId = req.session.user.uid;

    // Fetch user balance
    const userRef = database.ref(`vtu/users/${userId}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists()) {
      return res.json({ success: false, message: "User not found" });
    }

    let userData = userSnap.val();
    let currentBalance = Number(userData.balance || 0);

    // Apply 0.5% discount
    const discountedAmount = (Number(amount) * 0.995).toFixed(2);

    if (currentBalance < discountedAmount) {
      return res.json({ success: false, message: "Insufficient balance" });
    }

    // Call VTU API
    const response = await fetch("https://jossyfeydataservices.com.ng/api/airtime", {
      method: "POST",
      headers: {
        "Authorization": `Token ${process.env.DATAVTU_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        serviceID,
        amount: discountedAmount,
        mobileNumber
      })
    });

    const result = await response.json();

    if (result.status === "success") {
      // Deduct balance
      const newBalance = currentBalance - discountedAmount;
      await userRef.update({ balance: newBalance });

      // Save transaction
      await database.ref(`vtu/users/${userId}/transactions`).push({
        type: "airtime",
        phone: mobileNumber,
        network: result.data.network,
        amount: result.data.amount,
        charged: discountedAmount,
        reference: result.data.reference,
        status: result.data.status,
        date: new Date().toISOString()
      });

      return res.json({
        success: true,
        message: result.message,
        data: result.data,
        balance: newBalance
      });
    } else {
      return res.json({ success: false, message: result.message });
    }

  } catch (error) {
    console.error("Airtime Purchase Error:", error);
    return res.json({ success: false, message: "Internal Server Error" });
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

