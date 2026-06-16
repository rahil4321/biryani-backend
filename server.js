const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const port = process.env.PORT || 3000;

// Security & Environment Variables
const JWT_SECRET = process.env.JWT_SECRET || 'development_secret_key_123';
const BREVO_API_KEY = process.env.BREVO_API_KEY; 
const EMAIL_USER = process.env.EMAIL_USER; // Your login email on Brevo
const MOM_EMAIL = process.env.MOM_EMAIL;   // Where order alerts go

// Middleware
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

// Initialize Database
let db = new sqlite3.Database('./biryani_orders.sqlite', (err) => {
    if (err) return console.error(err.message);
    console.log('Connected to the SQLite file database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        status TEXT DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        phone_number TEXT NOT NULL,
        status TEXT DEFAULT 'New',
        current_otp TEXT,
        otp_expiry DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    )`);

    db.get("SELECT * FROM admins WHERE username = 'admin'", (err, row) => {
        if (!row) {
            const hashedPassword = bcrypt.hashSync('securepassword123', 10);
            db.run(`INSERT INTO admins (username, password) VALUES ('admin', ?)`, [hashedPassword]);
        }
    });
});

// JWT Verification Middleware
const verifyAdminToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access Denied' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid Token' });
        req.user = user;
        next();
    });
};

// Helper function to send email via Brevo HTTPS API (Bypasses Render Firewall)
async function sendCloudEmail(toEmail, subject, htmlContent) {
    if (!BREVO_API_KEY || !EMAIL_USER) {
        console.error("Missing Brevo API configuration variables.");
        return;
    }
    try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': BREVO_API_KEY,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sender: { name: "Biryani Co.", email: EMAIL_USER },
                to: [{ email: toEmail }],
                subject: subject,
                htmlContent: htmlContent
            })
        });
    } catch (err) {
        console.error("Failed to route email via cloud API:", err);
    }
}

// --- API ROUTES ---

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM admins WHERE username = ?", [username], (err, admin) => {
        if (err || !admin) return res.status(401).json({ error: 'Invalid credentials' });
        if (!bcrypt.compareSync(password, admin.password)) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ id: admin.id, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token });
    });
});

app.post('/auth/request-otp', (req, res) => {
    const { email, phone_number } = req.body;
    if (!email || !phone_number) return res.status(400).json({ error: 'Data required' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60000).toISOString();

    db.run(
        `INSERT INTO users (email, phone_number, current_otp, otp_expiry) VALUES (?, ?, ?, ?) 
         ON CONFLICT(email) DO UPDATE SET current_otp = ?, otp_expiry = ?`,
        [email, phone_number, otp, expiry, otp, expiry],
        async function(err) {
            if (err) return res.status(500).json({ error: err.message });

            await sendCloudEmail(
                email, 
                'Your Biryani Co. Login OTP', 
                `<div style="font-family:sans-serif;padding:20px;border:1px solid #f3f4f6;border-radius:16px;">
                    <h2 style="color:#d97706;">Verification Code</h2>
                    <p>Your authentication code is:</p>
                    <div style="font-size:32px;font-weight:bold;letter-spacing:4px;color:#111827;margin:20px 0;">${otp}</div>
                    <p style="color:#6b7280;font-size:12px;">Expires in 10 minutes.</p>
                 </div>`
            );
            res.json({ message: 'OTP processed' });
        }
    );
});

app.post('/auth/verify-otp', (req, res) => {
    const { email, otp } = req.body;
    db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
        if (err || !user) return res.status(444).json({ error: 'User not found' });
        
        if (user.current_otp === otp && new Date() < new Date(user.otp_expiry)) {
            db.run("UPDATE users SET status = 'Validated', current_otp = NULL WHERE email = ?", [email]);
            const token = jwt.sign({ id: user.id, role: 'customer' }, JWT_SECRET, { expiresIn: '7d' });
            res.json({ token });
        } else {
            res.status(401).json({ error: 'Invalid code' });
        }
    });
});

app.post('/orders', (req, res) => {
    const { customer_name, phone_number, quantity } = req.body;
    if (!customer_name || !phone_number || !quantity) return res.status(400).json({ error: 'Invalid data' });

    db.run(
        `INSERT INTO orders (customer_name, phone_number, quantity) VALUES (?, ?, ?)`,
        [customer_name, phone_number, quantity],
        async function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            const orderId = this.lastID;
            if (MOM_EMAIL) {
                await sendCloudEmail(
                    MOM_EMAIL,
                    `🚨 NEW ORDER RECEIVED (#${orderId})`,
                    `<div style="font-family:sans-serif;padding:20px;background-color:#fffbeb;border:2px solid #f59e0b;border-radius:24px;">
                        <h2 style="color:#b45309;margin-top:0;">Kitchen Alert!</h2>
                        <p><strong>Customer:</strong> ${customer_name}</p>
                        <p><strong>Contact:</strong> ${phone_number}</p>
                        <p><strong>Quantity:</strong> <span style="font-size:20px;font-weight:900;color:#d97706;">${quantity} Plates</span></p>
                        <p><strong>Revenue:</strong> ₹${quantity * 150}</p>
                     </div>`
                );
            }
            res.json({ id: orderId });
        }
    );
});

app.get('/orders', verifyAdminToken, (req, res) => {
    db.all('SELECT * FROM orders ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.put('/orders/:id/status', verifyAdminToken, (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    db.run(`UPDATE orders SET status = ? WHERE id = ?`, [status, id], () => {
        res.json({ success: true });
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
});
