const admin = require("firebase-admin");

// Parse and fix escaped newlines in private_key
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

// Fix the private key string: replace literal '\n' with actual newlines
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ride-35267-default-rtdb.firebaseio.com",
});

const database = admin.database();

module.exports = { admin, database };
