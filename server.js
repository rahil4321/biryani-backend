const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

// Security & Environment Variables
const JWT_SECRET = process.env.JWT_SECRET || 'development_secret_key_123';
const EMAIL_USER = process.env.EMAIL_USER; // e.g., your.email@gmail.com
const EMAIL_PASS = process.env.EMAIL_PASS; // 16-digit Gmail App Password
const MOM_EMAIL = process.env.MOM_EMAIL;   // Where orders are sent

// Configure Nodemailer (Email System)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
    }
});

// Middleware
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

// Initialize Database
let db = new sqlite3.Database('./biryani_orders.sqlite', (err) => {
    if (err) return console.error(err.message);
    console.log('Connected to the SQLite file database.');
});

db.serialize(() => {
    // 1. Orders Table
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        status TEXT DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 2. Users Table (For OTP & Validation)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        phone_number TEXT NOT NULL,
        status TEXT DEFAULT 'New',
        current_otp TEXT,
        otp_expiry DATETIME
    )`);

    // 3. Admin Table (Secure Authentication)
    db.run(`CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    )`);

    // Auto-Create Default Admin if none exists
    db.get("SELECT * FROM admins WHERE username = 'admin'", (err, row) => {
        if (!row) {
            const hashedPassword = bcrypt.hashSync('securepassword123', 10);
            db.run(`INSERT INTO admins (username, password) VALUES ('admin', ?)`, [hashedPassword]);
            console.log('Default Admin created. Username: admin');
        }
    });
});

// --- JWT VERIFICATION MIDDLEWARE ---
const verifyAdminToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Access Denied: No Token Provided!' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or Expired Token' });
        req.user = user;
        next();
    });
};

// --- ROUTES ---

// 1. ADMIN LOGIN (Generates JWT)
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;

    db.get("SELECT * FROM admins WHERE username = ?", [username], (err, admin) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

        const validPassword = bcrypt.compareSync(password, admin.password);
        if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ id: admin.id, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ message: 'Login successful', token });
    });
});

// 2. USER OTP REQUEST
app.post('/auth/request-otp', (req, res) => {
    const { email, phone_number } = req.body;
    if (!email || !phone_number) return res.status(400).json({ error: 'Email and phone required' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
    const expiry = new Date(Date.now() + 10 * 60000).toISOString(); // 10 mins expiry

    // Insert or update user
    db.run(
        `INSERT INTO users (email, phone_number, current_otp, otp_expiry) VALUES (?, ?, ?, ?) 
         ON CONFLICT(email) DO UPDATE SET current_otp = ?, otp_expiry = ?`,
        [email, phone_number, otp, expiry, otp, expiry],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });

            // Send OTP via Email
            const mailOptions = {
                from: EMAIL_USER,
                to: email,
                subject: 'Your Biryani Co. Login OTP',
                text: `Your verification code is: ${otp}. It expires in 10 minutes.`
            };

            transporter.sendMail(mailOptions, (error) => {
                if (error) console.error('Error sending OTP:', error);
                res.json({ message: 'OTP sent to email successfully' });
            });
        }
    );
});

// 3. USER OTP VERIFICATION
app.post('/auth/verify-otp', (req, res) => {
    const { email, otp } = req.body;

    db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        
        if (user.current_otp === otp && new Date() < new Date(user.otp_expiry)) {
            // Update status to Validated
            db.run("UPDATE users SET status = 'Validated', current_otp = NULL WHERE email = ?", [email]);
            
            // Issue Customer JWT
            const token = jwt.sign({ id: user.id, role: 'customer' }, JWT_SECRET, { expiresIn: '7d' });
            res.json({ message: 'Validation successful', token });
        } else {
            res.status(401).json({ error: 'Invalid or expired OTP' });
        }
    });
});

// 4. SUBMIT ORDER (Triggers Email to Mom)
app.post('/orders', (req, res) => {
    const { customer_name, phone_number, quantity } = req.body;

    if (!customer_name || !phone_number || typeof quantity !== 'number' || quantity <= 0) {
        return res.status(400).json({ error: 'Invalid input data' });
    }

    db.run(
        `INSERT INTO orders (customer_name, phone_number, quantity) VALUES (?, ?, ?)`,
        [customer_name, phone_number, quantity],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });

            const orderId = this.lastID;

            // Send automated email to Mom
            if (EMAIL_USER && MOM_EMAIL) {
                const mailOptions = {
                    from: EMAIL_USER,
                    to: MOM_EMAIL,
                    subject: `🚨 NEW BIRYANI ORDER (#${orderId})`,
                    html: `
                        <h2>New Order Received!</h2>
                        <p><strong>Customer:</strong> ${customer_name}</p>
                        <p><strong>Phone:</strong> ${phone_number}</p>
                        <p><strong>Quantity:</strong> <span style="font-size: 24px; color: #d97706;">${quantity} Plates</span></p>
                        <p><strong>Expected Revenue:</strong> ₹${quantity * 150}</p>
                    `
                };
                transporter.sendMail(mailOptions).catch(console.error);
            }

            res.json({ id: orderId, customer_name, phone_number, quantity });
        }
    );
});

// 5. GET ALL ORDERS (Protected Route)
app.get('/orders', verifyAdminToken, (req, res) => {
    db.all('SELECT * FROM orders ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 6. UPDATE ORDER STATUS (Protected Route)
app.put('/orders/:id/status', verifyAdminToken, (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    db.run(`UPDATE orders SET status = ? WHERE id = ?`, [status, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Status updated' });
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on port ${port}`);
});